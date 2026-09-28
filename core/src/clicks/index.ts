// Click capture: dead clicks and rage clicks.
//
// Only elements whose job is to act when clicked are judged: links, buttons
// and elements with a button, link, menu item or tab role. Up to 1.4.x any
// interactive element counted, so clicking into a text field, checkbox or
// select (which focuses it without changing the DOM) was a "dead click";
// about half of all dead clicks in production were fields and iframes.
//
// A click, or a burst of rapid clicks on the same element, is dead when
// nothing responds within RESPONSE_WINDOW_MS of the last click: no DOM change
// anywhere in the document, no URL change, no scroll, no focus moving to
// another element or window, and no network request starting. Up to 1.4.x
// only the clicked element's parent was watched, so a link that re-rendered
// the page elsewhere, or a button that opened a modal at the root, was
// wrongly dead.
//
// A burst of RAGE_THRESHOLD or more dead clicks on the same element is one
// rage click (reported instead of the individual dead clicks). Rapid clicks
// that do get a response are never reported: triple-clicking text to select
// it, or pressing a working +/- stepper quickly, is not rage.
//
// Only dead and rage clicks are reported; normal clicks are not sent.

import type { SdkContext } from '../context';
import { networkStartedSince } from '../activity';
import { getCurrentPath } from '../navigation';
import { triggerReplayFlush } from '../replay';
import { uuid } from '../util/uuid';
import { nowIso } from '../util/now';

const RESPONSE_WINDOW_MS = 1_000;
/** Clicks on the same element this close together belong to one burst. */
const BURST_GAP_MS = 1_000;
const RAGE_THRESHOLD = 3;

const ACTION_SELECTOR = [
    'a[href]',
    'button',
    'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', 'input[type="image"]',
    'summary',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
].join(', ');

interface Burst {
    el: Element;
    selector: string;
    count: number;
    firstAt: number;      // performance.now() of the first click
    lastAt: number;
    href: string;         // location.href at the first click
    focused: Element | null;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout> | null;
}

let teardown: (() => void) | null = null;

export function initClicks(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const { capture, logger } = ctx;
    const bursts = new Map<Element, Burst>();

    // ── response signals (only watched while a burst is pending) ────────
    let lastMutationAt = Number.NEGATIVE_INFINITY;
    let lastScrollAt = Number.NEGATIVE_INFINITY;
    let lastBlurAt = Number.NEGATIVE_INFINITY;
    let observing = false;
    const observer = typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => { lastMutationAt = performance.now(); })
        : null;
    const onScroll = (): void => { lastScrollAt = performance.now(); };
    const onBlur = (): void => { lastBlurAt = performance.now(); };

    function startWatching(): void {
        if (observing) return;
        observing = true;
        observer?.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, characterData: true,
        });
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('blur', onBlur);
    }

    function stopWatching(): void {
        if (!observing) return;
        observing = false;
        observer?.disconnect();
        window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
        window.removeEventListener('blur', onBlur);
    }

    function responded(b: Burst): boolean {
        if (lastMutationAt >= b.firstAt) return true;
        if (lastScrollAt >= b.firstAt) return true;
        if (lastBlurAt >= b.firstAt) return true;
        if (networkStartedSince(b.firstAt)) return true;
        if (resourceStartedSince(b.firstAt)) return true;
        if (location.href !== b.href) return true;
        const active = document.activeElement;
        if (active && active !== b.focused && active !== b.el && active !== document.body && !b.el.contains(active)) {
            return true;
        }
        return false;
    }

    function sendClick(kind: 'dead' | 'rage', b: Burst, rageCount?: number): void {
        const path = getCurrentPath() || location.pathname;
        const eventUuid = uuid();

        capture('/clicks', {
            uuid: eventUuid,
            kind,
            element_selector: b.selector,
            element_text: truncate(b.el.textContent?.trim() ?? '', 80),
            element_tag: b.el.tagName.toLowerCase(),
            rage_click_count: rageCount ?? null,
            coordinate_x: Math.round(b.x),
            coordinate_y: Math.round(b.y),
            path,
            occurred_at: nowIso(),
        });

        triggerReplayFlush(ctx, eventUuid);
        logger.debug('click', kind, b.selector);
    }

    function evaluate(b: Burst): void {
        b.timer = null;
        bursts.delete(b.el);
        const dead = !responded(b);
        if (bursts.size === 0) stopWatching();
        if (!dead) return;

        if (b.count >= RAGE_THRESHOLD) {
            sendClick('rage', b, b.count);
        } else {
            for (let i = 0; i < b.count; i++) sendClick('dead', b);
        }
    }

    // ── main listener ───────────────────────────────────────────────────

    function onClick(event: MouseEvent): void {
        // Primary button only, and no modifier: ctrl/cmd/shift/alt clicks open
        // new tabs or windows, or download, which never change this page.
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

        const target = event.target as Element | null;
        const el = target?.closest?.(ACTION_SELECTOR) ?? null;
        if (!el || opensElsewhere(el)) return;

        const t = performance.now();
        let b = bursts.get(el);
        if (b && t - b.lastAt <= BURST_GAP_MS) {
            b.count++;
            b.lastAt = t;
            b.x = event.clientX;
            b.y = event.clientY;
            if (b.timer) clearTimeout(b.timer);
        } else {
            b = {
                el,
                selector: compactSelector(el),
                count: 1,
                firstAt: t,
                lastAt: t,
                href: location.href,
                focused: document.activeElement,
                x: event.clientX,
                y: event.clientY,
                timer: null,
            };
            bursts.set(el, b);
        }

        startWatching();
        const burst = b;
        burst.timer = setTimeout(() => evaluate(burst), RESPONSE_WINDOW_MS);
    }

    // Leaving the page is a response: drop whatever is still pending.
    function onPageHide(): void {
        for (const b of bursts.values()) if (b.timer) clearTimeout(b.timer);
        bursts.clear();
        stopWatching();
    }

    document.addEventListener('click', onClick, true);
    window.addEventListener('pagehide', onPageHide);

    teardown = () => {
        document.removeEventListener('click', onClick, true);
        window.removeEventListener('pagehide', onPageHide);
        onPageHide();
        teardown = null;
    };

    logger.debug('click instrumentation installed');
}

export function destroyClicks(): void {
    teardown?.();
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Links that by design do not change this page: new tab, download, mail/phone apps. */
function opensElsewhere(el: Element): boolean {
    if (el.tagName !== 'A') return false;
    const a = el as HTMLAnchorElement;
    if (a.hasAttribute('download')) return true;
    const target = (a.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self' && target !== '_top' && target !== '_parent') return true;
    return /^(mailto|tel|sms):/i.test(a.getAttribute('href') || '');
}

/** Fallback for when network capture is off: a completed resource entry that
 *  started after the click (fetch, XHR, image) is a response too. */
function resourceStartedSince(perfTime: number): boolean {
    try {
        const entries = performance.getEntriesByType('resource');
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i]!;
            if (e.startTime >= perfTime) return true;
            if (e.startTime < perfTime - 60_000) break;
        }
    } catch {
        // Resource timing unavailable.
    }
    return false;
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
