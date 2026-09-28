// createClient wires every foundation piece together and exposes the public
// API. Feature modules are NOT initialized here — that happens in `init()`
// in index.ts, which this file stays ignorant of. This separation means the
// client has zero knowledge of which features exist; it just provides the
// SdkContext they all share.

import { createBreadcrumbRing } from './breadcrumbs';
import { resolveConfig } from './config';
import type { SdkContext } from './context';
import { createScope } from './scope';
import { createSessionManager, type SessionState } from './session';
import { getVisitorId } from './session/visitor';
import { createTransport } from './transport';
import type { ReliableClient, ReliableConfig, UserIdentity } from './types';
import { initClicks } from './clicks';
import { initConsole } from './console';
import { captureException, captureMessage, initErrors } from './errors';
import { initNavigation } from './navigation';
import { initNetwork } from './network';
import { initVitals } from './vitals';
import { initReplay } from './replay';
import { initWebSocket } from './websocket';
import { createLogger } from './util/log';
import { isLikelyBot } from './util/bot';
import { scrubPath } from './scrub';
import { SDK_VERSION } from './version';
import { nowIso } from './util/now';
import { uuid } from './util/uuid';

export interface InternalClient extends ReliableClient {
    /** Context handed to feature modules by init(). Not part of the public API. */
    readonly context: SdkContext;
}

// Events that mean a person is using the page. Only these extend the session
// or start a new one after it has gone idle. Everything else (network,
// WebSocket, errors, vitals) attaches to the current session as it is: a tab
// left open with background polling must neither keep one visit alive all
// day nor open a fresh "visit" every 30 minutes with nobody there.
const ACTIVITY_PATHS = new Set(['/sessions', '/navigation', '/clicks', '/events', '/identify']);

/** DOM events that count as the visitor being active. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
const ACTIVITY_THROTTLE_MS = 10_000;

/** document.referrer, but only when it is another site. A same-site referrer
 *  is this site linking to itself (typically a link opened in a new tab), not
 *  where the visit came from. */
/** Loopback and localhost pages are a developer running the app, not a
 *  visitor. Private network addresses are left alone: intranet apps serve
 *  real users from them. */
function isLocalDevHost(): boolean {
    if (typeof location === 'undefined') return false;
    if (location.protocol === 'file:') return true;
    const h = location.hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost')
        || h === '::1' || h === '[::1]' || h === '0.0.0.0'
        || /^127\./.test(h);
}

function externalReferrer(): string | null {
    if (typeof document === 'undefined' || !document.referrer) return null;
    try {
        const ref = new URL(document.referrer);
        if (typeof location !== 'undefined' && ref.host === location.host) return null;
        return scrubPath(document.referrer);
    } catch {
        return null;
    }
}

export function createClient(userConfig: ReliableConfig): InternalClient {
    const config = resolveConfig(userConfig);
    const logger = createLogger(config.debug);
    const scope = createScope();
    const breadcrumbs = createBreadcrumbRing();
    const session = createSessionManager({ config });

    const transport = createTransport({
        config,
        logger,
        isSampled: () => session.current().sampled,
    });
    transport.attachLifecycle();

    // Enrichment helper. Every outbound event goes through this so session
    // touching, uuid/occurred_at defaults, and sanity checks live in ONE spot.
    function capture(path: string, payload: Record<string, unknown>): void {
        if (ACTIVITY_PATHS.has(path)) session.touch();
        const s = session.current();
        const enriched: Record<string, unknown> = {
            uuid: payload['uuid'] ?? uuid(),
            session_uuid: payload['session_uuid'] ?? s.uuid,
            occurred_at: payload['occurred_at'] ?? nowIso(),
            // Release is null when integrators haven't configured it yet —
            // backend treats null as "no sourcemap available, leave stack as-is".
            release: payload['release'] ?? config.release,
            ...payload,
        };
        transport.enqueue({ path, payload: enriched });
    }

    // Ensure the session row exists in the backend. The upsert is idempotent
    // (ON CONFLICT DO UPDATE) so firing on every page load, even when the
    // session was rehydrated from storage, is harmless and guarantees child
    // events can always resolve their session_uuid. The backend keeps the
    // first values it saw for the "initial" fields.
    //
    // `pageLoad` is false when a session starts mid-page (idle rotation or an
    // identify change): the visit did not arrive from document.referrer then.
    function sendSessionStart(state: SessionState, pageLoad: boolean): void {
        const vp = typeof window !== 'undefined'
            ? { width: window.innerWidth, height: window.innerHeight }
            : null;

        capture('/sessions', {
            uuid: state.uuid,
            session_uuid: state.uuid,
            // Persistent anonymous visitor id (localStorage) — stable across
            // tabs and revisits, so the backend can count real unique visitors
            // and returning cohorts instead of per-tab sessions.
            anonymous_id: getVisitorId(),
            started_at: new Date(state.started_at).toISOString(),
            user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            sdk_version: SDK_VERSION,
            is_bot: isLikelyBot(),
            viewport_width: vp?.width ?? null,
            viewport_height: vp?.height ?? null,
            initial_referrer: pageLoad ? externalReferrer() : null,
            initial_path:
                typeof location !== 'undefined' ? scrubPath(location.pathname + location.search) : null,
            // Sessions from a developer's machine are marked so a production
            // project can leave them out of its business metrics.
            ...(isLocalDevHost() ? { environment: 'development' } : {}),
        });
    }

    // Always fire on init (not gated by isFresh), plus on every rotation.
    sendSessionStart(session.current(), true);
    session.onRotate((state, reason) => {
        logger.debug('session rotated', reason, state.uuid);
        sendSessionStart(state, false);
    });

    // Real interaction keeps the visit alive (and starts a new one after an
    // idle gap). Passive and throttled: at most one touch per 10 seconds.
    if (typeof window !== 'undefined') {
        let lastActivityAt = 0;
        const onActivity = (): void => {
            const t = Date.now();
            if (t - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
            lastActivityAt = t;
            session.touch();
        };
        for (const type of ACTIVITY_EVENTS) {
            window.addEventListener(type, onActivity, { capture: true, passive: true });
        }
    }

    const context: SdkContext = {
        config,
        logger,
        scope,
        breadcrumbs,
        session,
        transport,
        capture,
    };

    // ── Feature modules ───────────────────────────────────────────────────
    // Navigation goes first — it exposes getCurrentPath() that vitals,
    // errors, network, and clicks all read.
    if (config.captureNavigation) {
        initNavigation(context);
    }
    if (config.captureVitals) {
        initVitals(context);
    }
    // Always init errors so captureException()/captureMessage() work even
    // when auto-capture is off. The captureErrors flag only gates the
    // window 'error' / 'unhandledrejection' listeners (handled inside).
    initErrors(context);
    // Console capture must run AFTER initErrors — it uses captureMessage.
    if (config.captureConsole) {
        initConsole(context);
    }
    if (config.captureNetwork) {
        initNetwork(context);
    }
    if (config.captureWebSockets) {
        initWebSocket(context);
    }
    if (config.captureClicks) {
        initClicks(context);
    }
    if (config.captureReplay) {
        initReplay(context);
    }

    const client: InternalClient = {
        context,
        identify(user: UserIdentity) {
            if (!user || typeof user.externalId !== 'string' || user.externalId.length === 0) {
                logger.warn('identify() requires an externalId');
                return;
            }
            scope.setUser(user);
            session.attachUser(user.externalId);
            capture('/identify', {
                uuid: uuid(),
                external_id: user.externalId,
                email: user.email ?? null,
                name: user.name ?? null,
                traits: user.traits ?? {},
            });
        },
        setTag(key, value) {
            scope.setTag(key, value);
        },
        setTags(tags) {
            scope.setTags(tags);
        },
        addBreadcrumb(crumb) {
            breadcrumbs.add(crumb);
        },
        flush() {
            return transport.flush();
        },
        track(eventName: string, properties?: Record<string, unknown>) {
            capture('/events', {
                uuid: uuid(),
                event_name: eventName,
                properties: properties ?? {},
            });
        },
        captureException(error, options) {
            return captureException(error, options);
        },
        captureMessage(message, options) {
            return captureMessage(message, options);
        },
    };

    logger.debug('client ready', { endpoint: config.endpoint, sampleRate: config.sampleRate });
    return client;
}
