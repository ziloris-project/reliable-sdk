// SessionManager: the anchor every event hangs off. See FEATURES.md §0.2.
//
// A session is one visit: every tab of the same browser shares it, and it
// ends after 30 minutes without user activity.
//
// Contract:
//   - On construction, hydrates from storage if a valid, non-idle session
//     exists (adopting one left in sessionStorage by an older SDK). Otherwise
//     creates a new one: loading a page is activity.
//   - `current()` returns the session without ever rotating or extending it.
//     Background events (network, errors, WebSockets, vitals) use it, so a
//     tab left open cannot keep a visit alive forever, and cannot start a new
//     "visit" every 30 minutes just because a poll or an error fired.
//   - `touch()` is for user activity. It rotates to a new session when the
//     current one has gone idle, and otherwise extends it.
//   - `rotate()` is explicit: identify-change or on demand.
//   - Consumers subscribe via `onRotate` to fire `/sessions` events.
//   - Tabs stay in sync through storage: whichever tab rotates first, the
//     others pick the new session up on their next read.

import type { ResolvedConfig } from '../config';
import { rollSample } from '../sampling';
import { now } from '../util/now';
import { uuid } from '../util/uuid';
import { clearRawSession, readRawSession, takeLegacySession, writeRawSession } from './storage';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Activity is recorded at most this often; the idle timeout is 30 minutes, so
 *  finer resolution buys nothing and would write storage on every keystroke. */
const TOUCH_WRITE_INTERVAL_MS = 5_000;

export type RotateReason = 'idle' | 'identify_change' | 'explicit';

export interface SessionState {
    uuid: string;
    started_at: number;
    last_active_at: number;
    /** Result of the per-session sample roll. `false` = dark mode. */
    sampled: boolean;
    /** External ID from `identify()`, or null if anonymous. */
    user_external_id: string | null;
}

export interface SessionManager {
    /** The session to attach an event to. Never rotates or extends it. */
    current(): SessionState;
    /** Record user activity: rotates if the session went idle, else extends it. */
    touch(): void;
    rotate(reason: RotateReason): SessionState;
    attachUser(externalId: string): { rotated: boolean; state: SessionState };
    /** The backend sampled this session out: stop sending for the rest of it. */
    markSampledOut(uuid: string): void;
    isFresh(): boolean;
    onRotate(cb: (state: SessionState, reason: RotateReason) => void): () => void;
}

export interface SessionManagerDeps {
    config: ResolvedConfig;
}

export function createSessionManager({ config }: SessionManagerDeps): SessionManager {
    const rotateListeners = new Set<(state: SessionState, reason: RotateReason) => void>();

    const hydrated = tryHydrate();
    let state: SessionState = hydrated ?? createFresh();
    let fresh = hydrated === null;
    let lastWriteAt = now();

    function tryHydrate(): SessionState | null {
        const stored = readRawSession();
        let candidate: SessionState | null = isValidState(stored) ? stored : null;
        if (!candidate) {
            const legacy = takeLegacySession();
            candidate = isValidState(legacy) ? legacy : null;
        }
        if (!candidate || isIdleExpired(candidate)) return null;
        writeRawSession(candidate);
        return candidate;
    }

    function createFresh(): SessionState {
        const t = now();
        const s: SessionState = {
            uuid: uuid(),
            started_at: t,
            last_active_at: t,
            sampled: rollSample(config.sampleRate),
            user_external_id: null,
        };
        writeRawSession(s);
        return s;
    }

    /** Adopt a session another tab started or extended since our last read. */
    function sync(): void {
        const stored = readRawSession();
        if (!isValidState(stored)) {
            // Storage cleared or unavailable: keep ours and put it back.
            writeRawSession(state);
            return;
        }
        if (stored.uuid !== state.uuid) {
            // Another tab rotated. Its session wins if it is the newer one.
            if (stored.started_at >= state.started_at) state = stored;
            else writeRawSession(state);
            return;
        }
        if (stored.last_active_at > state.last_active_at) {
            state.last_active_at = stored.last_active_at;
        }
        if (stored.user_external_id !== state.user_external_id && stored.user_external_id !== null) {
            state.user_external_id = stored.user_external_id;
        }
    }

    function emitRotate(next: SessionState, reason: RotateReason): void {
        for (const cb of rotateListeners) {
            try {
                cb(next, reason);
            } catch {
                // Listener errors can't be allowed to poison session state.
            }
        }
    }

    function rotate(reason: RotateReason): SessionState {
        clearRawSession();
        state = createFresh();
        lastWriteAt = now();
        fresh = true;
        emitRotate(state, reason);
        return state;
    }

    function current(): SessionState {
        sync();
        return state;
    }

    function touch(): void {
        sync();
        if (isIdleExpired(state)) {
            rotate('idle');
            return;
        }
        const t = now();
        state.last_active_at = t;
        if (t - lastWriteAt >= TOUCH_WRITE_INTERVAL_MS) {
            writeRawSession(state);
            lastWriteAt = t;
        }
    }

    function attachUser(externalId: string): { rotated: boolean; state: SessionState } {
        sync();
        let rotated = false;
        if (state.user_external_id && state.user_external_id !== externalId) {
            rotate('identify_change');
            rotated = true;
        }
        state.user_external_id = externalId;
        writeRawSession(state);
        lastWriteAt = now();
        return { rotated, state };
    }

    function markSampledOut(uuid: string): void {
        sync();
        if (state.uuid !== uuid || !state.sampled) return;
        state.sampled = false;
        writeRawSession(state);
        lastWriteAt = now();
    }

    return {
        current,
        touch,
        rotate,
        attachUser,
        markSampledOut,
        isFresh: () => fresh,
        onRotate(cb) {
            rotateListeners.add(cb);
            return () => rotateListeners.delete(cb);
        },
    };
}

function isValidState(v: unknown): v is SessionState {
    if (!v || typeof v !== 'object') return false;
    const s = v as Partial<SessionState>;
    return (
        typeof s.uuid === 'string' &&
        typeof s.started_at === 'number' &&
        typeof s.last_active_at === 'number' &&
        typeof s.sampled === 'boolean' &&
        (s.user_external_id === null || typeof s.user_external_id === 'string')
    );
}

function isIdleExpired(s: SessionState): boolean {
    return now() - s.last_active_at > IDLE_TIMEOUT_MS;
}
