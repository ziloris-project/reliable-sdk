// sessionStorage wrapper. Everything is try/catch wrapped because Safari
// private mode, in-app browsers, and strict CSPs can all throw synchronously
// on access. Storage being unavailable is degraded — not fatal.

const STORAGE_KEY = 'reliable:session';

export function readRawSession(): unknown {
    try {
        if (typeof sessionStorage === 'undefined') return null;
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}

export function writeRawSession(state: unknown): void {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Quota exceeded, private mode, disabled — quietly give up. We'll
        // keep an in-memory copy; it just won't survive a refresh.
    }
}

export function clearRawSession(): void {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}
