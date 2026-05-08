// Click capture — dead clicks and rage clicks.
//
// A single document-level click listener in capture phase sees every click
// before framework handlers. Two heuristics run on top:
//
//   Rage click  — 3+ clicks on the same selector within 1000ms.
//   Dead click  — click on an interactive element with no DOM mutation,
//                 navigation, or fetch within 300ms.
//
// Only dead and rage clicks are reported — normal clicks are not sent.

import type { SdkContext } from '../context';
import { getCurrentPath } from '../navigation';
import { triggerReplayFlush } from '../replay';
import { uuid } from '../util/uuid';
import { nowIso } from '../util/now';

let teardown: (() => void) | null = null;

// ── rage detection state ────────────────────────────────────────────────
interface ClickRecord {
    selector: string;
    time: number;
}

const RAGE_WINDOW_MS = 1_000;
const RAGE_THRESHOLD = 3;
const DEAD_WAIT_MS = 300;

// Interactive elements that can be "dead clicked".
const INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY',
]);

function isInteractive(el: Element): boolean {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.hasAttribute('onclick')) return true;
    if ((el as HTMLElement).tabIndex >= 0 && el.tagName !== 'BODY') return true;
    return false;
}

export function initClicks(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const { capture, logger } = ctx;
    const recentClicks: ClickRecord[] = [];
    const rageCooldowns = new Map<string, number>();
    const RAGE_COOLDOWN_MS = 3_000;

    function sendClick(
        kind: 'dead' | 'rage',
        target: Element,
        selector: string,
        x: number,
        y: number,
        rageCount?: number,
    ): void {
        const path = getCurrentPath() || location.pathname;
        const eventUuid = uuid();

        capture('/clicks', {
            uuid: eventUuid,
            kind,
            element_selector: selector,
            element_text: truncate(target.textContent?.trim() ?? '', 80),
            element_tag: target.tagName.toLowerCase(),
            rage_click_count: rageCount ?? null,
            coordinate_x: Math.round(x),
            coordinate_y: Math.round(y),
            path,
            occurred_at: nowIso(),
        });

        triggerReplayFlush(ctx, eventUuid);
        logger.debug('click', kind, selector);
    }

    // ── main listener ───────────────────────────────────────────────────

    function onClick(event: MouseEvent): void {
        const target = event.target as Element | null;
        if (!target) return;

        const selector = compactSelector(target);
        const now = Date.now();
        const x = event.clientX;
        const y = event.clientY;

        // ── rage detection ──────────────────────────────────────────────
        recentClicks.push({ selector, time: now });
        // Prune old entries.
        while (recentClicks.length > 0 && now - recentClicks[0]!.time > RAGE_WINDOW_MS) {
            recentClicks.shift();
        }
        const sameCount = recentClicks.filter((c) => c.selector === selector).length;
        if (sameCount >= RAGE_THRESHOLD) {
            const lastRage = rageCooldowns.get(selector);
            if (!lastRage || now - lastRage > RAGE_COOLDOWN_MS) {
                sendClick('rage', target, selector, x, y, sameCount);
                rageCooldowns.set(selector, now);
            }
            recentClicks.length = 0;
            return;
        }

        // ── dead click detection ────────────────────────────────────────
        // Only check interactive elements.
        const interactive = findInteractive(target);
        if (!interactive) return;

        let alive = false;

        // Watch for DOM mutations near the target.
        const observer = new MutationObserver(() => { alive = true; });
        const observeRoot = interactive.parentElement ?? document.body;
        observer.observe(observeRoot, {
            childList: true,
            subtree: true,
            attributes: true,
        });

        // Watch for fetch/XHR starting (sign of life).
        const origFetch = window.fetch;
        // Use a one-shot flag — we just want to know if ANY fetch starts.
        const fetchGuard = (...args: Parameters<typeof fetch>): Promise<Response> => {
            alive = true;
            window.fetch = origFetch;
            return origFetch.apply(window, args);
        };
        window.fetch = fetchGuard;

        setTimeout(() => {
            observer.disconnect();
            if (window.fetch === fetchGuard) window.fetch = origFetch;

            if (!alive) {
                sendClick('dead', interactive, compactSelector(interactive), x, y);
            }
        }, DEAD_WAIT_MS);
    }

    document.addEventListener('click', onClick, true);

    teardown = () => {
        document.removeEventListener('click', onClick, true);
        teardown = null;
    };

    logger.debug('click instrumentation installed');
}

export function destroyClicks(): void {
    teardown?.();
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Walk up to find the nearest interactive ancestor (or self). */
function findInteractive(el: Element): Element | null {
    let cur: Element | null = el;
    for (let i = 0; i < 5 && cur; i++) {
        if (isInteractive(cur)) return cur;
        cur = cur.parentElement;
    }
    return null;
}

/**
 * Build a compact CSS selector: tag#id or tag.class1.class2, walking up
 * max 3 ancestors. Capped at 200 chars.
 */
function compactSelector(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;

    for (let i = 0; i < 4 && cur && cur !== document.documentElement; i++) {
        const tag = cur.tagName.toLowerCase();
        if (cur.id) {
            parts.unshift(`${tag}#${cur.id}`);
            break; // ID is unique — no need to go higher.
        }
        const cls = Array.from(cur.classList).slice(0, 3).join('.');
        parts.unshift(cls ? `${tag}.${cls}` : tag);
        cur = cur.parentElement;
    }

    const selector = parts.join(' > ');
    return selector.length > 200 ? selector.slice(0, 200) : selector;
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + '...' : s;
}
