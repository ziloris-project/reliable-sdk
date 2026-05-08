// SessionManager — the anchor every event hangs off. See FEATURES.md §0.2.
//
// Contract:
//   - On construction, hydrates from sessionStorage if a valid, non-idle
//     session exists. Refreshes preserve the session uuid.
//   - If no valid stored session, creates a new one synchronously.
//   - `current()` checks for idle expiry (30 min) on every call and rotates
//     if needed. `touch()` bumps last_active_at and persists.
//   - `rotate()` is explicit — called on identify-change or on demand.
//   - Consumers subscribe via `onRotate` to fire `/sessions` events.
//   - `isFresh()` tells the client whether the *initial* session was new
//     (needs a `/sessions` event on boot) or rehydrated from storage.

import type { ResolvedConfig } from '../config';
import { rollSample } from '../sampling';
import { now } from '../util/now';
import { uuid } from '../util/uuid';
import { clearRawSession, readRawSession, writeRawSession } from './storage';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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
    current(): SessionState;
    touch(): void;
    rotate(reason: RotateReason): SessionState;
    attachUser(externalId: string): { rotated: boolean; state: SessionState };
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

    function tryHydrate(): SessionState | null {
        const raw = readRawSession();
        if (!isValidState(raw)) return null;
        if (isIdleExpired(raw)) return null;
        return raw;
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
        fresh = true;
        emitRotate(state, reason);
        return state;
    }

    function current(): SessionState {
        if (isIdleExpired(state)) return rotate('idle');
        return state;
    }

    function touch(): void {
        if (isIdleExpired(state)) {
            rotate('idle');
            return;
        }
        state.last_active_at = now();
        writeRawSession(state);
    }

    function attachUser(externalId: string): { rotated: boolean; state: SessionState } {
        if (state.user_external_id && state.user_external_id !== externalId) {
            rotate('identify_change');
        }
        state.user_external_id = externalId;
        writeRawSession(state);
        return { rotated: false, state };
    }

    return {
        current,
        touch,
        rotate,
        attachUser,
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
