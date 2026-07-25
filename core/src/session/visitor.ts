// Anonymous visitor id — a stable, random, first-party identifier for a
// *browser*, persisted in localStorage so it survives tab closes and repeat
// visits. This is what makes "unique users" and "returning" real: the session
// lives in sessionStorage (per-tab, wiped on close), so without this every tab
// and every revisit looked like a brand-new person.
//
// It is anonymous: a random UUID, no personal data, first-party only (never
// shared cross-site). It is NOT the identify() user id — when a visitor logs
// in, user_external_id carries that separately; the two coexist.

import { uuid } from '../util/uuid';

const VISITOR_KEY = 'reliable:visitor';

// In-memory fallback for environments where localStorage throws (Safari
// private mode, strict CSP, disabled storage). Stable for the page's lifetime
// so at least intra-page correlation holds; it just won't persist.
let memoryFallback: string | null = null;

/** The persistent anonymous visitor id, minting one on first use. */
export function getVisitorId(): string {
    try {
        if (typeof localStorage !== 'undefined') {
            const existing = localStorage.getItem(VISITOR_KEY);
            if (existing && existing.length > 0) return existing;
            const fresh = uuid();
            localStorage.setItem(VISITOR_KEY, fresh);
            return fresh;
        }
    } catch {
        // fall through to memory
    }
    if (memoryFallback === null) memoryFallback = uuid();
    return memoryFallback;
}
