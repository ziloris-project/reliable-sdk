// Navigation tracking — route changes, page views, history instrumentation.
//
// Captures five kinds of navigation:
//   initial  — the first page load (or reload)
//   push     — history.pushState (SPA navigation)
//   replace  — history.replaceState (SPA redirect)
//   pop      — browser back/forward button
//   reload   — detected via Performance Navigation Timing API
//
// The module monkey-patches history.pushState and history.replaceState,
// and listens for popstate. It restores originals on teardown.

import type { SdkContext } from '../context';
import { uuid } from '../util/uuid';
import { nowIso } from '../util/now';

type NavKind = 'initial' | 'push' | 'replace' | 'pop' | 'reload';

let teardown: (() => void) | null = null;

/** Current path, tracked so every module can read it without querying location. */
let _currentPath: string = '';

/** Read the current tracked path. Other modules (vitals, errors, network, clicks) use this. */
export function getCurrentPath(): string {
    return _currentPath;
}

// ── router history ring ─────────────────────────────────────────────────
// Small ring buffer of the last 10 navigation events. Errors module reads
// this when emitting an event so the dashboard can show the user's journey
// leading up to the error. Each entry is { path, time (ISO) }.

export interface RouterHistoryEntry {
    path: string;
    time: string;
}
const ROUTER_HISTORY_MAX = 10;
const _routerHistory: RouterHistoryEntry[] = [];

export function getRouterHistory(): readonly RouterHistoryEntry[] {
    return _routerHistory;
}

function pushRouterHistory(path: string): void {
    _routerHistory.push({ path, time: new Date().toISOString() });
    if (_routerHistory.length > ROUTER_HISTORY_MAX) _routerHistory.shift();
}

export function initNavigation(ctx: SdkContext): void {
    if (teardown) return; // already wired
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const { capture, logger } = ctx;

    // ── helpers ──────────────────────────────────────────────────────────

    function emitNav(kind: NavKind, fromPath: string | null, toPath: string): void {
        _currentPath = toPath;
        pushRouterHistory(toPath);
        logger.debug('nav', kind, fromPath, '→', toPath);
        capture('/navigation', {
            uuid: uuid(),
            kind,
            from_path: fromPath,
            to_path: toPath,
            referrer: kind === 'initial' ? (document.referrer || null) : null,
            occurred_at: nowIso(),
        });
    }

    function currentPathname(): string {
        return location.pathname + location.search;
    }

    // ── initial navigation ──────────────────────────────────────────────

    const initialPath = currentPathname();
    const isReload = detectReload();
    emitNav(isReload ? 'reload' : 'initial', null, initialPath);

    // ── history monkey-patches ──────────────────────────────────────────

    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = function patchedPush(
        data: unknown, unused: string, url?: string | URL | null,
    ) {
        const from = currentPathname();
        origPush(data, unused, url);
        const to = currentPathname();
        if (to !== from) emitNav('push', from, to);
    };

    history.replaceState = function patchedReplace(
        data: unknown, unused: string, url?: string | URL | null,
    ) {
        const from = currentPathname();
        origReplace(data, unused, url);
        const to = currentPathname();
        if (to !== from) emitNav('replace', from, to);
    };

    // ── popstate (back / forward) ───────────────────────────────────────

    function onPopState(): void {
        const to = currentPathname();
        if (to !== _currentPath) {
            emitNav('pop', _currentPath, to);
        }
    }

    window.addEventListener('popstate', onPopState);

    // ── teardown ────────────────────────────────────────────────────────

    teardown = () => {
        history.pushState    = origPush;
        history.replaceState = origReplace;
        window.removeEventListener('popstate', onPopState);
        teardown = null;
    };
}

export function destroyNavigation(): void {
    teardown?.();
}

// ── private ─────────────────────────────────────────────────────────────

function detectReload(): boolean {
    try {
        const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        return entries.length > 0 && entries[0]!.type === 'reload';
    } catch {
        return false;
    }
}
