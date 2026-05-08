// PII and secrets redaction. Applied to anything that could carry user data
// on its way out: URLs, headers, free-form strings inside payloads. These
// patterns are deliberately conservative — false positives are better than
// leaking credentials.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

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
