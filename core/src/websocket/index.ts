// WebSocket capture — monkey-patch `window.WebSocket` to observe
// connection lifecycle, errors, and aggregate volume stats.
//
// Phase L1 — post-upgrade only. The HTTP handshake before the upgrade
// (101 Switching Protocols / 4xx-5xx) is already captured by the
// `network` module via fetch/XHR instrumentation. Once the socket is
// upgraded, those captures stop and this module takes over.
//
// One captured row per connection — not per message. The SDK accumulates
// counters in memory while the socket is alive and emits a single record
// on close (or page unload). A chat app pushing 100 msg/s would otherwise
// flood the ingest endpoint.
//
// What we report:
//   • `/websocket` — lifecycle + volume summary on close
//   • `captureException` — abnormal close, post-open `error` events,
//      sending on a CLOSING/CLOSED socket. Errors are NOT duplicated
//      onto the `/websocket` summary's error_count above 1 if the same
//      close already counted.

import type { SdkContext } from '../context';
import { captureException } from '../errors';
import { getCurrentPath } from '../navigation';
import { scrubUrl } from '../scrub';
import { nowIso } from '../util/now';
import { uuid } from '../util/uuid';

/** Sliding window for reconnect storm detection — same template within Ns. */
const RECONNECT_WINDOW_MS = 30_000;

/** Trim ring buffer of recent opens once it exceeds this. */
const RECONNECT_HISTORY_MAX = 50;

/** Clean close codes — 1000 normal, 1001 going away (navigation). */
const CLEAN_CLOSE_CODES = new Set([1000, 1001]);

let teardown: (() => void) | null = null;

interface RecentOpen { template: string; at: number }

export function initWebSocket(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof window === 'undefined') return;
    if (typeof window.WebSocket !== 'function') return;

    const { capture, logger } = ctx;
    const OrigWS = window.WebSocket;

    // Per-template ring buffer of recent open timestamps. A connection's
    // reconnect_count = number of opens to the same template within the
    // 30s window. Backoff broken? You'll see >3.
    const recentOpens: RecentOpen[] = [];

    function recordOpen(template: string): number {
        const now = Date.now();
        // Prune anything older than the window before counting.
        while (recentOpens.length && now - recentOpens[0]!.at > RECONNECT_WINDOW_MS) {
            recentOpens.shift();
        }
        let count = 0;
        for (const o of recentOpens) if (o.template === template) count++;
        recentOpens.push({ template, at: now });
        if (recentOpens.length > RECONNECT_HISTORY_MAX) recentOpens.shift();
        return count; // count BEFORE this open — so 0 = first, 1 = first reconnect, etc.
    }

    const PatchedWS = function PatchedWebSocket(
        this: WebSocket,
        url: string | URL,
        protocols?: string | string[],
    ): WebSocket {
        const rawUrl = typeof url === 'string' ? url : url.href;
        const safeUrl = scrubUrl(rawUrl);
        const template = urlTemplate(safeUrl);
        const protocolsArr: string[] = protocols == null
            ? []
            : Array.isArray(protocols) ? protocols : [protocols];

        const connUuid = uuid();
        const startWall = Date.now();
        const path = getCurrentPath() || (typeof location !== 'undefined' ? location.pathname : '');

        const meta = {
            uuid: connUuid,
            url: safeUrl,
            url_template: template,
            protocols: protocolsArr,
            openedAt: nowIso(),
            startWall,
            path,
            reconnectCount: recordOpen(template),

            messagesSent: 0,
            messagesReceived: 0,
            bytesSent: 0,
            bytesReceived: 0,
            errorCount: 0,
            flushed: false,
        };

        // Construct the real socket. WebSocket throws synchronously on bad
        // URLs (mixed-content, malformed) — let that bubble to user code.
        const ws = protocols == null
            ? new OrigWS(rawUrl)
            : new OrigWS(rawUrl, protocols);

        // ── lifecycle listeners (added via addEventListener so we don't
        //    clobber whatever the user assigns to onopen/onerror/onclose).

        ws.addEventListener('message', (ev: MessageEvent) => {
            meta.messagesReceived++;
            meta.bytesReceived += sizeOfMessage(ev.data);
        });

        ws.addEventListener('error', () => {
            meta.errorCount++;
            // We only know "something errored" — the WebSocket spec hides
            // the underlying network detail. Report with the URL so the
            // backend can group by endpoint.
            captureException(new Error(`WebSocket error: ${safeUrl}`), {
                severity: 'medium',
                tags: { source: 'websocket', ws_url: safeUrl, ws_uuid: connUuid },
            });
        });

        ws.addEventListener('close', (ev: CloseEvent) => {
            if (meta.flushed) return;
            meta.flushed = true;

            const closedAtMs = Date.now();
            const closeCode = typeof ev.code === 'number' ? ev.code : null;
            const cleanClose = closeCode != null && CLEAN_CLOSE_CODES.has(closeCode);
            // If we never saw an explicit `error` event but the close code
            // is dirty (1006 abnormal, 1011-1014 server-side), surface it
            // as an error too. The connection died unexpectedly — that's
            // exactly what on-call needs to know.
            const hadError = meta.errorCount > 0 || (closeCode != null && !cleanClose);

            if (closeCode != null && !cleanClose && meta.errorCount === 0) {
                captureException(new Error(
                    `WebSocket closed abnormally (code ${closeCode}${ev.reason ? `: ${ev.reason}` : ''}): ${safeUrl}`,
                ), {
                    severity: 'medium',
                    tags: { source: 'websocket', ws_url: safeUrl, ws_uuid: connUuid, close_code: closeCode },
                });
            }

            capture('/websocket', {
                uuid: connUuid,
                url: safeUrl,
                url_template: template,
                protocols: protocolsArr,

                opened_at: meta.openedAt,
                closed_at: new Date(closedAtMs).toISOString(),
                duration_ms: Math.max(0, closedAtMs - startWall),

                close_code: closeCode,
                close_reason: ev.reason || null,
                had_error: hadError,
                error_count: meta.errorCount,

                messages_sent: meta.messagesSent,
                messages_received: meta.messagesReceived,
                bytes_sent: meta.bytesSent,
                bytes_received: meta.bytesReceived,

                reconnect_count: meta.reconnectCount,

                path,
                occurred_at: nowIso(),
            });

            logger.debug('websocket close', closeCode, safeUrl, `${meta.messagesSent}↑/${meta.messagesReceived}↓`);
        });

        // ── send() wrapper — count outbound messages, catch send-on-closed.

        const origSend = ws.send.bind(ws);
        ws.send = function patchedSend(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
            if (ws.readyState === OrigWS.CLOSING || ws.readyState === OrigWS.CLOSED) {
                meta.errorCount++;
                captureException(new Error(`WebSocket.send() on closed connection: ${safeUrl}`), {
                    severity: 'low',
                    tags: { source: 'websocket', ws_url: safeUrl, ws_uuid: connUuid, ready_state: ws.readyState },
                });
                // Let the native call throw — same behavior the user would
                // have seen without us; we just observed it.
            }
            meta.messagesSent++;
            meta.bytesSent += sizeOfMessage(data);
            return origSend(data);
        };

        return ws;
    } as unknown as typeof WebSocket;

    // Preserve constants + prototype so `instanceof` checks and
    // `WebSocket.OPEN` constant references still work.
    PatchedWS.prototype = OrigWS.prototype;
    (PatchedWS as unknown as { CONNECTING: number }).CONNECTING = OrigWS.CONNECTING;
    (PatchedWS as unknown as { OPEN: number }).OPEN = OrigWS.OPEN;
    (PatchedWS as unknown as { CLOSING: number }).CLOSING = OrigWS.CLOSING;
    (PatchedWS as unknown as { CLOSED: number }).CLOSED = OrigWS.CLOSED;

    window.WebSocket = PatchedWS;

    teardown = () => {
        window.WebSocket = OrigWS;
        teardown = null;
    };

    logger.debug('websocket instrumentation installed');
}

export function destroyWebSocket(): void {
    teardown?.();
}

// ── helpers ─────────────────────────────────────────────────────────────

function sizeOfMessage(data: unknown): number {
    if (data == null) return 0;
    try {
        if (typeof data === 'string') return new Blob([data]).size;
        if (data instanceof Blob) return data.size;
        if (data instanceof ArrayBuffer) return data.byteLength;
        if (ArrayBuffer.isView(data)) return data.byteLength;
    } catch { /* sizing failed — count as 0 rather than throw */ }
    return 0;
}

/** Same logic as network/index.ts urlTemplate but for ws:// / wss://. */
function urlTemplate(url: string): string {
    try {
        const u = new URL(url);
        const segs = u.pathname.split('/').map((seg) => {
            if (!seg) return seg;
            if (/^\d+$/.test(seg)) return ':id';
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
            if (/^[0-9a-f]{24,}$/i.test(seg)) return ':hex';
            return seg;
        });
        return `${u.protocol}//${u.host}${segs.join('/')}`;
    } catch {
        return url;
    }
}
