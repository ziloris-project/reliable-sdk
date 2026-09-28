// Session storage wrapper. Everything is try/catch wrapped because Safari
// private mode, in-app browsers, and strict CSPs can all throw synchronously
// on access. Storage being unavailable is degraded, not fatal.
//
// The session lives in localStorage so every tab of the same browser shares
// one visit, the way analytics tools define a visit: it ends after 30 minutes
// without activity, not when a tab closes. Up to 1.4.x it lived in
// sessionStorage, which is per tab, so opening a link in a new tab started a
// second "visit" and the same person counted twice.

const STORAGE_KEY = 'reliable:session';

export function readRawSession(): unknown {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}

export function writeRawSession(state: unknown): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Quota exceeded, private mode, disabled: quietly give up. We keep an
        // in-memory copy; it just won't be shared or survive a refresh.
    }
}

export function clearRawSession(): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

/**
 * A session left in sessionStorage by an older SDK, removed as it is read.
 * Adopting it on upgrade keeps a tab that was mid-visit on the same session
 * instead of splitting the visit in two.
 */
export function takeLegacySession(): unknown {
    try {
        if (typeof sessionStorage === 'undefined') return null;
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(STORAGE_KEY);
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}
