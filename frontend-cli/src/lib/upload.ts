import { promises as fs } from 'fs';
import path from 'path';

export interface UploadInput {
    api:         string;
    token:       string;
    release:     string;
    environment: string;
    assetUrl:    string;
    mapPath:     string;
}

const MAX_RETRIES        = 3;
const RETRY_BASE_MS      = 800;
const RESPONSE_BODY_MAX  = 200;

/**
 * POST one .js.map to the backend. Throws on non-2xx after retries.
 *
 * Retries on 5xx and network failures with exponential backoff because
 * sourcemap uploads run in parallel against rate-limited backends — a
 * single transient 502 shouldn't kill the whole batch.
 */
export async function uploadSourcemap(input: UploadInput): Promise<void> {
    const buffer = await fs.readFile(input.mapPath);
    const url    = `${input.api.replace(/\/+$/, '')}/v1/sourcemaps`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
        }

        try {
            // Re-create FormData per attempt — Blob is consumed by fetch.
            const blob = new Blob([buffer], { type: 'application/json' });
            const form = new FormData();
            form.append('release',     input.release);
            form.append('environment', input.environment);
            form.append('asset_url',   input.assetUrl);
            form.append('sourcemap',   blob, path.basename(input.mapPath));

            const res = await fetch(url, {
                method:  'POST',
                headers: { Authorization: `Bearer ${input.token}` },
                body:    form,
            });

            if (res.ok) return;

            // 4xx errors are NOT retryable (bad request, auth, file too large).
            if (res.status >= 400 && res.status < 500) {
                throw new Error(await formatError(res));
            }

            // 5xx — retryable. Save and loop.
            lastError = new Error(await formatError(res));
        } catch (err) {
            // Network errors (ECONNRESET, timeout, DNS) — retryable.
            lastError = err instanceof Error ? err : new Error(String(err));
        }
    }

    throw lastError ?? new Error('Upload failed for unknown reason');
}

/**
 * Format an HTTP error response. Skips HTML response bodies (nginx /
 * Cloudflare error pages dump 1500+ chars of useless markup) — for those
 * we just show the status and a hint about what likely went wrong.
 */
async function formatError(res: Response): Promise<string> {
    const status = res.status;
    const text   = await res.text().catch(() => '');
    const isHtml = /^\s*<(!doctype|html|head|body)/i.test(text);

    if (isHtml) {
        let hint = '';
        if (status === 413)      hint = ' — file too large for the proxy. Increase nginx `client_max_body_size`.';
        else if (status === 502) hint = ' — bad gateway. Backend is down, slow, or rejecting the upload upstream of express.';
        else if (status === 504) hint = ' — gateway timeout. Backend took too long; increase nginx `proxy_read_timeout`.';
        return `HTTP ${status} (HTML response from proxy)${hint}`;
    }

    const snippet = text.slice(0, RESPONSE_BODY_MAX).replace(/\s+/g, ' ').trim();
    return `HTTP ${status}${snippet ? ` — ${snippet}` : ''}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
