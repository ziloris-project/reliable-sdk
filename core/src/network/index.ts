// Network capture — monkey-patch fetch and XMLHttpRequest.
//
// By default only failures are reported (status >= 400 or network error).
// Set `captureAllRequests: true` in config to report every request.
//
// Self-ignore: requests to the ingest endpoint are always skipped to
// prevent infinite loops (SDK reporting its own reporting).
//
// Each captured event carries:
//   • timing breakdown (dns/connect/ttfb/download) from PerformanceResourceTiming
//   • request + response headers (sensitive header values redacted)
//   • request body (always captured when present, capped + scrubbed)
//   • response body (only for failed requests, capped + scrubbed)
//   • url_template — a normalized path with numeric/UUID segments → ":id"

import type { SdkContext } from '../context';
import { getCurrentPath } from '../navigation';
import { triggerReplayFlush } from '../replay';
import { scrubUrl, scrubHeaders, scrubString } from '../scrub';
import { uuid } from '../util/uuid';
import { nowIso } from '../util/now';

const BODY_MAX_BYTES = 2048;

let teardown: (() => void) | null = null;

/** Ring buffer of recent network events — errors module reads this to
 *  classify `api_response` triggers. Kept tiny (last 10). */
const recentNetwork: { url: string; status: number; finishedAt: number; eventUuid: string }[] = [];
const NETWORK_RECENT_MAX = 10;

export function getRecentNetwork(): readonly { url: string; status: number; finishedAt: number; eventUuid: string }[] {
    return recentNetwork;
}

export function initNetwork(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof window === 'undefined') return;

    const { config, capture, logger } = ctx;
    const endpointHost = safeHost(config.endpoint);

    function isSelf(url: string): boolean {
        if (!endpointHost) return false;
        return safeHost(url) === endpointHost;
    }

    function shouldReport(status: number, failed: boolean): boolean {
        if (config.captureAllRequests) return true;
        return failed || status >= 400;
    }

    function noteNetwork(url: string, status: number, eventUuid: string): void {
        recentNetwork.push({ url, status, finishedAt: Date.now(), eventUuid });
        if (recentNetwork.length > NETWORK_RECENT_MAX) recentNetwork.shift();
    }

    function send(
        method: string,
        rawUrl: string,
        status: number,
        durationMs: number,
        startedAt: number,
        timing: RequestTiming | null,
        requestHeaders: Record<string, string>,
        responseHeaders: Record<string, string>,
        requestBody: string | null,
        responseBody: string | null,
        requestSize: number | null,
        responseSize: number | null,
    ): void {
        const failed = status === 0 || status >= 400;
        const eventUuid = uuid();
        noteNetwork(rawUrl, status, eventUuid);

        if (!shouldReport(status, failed)) return;

        const path = getCurrentPath() || location.pathname;
        const safeUrl = scrubUrl(rawUrl);

        capture('/network', {
            uuid: eventUuid,
            method: method.toUpperCase(),
            url: safeUrl,
            url_template: urlTemplate(safeUrl),
            status_code: status,
            duration_ms: Math.round(durationMs),
            dns_ms: timing?.dns ?? null,
            connect_ms: timing?.connect ?? null,
            ttfb_ms: timing?.ttfb ?? null,
            download_ms: timing?.download ?? null,
            request_headers: requestHeaders,
            response_headers: responseHeaders,
            request_body: requestBody,
            response_body: responseBody,
            request_size: requestSize,
            response_size: responseSize,
            path,
            occurred_at: new Date(startedAt).toISOString(),
        });

        // Trigger replay flush on network failures.
        if (failed) {
            triggerReplayFlush(ctx, eventUuid);
        }

        logger.debug('network', method, status, Math.round(durationMs) + 'ms', rawUrl);
    }

    // ── fetch patch ─────────────────────────────────────────────────────

    const origFetch = window.fetch;

    window.fetch = async function patchedFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.href
                : input.url;
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : null) ?? 'GET');

        if (isSelf(url)) return origFetch.call(window, input, init);

        const reqHeaders = scrubHeaders(readHeaders(init?.headers));
        const reqBody = truncateBody(readBody(init?.body));
        const reqSize = reqBody ? byteLength(reqBody) : null;

        const startPerf = performance.now();
        const startWall = Date.now();
        try {
            const res = await origFetch.call(window, input, init);
            const duration = performance.now() - startPerf;

            const respHeaders = scrubHeaders(headersToObject(res.headers));
            const respSize = parseContentLength(res.headers);

            // Only read response body on failures — cloning is cheap but reading
            // the stream can compete with the caller's consumer on the real Response.
            const failed = res.status === 0 || res.status >= 400;
            let respBody: string | null = null;
            if (failed) {
                try {
                    respBody = truncateBody(await res.clone().text());
                } catch { /* body may have been locked or errored; skip. */ }
            }

            const timing = resolveResourceTiming(url, startPerf, performance.now());
            send(method, url, res.status, duration, startWall, timing,
                 reqHeaders, respHeaders, reqBody, respBody, reqSize, respSize);
            return res;
        } catch (err) {
            const duration = performance.now() - startPerf;
            const timing = resolveResourceTiming(url, startPerf, performance.now());
            send(method, url, 0, duration, startWall, timing,
                 reqHeaders, {}, reqBody, null, reqSize, null);
            throw err;
        }
    };

    // ── XHR patch ───────────────────────────────────────────────────────

    const OrigXHR = window.XMLHttpRequest;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    const origSetHeader = OrigXHR.prototype.setRequestHeader;

    OrigXHR.prototype.open = function patchedOpen(
        method: string,
        url: string | URL,
        ...rest: unknown[]
    ): void {
        (this as XHRMeta).__rl_method = method;
        (this as XHRMeta).__rl_url = typeof url === 'string' ? url : url.href;
        (this as XHRMeta).__rl_reqHeaders = {};
        return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
    };

    OrigXHR.prototype.setRequestHeader = function patchedSet(name: string, value: string): void {
        const meta = this as XHRMeta;
        if (meta.__rl_reqHeaders) meta.__rl_reqHeaders[name] = value;
        return origSetHeader.call(this, name, value);
    };

    OrigXHR.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
        const meta = this as XHRMeta;
        const url = meta.__rl_url ?? '';
        const method = meta.__rl_method ?? 'GET';

        if (isSelf(url)) return origSend.call(this, body);

        const reqHeaders = scrubHeaders(meta.__rl_reqHeaders ?? {});
        const reqBody = truncateBody(readBody(body as BodyInit | null | undefined));
        const reqSize = reqBody ? byteLength(reqBody) : null;

        const startPerf = performance.now();
        const startWall = Date.now();

        this.addEventListener('loadend', function onLoadEnd() {
            const duration = performance.now() - startPerf;
            const failed = meta.status === 0 || meta.status >= 400;
            const respHeaders = scrubHeaders(parseRawResponseHeaders(meta.getAllResponseHeaders()));
            const respSize = parseXHRContentLength(meta);

            let respBody: string | null = null;
            if (failed) {
                try {
                    const text = typeof meta.responseText === 'string' ? meta.responseText : null;
                    respBody = truncateBody(text);
                } catch { /* accessing responseText on non-text responseType throws. */ }
            }

            const timing = resolveResourceTiming(url, startPerf, performance.now());
            send(method, url, meta.status, duration, startWall, timing,
                 reqHeaders, respHeaders, reqBody, respBody, reqSize, respSize);
        });

        return origSend.call(this, body);
    };

    // ── teardown ────────────────────────────────────────────────────────

    teardown = () => {
        window.fetch = origFetch;
        OrigXHR.prototype.open = origOpen;
        OrigXHR.prototype.send = origSend;
        OrigXHR.prototype.setRequestHeader = origSetHeader;
        teardown = null;
    };

    logger.debug('network instrumentation installed');
}

export function destroyNetwork(): void {
    teardown?.();
}

// ── helpers ─────────────────────────────────────────────────────────────

interface XHRMeta extends XMLHttpRequest {
    __rl_method?: string;
    __rl_url?: string;
    __rl_reqHeaders?: Record<string, string>;
}

interface RequestTiming {
    dns: number;
    connect: number;
    ttfb: number;
    download: number;
}

function safeHost(url: string): string | null {
    try {
        return new URL(url, 'http://_/').host;
    } catch {
        return null;
    }
}

function parseContentLength(headers: Headers): number | null {
    const cl = headers.get('content-length');
    if (!cl) return null;
    const n = parseInt(cl, 10);
    return Number.isFinite(n) ? n : null;
}

function parseXHRContentLength(xhr: XMLHttpRequest): number | null {
    try {
        const cl = xhr.getResponseHeader('content-length');
        if (!cl) return null;
        const n = parseInt(cl, 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

function headersToObject(h: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    try { h.forEach((v, k) => { out[k] = v; }); } catch { /* headers may be opaque */ }
    return out;
}

function readHeaders(
    h: HeadersInit | undefined,
): Record<string, string> {
    if (!h) return {};
    const out: Record<string, string> = {};
    try {
        if (h instanceof Headers) {
            h.forEach((v, k) => { out[k] = v; });
        } else if (Array.isArray(h)) {
            for (const [k, v] of h) out[k] = v;
        } else {
            for (const [k, v] of Object.entries(h as Record<string, string>)) out[k] = v;
        }
    } catch { /* headers shape unknown; skip */ }
    return out;
}

function readBody(body: BodyInit | null | undefined): string | null {
    if (body == null) return null;
    try {
        if (typeof body === 'string') return body;
        if (body instanceof URLSearchParams) return body.toString();
        if (body instanceof FormData) {
            // FormData is multipart — summarize entries rather than sending raw.
            const parts: string[] = [];
            body.forEach((v, k) => {
                parts.push(`${k}=${typeof v === 'string' ? v : '[file]'}`);
            });
            return parts.join('&');
        }
        if (body instanceof Blob) return `[blob ${body.size}B]`;
        if (body instanceof ArrayBuffer) return `[binary ${body.byteLength}B]`;
    } catch { /* unreadable */ }
    return null;
}

function truncateBody(s: string | null | undefined): string | null {
    if (s == null) return null;
    const scrubbed = scrubString(s);
    if (byteLength(scrubbed) <= BODY_MAX_BYTES) return scrubbed;
    // Truncate on char boundary; signal truncation so the UI can render "…"
    return scrubbed.slice(0, BODY_MAX_BYTES) + '…[truncated]';
}

function byteLength(s: string): number {
    try { return new Blob([s]).size; } catch { return s.length; }
}

function parseRawResponseHeaders(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw) return out;
    for (const line of raw.trim().split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function resolveResourceTiming(
    url: string,
    startedAtPerf: number,
    finishedAtPerf: number,
): RequestTiming | null {
    try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        // Walk newest-to-oldest; first match that overlaps our window wins.
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i]!;
            if (e.name !== url) continue;
            if (e.startTime < startedAtPerf - 50) continue;
            if (e.responseEnd > finishedAtPerf + 50) continue;
            return {
                dns:      Math.max(0, Math.round(e.domainLookupEnd - e.domainLookupStart)),
                connect:  Math.max(0, Math.round(e.connectEnd      - e.connectStart)),
                ttfb:     Math.max(0, Math.round(e.responseStart   - e.requestStart)),
                download: Math.max(0, Math.round(e.responseEnd     - e.responseStart)),
            };
        }
    } catch { /* Resource Timing API not available */ }
    return null;
}

/** Collapse numeric / UUID / long hex segments so the backend can group
 *  `/users/42` and `/users/99` under `/users/:id`. Keep the rest intact. */
function urlTemplate(url: string): string {
    try {
        const isRelative = !/^https?:\/\//i.test(url);
        const u = new URL(url, isRelative ? 'http://_placeholder_/' : undefined);
        const segs = u.pathname.split('/').map((seg) => {
            if (!seg) return seg;
            if (/^\d+$/.test(seg)) return ':id';
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
            if (/^[0-9a-f]{24,}$/i.test(seg)) return ':hex';
            return seg;
        });
        return segs.join('/');
    } catch {
        return url;
    }
}
