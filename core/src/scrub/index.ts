// PII and secrets redaction. Applied to anything that could carry user data
// on its way out: URLs, headers, free-form strings inside payloads. These
// patterns are deliberately conservative — false positives are better than
// leaking credentials.

// Also matches the percent-encoded form (jane%40example.com), which is how
// an email usually appears in a URL's query string.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+(?:@|%40)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

// 13-16 digit runs with optional spaces/dashes — catches most card PANs.
const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

// Query params whose *value* we replace with [redacted]. Keys chosen to cover
// the common OAuth / API-key / session tokens without nuking legit IDs.
const SENSITIVE_PARAMS = new Set([
    'token', 'access_token', 'id_token', 'refresh_token',
    'auth', 'authorization', 'password', 'pwd', 'secret',
    'api_key', 'apikey', 'sid', 'session', 'code', 'state',
]);

const SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'x-auth-token',
    'x-reliable-key',
]);

/** Redact emails and credit-card-shaped strings from free text. */
export function scrubString(input: string): string {
    if (!input) return input;
    return input.replace(EMAIL_RE, '[email]').replace(CC_RE, '[cc]');
}

/**
 * A page path (pathname + query) safe to send: sensitive query params
 * redacted, and emails or card-shaped numbers anywhere in it replaced. Every
 * path the SDK reports goes through this (see navigation's getCurrentPath).
 */
export function scrubPath(path: string): string {
    if (!path) return path;
    // Scrub before and after: scrubUrl re-encodes the query string, so an
    // email must be caught in whichever form it is in at each step.
    return scrubString(scrubUrl(scrubString(path)));
}

/**
 * A CSS-path-style selector safe to send and to group by: emails and card
 * numbers removed, and UUIDs and long digit runs (user or record ids baked
 * into element ids and classes) collapsed, so `button#delete-8231` and
 * `button#delete-9912` are one element, not two.
 */
export function scrubSelector(selector: string): string {
    if (!selector) return selector;
    return scrubString(selector)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
        .replace(/\d{4,}/g, ':n');
}

/**
 * Sanitize a URL: strip userinfo, redact sensitive query params.
 * Input may be absolute or relative; output preserves that shape.
 */
export function scrubUrl(url: string): string {
    try {
        const isRelative = !/^https?:\/\//i.test(url);
        const u = new URL(url, isRelative ? 'http://_placeholder_/' : undefined);

        u.username = '';
        u.password = '';

        for (const key of Array.from(u.searchParams.keys())) {
            if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
                u.searchParams.set(key, '[redacted]');
            }
        }

        if (isRelative) {
            return `${u.pathname}${u.search}${u.hash}`;
        }
        return u.toString();
    } catch {
        // Malformed URL — still redact obvious tokens in the raw string as a fallback.
        return url.replace(/([?&](?:token|access_token|api_key|secret)=)[^&#]+/gi, '$1[redacted]');
    }
}

/** Redact values of sensitive headers. Case-insensitive key match. */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v;
    }
    return out;
}
