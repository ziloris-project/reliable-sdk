// Core Web Vitals — LCP, CLS, INP, FCP, TTFB.
//
// Uses Google's `web-vitals` library's attribution build, which exposes
// diagnostic fields (element selectors, resource timings, interaction
// targets) alongside each metric. We forward a compact subset to the
// backend via the `attribution` JSONB column so the dashboard can render
// breakdowns.
//
// Fields kept per metric:
//   • LCP : elementTag, elementSelector, url, resourceLoadDelay,
//           resourceLoadDuration, elementRenderDelay, timeToFirstByte
//   • CLS : largestShiftTarget, largestShiftValue, largestShiftTime,
//           loadState, sources (up to 5 {target, value})
//   • INP : interactionTarget, interactionType ('pointer'|'keyboard'),
//           inputDelay, processingDuration, presentationDelay, loadState
//   • FCP : loadState, timeToFirstByte
//   • TTFB: waitingDuration, dnsDuration, connectionDuration, requestDuration

import { onLCP, onCLS, onINP, onFCP, onTTFB } from 'web-vitals/attribution';
import type {
    LCPMetricWithAttribution,
    CLSMetricWithAttribution,
    INPMetricWithAttribution,
    FCPMetricWithAttribution,
    TTFBMetricWithAttribution,
} from 'web-vitals';
import type { SdkContext } from '../context';
import { getCurrentPath } from '../navigation';
import { uuid } from '../util/uuid';
import { nowIso } from '../util/now';

type MetricName = 'lcp' | 'cls' | 'inp' | 'fcp' | 'ttfb';

export function initVitals(ctx: SdkContext): void {
    if (typeof window === 'undefined') return;

    const { capture, logger } = ctx;

    function emit(
        name: MetricName,
        value: number,
        // web-vitals returns 'needs-improvement' (dashed) — backend expects
        // 'needs_improvement' (underscored). Accept either, normalize before send.
        rating: 'good' | 'needs-improvement' | 'needs_improvement' | 'poor',
        attribution: Record<string, unknown>,
    ): void {
        const path = getCurrentPath() || location.pathname;
        const normalizedRating = rating === 'needs-improvement' ? 'needs_improvement' : rating;
        logger.debug('vital', name, value, normalizedRating, path);

        capture('/vitals', {
            uuid: uuid(),
            metric: name,
            value,
            rating: normalizedRating,
            path,
            attribution,
            device_type: getDeviceType(),
            connection_type: getConnectionType(),
            occurred_at: nowIso(),
        });
    }

    onLCP((m: LCPMetricWithAttribution) => {
        const a = m.attribution;
        const el = a.lcpEntry?.element ?? null;
        emit('lcp', m.value, m.rating, {
            elementTag: el?.tagName?.toLowerCase() ?? null,
            elementSelector: a.element ?? null,
            url: a.url ?? null,
            resourceLoadDelay: round(a.resourceLoadDelay),
            resourceLoadDuration: round(a.resourceLoadDuration),
            elementRenderDelay: round(a.elementRenderDelay),
            timeToFirstByte: round(a.timeToFirstByte),
        });
    });

    onCLS((m: CLSMetricWithAttribution) => {
        const a = m.attribution;
        const sources = (a.largestShiftEntry?.sources ?? [])
            .slice(0, 5)
            .map((s) => ({
                target: nodeSelector(s.node) ?? null,
                value: round4(shiftValue(s)),
            }));
        emit('cls', m.value, m.rating, {
            largestShiftTarget: a.largestShiftTarget ?? null,
            largestShiftValue: round4(a.largestShiftValue ?? 0),
            largestShiftTime: round(a.largestShiftTime ?? 0),
            loadState: a.loadState ?? null,
            sources,
        });
    });

    onINP((m: INPMetricWithAttribution) => {
        const a = m.attribution;
        emit('inp', m.value, m.rating, {
            interactionTarget: a.interactionTarget ?? null,
            interactionType: a.interactionType ?? null,
            inputDelay: round(a.inputDelay),
            processingDuration: round(a.processingDuration),
            presentationDelay: round(a.presentationDelay),
            loadState: a.loadState ?? null,
        });
    });

    onFCP((m: FCPMetricWithAttribution) => {
        const a = m.attribution;
        emit('fcp', m.value, m.rating, {
            loadState: a.loadState ?? null,
            timeToFirstByte: round(a.timeToFirstByte),
        });
    });

    onTTFB((m: TTFBMetricWithAttribution) => {
        const a = m.attribution;
        emit('ttfb', m.value, m.rating, {
            waitingDuration: round(a.waitingDuration),
            dnsDuration: round(a.dnsDuration),
            connectionDuration: round(a.connectionDuration),
            requestDuration: round(a.requestDuration),
        });
    });

    logger.debug('vitals instrumentation installed (attribution mode)');
}

// ── helpers ─────────────────────────────────────────────────────────────

function round(n: number | undefined | null): number {
    return n == null ? 0 : Math.round(n);
}
function round4(n: number | undefined | null): number {
    return n == null ? 0 : Math.round(n * 10000) / 10000;
}

// A CLS source's "value" isn't exposed directly — estimate from the rect
// delta. This is close enough for attribution display.
function shiftValue(s: LayoutShiftAttribution): number {
    const prev = s.previousRect;
    const curr = s.currentRect;
    if (!prev || !curr) return 0;
    const dx = Math.abs(prev.x - curr.x);
    const dy = Math.abs(prev.y - curr.y);
    return Math.max(dx, dy);
}

function nodeSelector(node: Node | undefined | null): string | null {
    if (!node || !(node instanceof Element)) return null;
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof node.className === 'string' && node.className
        ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    return `${tag}${id}${cls}`;
}

function getDeviceType(): 'desktop' | 'mobile' | 'tablet' {
    if (typeof navigator === 'undefined') return 'desktop';
    const ua = navigator.userAgent;
    if (/tablet|ipad/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone/i.test(ua)) return 'mobile';
    return 'desktop';
}

function getConnectionType(): string | null {
    try {
        const nav = navigator as Navigator & {
            connection?: { effectiveType?: string };
        };
        return nav.connection?.effectiveType ?? null;
    } catch {
        return null;
    }
}
