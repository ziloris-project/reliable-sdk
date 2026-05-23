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
import { nowIso } from './util/now';
import { uuid } from './util/uuid';

export interface InternalClient extends ReliableClient {
    /** Context handed to feature modules by init(). Not part of the public API. */
    readonly context: SdkContext;
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
        session.touch();
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
    // (ON CONFLICT DO UPDATE) so firing on every init — even when the session
    // was rehydrated from sessionStorage — is harmless and guarantees child
    // events can always resolve their session_uuid.
    function sendSessionStart(state: SessionState): void {
        const vp = typeof window !== 'undefined'
            ? { width: window.innerWidth, height: window.innerHeight }
            : null;

        capture('/sessions', {
            uuid: state.uuid,
            session_uuid: state.uuid,
            started_at: new Date(state.started_at).toISOString(),
            user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            sdk_version: '0.0.0',
            viewport_width: vp?.width ?? null,
            viewport_height: vp?.height ?? null,
            initial_referrer: typeof document !== 'undefined' ? document.referrer || null : null,
            initial_path:
                typeof location !== 'undefined' ? location.pathname + location.search : null,
        });
    }

    // Always fire on init (not gated by isFresh), plus on every rotation.
    sendSessionStart(session.current());
    session.onRotate((state, reason) => {
        logger.debug('session rotated', reason, state.uuid);
        sendSessionStart(state);
    });

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
