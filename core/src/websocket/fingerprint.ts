// WebSocket message fingerprinting (L2/L3 anomaly detection input).
//
// Goal: hash a message into a short stable string that clusters similar
// SHAPES together while telling distinct shapes apart. Run on every
// inbound and outbound message in the patched WebSocket — must be cheap
// and synchronous on the hot path.
//
// Three strategies, picked by message shape:
//
//   JSON  → sorted top-level keys + value of `type`/`event`/`kind` field
//           (the discriminator most apps use).
//   Binary → first 16 bytes hashed. Most binary protocols put a type
//           header up front; this catches that without needing to
//           understand the wire format.
//   Text  → digit / UUID / long-hex stripped, truncated, hashed. So
//           "user_123 joined" and "user_999 joined" fingerprint
//           identically.
//
// Hash choice: FNV-1a 64-bit. Architecture doc originally hand-waved
// "BLAKE3 / SHA-1" but those are cryptographic hashes for which we have
// no requirement here — no security boundary, just clustering. Crypto
// hashes in the browser are either (a) async (SubtleCrypto, blocking
// the hot path with promises) or (b) a >5KB JS dep (blake3-js). FNV-1a
// is one screen of inline code, no allocation per byte, hits ~1GB/s on
// modern V8 — perfect for "thousands of fingerprints per second" with
// negligible collision risk at top-K=16 fingerprints per session.
//
// Payload data is NEVER returned in the fingerprint output. Only the
// hash. Calling `extractFingerprint("password=hunter2")` returns
// something like `"t:e3a5b91247d6f8a2"` — no source reconstruction
// possible.

const FINGERPRINT_PREFIX_JSON  = 'j';   // JSON-shaped
const FINGERPRINT_PREFIX_BIN   = 'b';   // Binary (ArrayBuffer / typed array / Blob)
const FINGERPRINT_PREFIX_TEXT  = 't';   // Text (non-JSON)
const FINGERPRINT_PREFIX_NULL  = 'n';   // Empty / null

/** Bytes considered for binary fingerprint (most protocols put a type
 *  byte in the first ~8-16 bytes). */
const BINARY_PREFIX_BYTES = 16;

/** Cap on the text length the digit-stripper / hasher walks. Stops a
 *  10MB string from O(n)-blowing up the hot path. */
const TEXT_MAX_BYTES = 256;

/** Fields commonly used as discriminators in JSON message protocols.
 *  Order matters: first match wins. */
const DISCRIMINATOR_KEYS = ['type', 'event', 'kind', 'action', 'op', 'method'];

export type WSMessageData =
    | string
    | ArrayBuffer
    | ArrayBufferView
    | Blob
    | null
    | undefined;

/**
 * Compute a structural fingerprint for a WebSocket message. Output is a
 * short string suitable for use as a map key or set membership token.
 * Deterministic for identical structural inputs.
 *
 * For unknown / unsupported types returns the null fingerprint — never
 * throws on the hot path.
 */
export function extractFingerprint(data: WSMessageData): string {
    if (data == null) return FINGERPRINT_PREFIX_NULL;

    if (typeof data === 'string') {
        // Cheap JSON sniff before paying for parse. Trim leading
        // whitespace because some servers prefix payloads with \n.
        const trimmed = data.trimStart();
        const first = trimmed.charCodeAt(0);
        if (first === 0x7B /* { */ || first === 0x5B /* [ */) {
            const json = tryParseJson(trimmed);
            if (json !== UNPARSEABLE) return fingerprintJson(json);
        }
        return fingerprintText(data);
    }

    if (data instanceof Blob) {
        // Blob.text() / Blob.arrayBuffer() are async — we can't await
        // on the hot path. Cluster by log2(size) so blobs of the same
        // order of magnitude share a fingerprint.
        const bucket = data.size === 0 ? 0 : Math.floor(Math.log2(data.size));
        return `${FINGERPRINT_PREFIX_BIN}:blob:${bucket}`;
    }

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return fingerprintBinary(data);
    }

    return FINGERPRINT_PREFIX_NULL;
}

// ── Strategy: JSON ──────────────────────────────────────────────────────

const UNPARSEABLE = Symbol('unparseable');

function tryParseJson(s: string): unknown | typeof UNPARSEABLE {
    try {
        return JSON.parse(s);
    } catch {
        return UNPARSEABLE;
    }
}

function fingerprintJson(value: unknown): string {
    if (value == null) return `${FINGERPRINT_PREFIX_JSON}:null`;

    if (Array.isArray(value)) {
        // Arrays: discriminator is "array of what kind of thing". Use
        // the shape of the first element as a stand-in (skipping every
        // element would defeat the bounded-cost property of this hash).
        const first = value[0];
        const elementShape = first == null
            ? 'empty'
            : typeof first === 'object'
                ? fingerprintObjectShape(first as Record<string, unknown>)
                : typeof first;
        return `${FINGERPRINT_PREFIX_JSON}:[${elementShape}]`;
    }

    if (typeof value === 'object') {
        return `${FINGERPRINT_PREFIX_JSON}:${fingerprintObjectShape(value as Record<string, unknown>)}`;
    }

    // Non-object JSON root (rare in WS protocols but legal — `42`, `"hi"`).
    return `${FINGERPRINT_PREFIX_JSON}:${typeof value}`;
}

function fingerprintObjectShape(obj: Record<string, unknown>): string {
    const keys = Object.keys(obj).sort();

    // Discriminator value gets baked into the fingerprint so
    // {type:"ping"} and {type:"pong"} don't collide. We capture only
    // the field VALUE for discriminator keys — never any other field's
    // value. Bounded to 32 chars + non-printable scrub.
    let discriminator: string | null = null;
    for (const key of DISCRIMINATOR_KEYS) {
        const v = obj[key];
        if (v == null) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            discriminator = `${key}=${sanitizeDiscriminator(String(v))}`;
            break;
        }
    }

    const keyStr = keys.join(',');
    const hashSource = discriminator ? `${keyStr}|${discriminator}` : keyStr;
    return fnv1a64(hashSource);
}

function sanitizeDiscriminator(s: string): string {
    // Strip control chars, cap length. Discriminator values are
    // typically short type names — `"order_create"`, `"presence_update"`.
    // 32 chars is plenty.
    const cleaned = s.replace(/[^\x20-\x7E]/g, '?');
    return cleaned.length > 32 ? cleaned.slice(0, 32) : cleaned;
}

// ── Strategy: Binary ────────────────────────────────────────────────────

function fingerprintBinary(data: ArrayBuffer | ArrayBufferView): string {
    const bytes = toUint8Array(data);
    const slice = bytes.subarray(0, Math.min(BINARY_PREFIX_BYTES, bytes.length));
    // Length is part of the fingerprint so a 4-byte message can't
    // collide with a 100-byte message that happens to start the same.
    return `${FINGERPRINT_PREFIX_BIN}:${bytes.length}:${fnv1a64Bytes(slice)}`;
}

function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// ── Strategy: Text (non-JSON) ───────────────────────────────────────────

const DIGIT_RE = /\d+/g;
const UUID_RE  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE   = /[0-9a-f]{24,}/gi;

function fingerprintText(s: string): string {
    const trimmed = s.length > TEXT_MAX_BYTES ? s.slice(0, TEXT_MAX_BYTES) : s;
    const stripped = trimmed
        .replace(UUID_RE,  ':u')
        .replace(HEX_RE,   ':h')
        .replace(DIGIT_RE, ':n');
    return `${FINGERPRINT_PREFIX_TEXT}:${fnv1a64(stripped)}`;
}

// ── FNV-1a 64-bit (non-crypto, fast, allocation-free) ───────────────────
//
// 64-bit because the birthday-collision space at K=16 fingerprints per
// session would be ~1 in 10^15 — effectively zero. 32-bit FNV would be
// ~1 in 64k which is too close for comfort at scale.
//
// JS doesn't have a native u64. We carry the hash as two 32-bit halves
// and reassemble on output as hex. Multiplication uses Math.imul for
// the 32-bit-safe mul-mod-2^32 we need (vanilla `*` overflows precision
// past 2^53).

const FNV_OFFSET_HI = 0xCBF29CE4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_HI  = 0x100;
const FNV_PRIME_LO  = 0x1B3;

function fnv1a64(s: string): string {
    let hi = FNV_OFFSET_HI;
    let lo = FNV_OFFSET_LO;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        lo ^= code;
        // 64-bit multiply: (hi:lo) * (FNV_PRIME_HI:FNV_PRIME_LO)
        // We only need the low 64 bits, computed as four cross-multiplies.
        const newLo = Math.imul(lo, FNV_PRIME_LO) >>> 0;
        const carry = Math.floor(((lo >>> 0) * FNV_PRIME_LO) / 0x100000000);
        const newHi = (
            Math.imul(hi, FNV_PRIME_LO) +
            Math.imul(lo, FNV_PRIME_HI) +
            carry
        ) >>> 0;
        hi = newHi;
        lo = newLo;
    }
    return toHex32(hi) + toHex32(lo);
}

function fnv1a64Bytes(bytes: Uint8Array): string {
    let hi = FNV_OFFSET_HI;
    let lo = FNV_OFFSET_LO;
    for (let i = 0; i < bytes.length; i++) {
        lo ^= bytes[i]!;
        const newLo = Math.imul(lo, FNV_PRIME_LO) >>> 0;
        const carry = Math.floor(((lo >>> 0) * FNV_PRIME_LO) / 0x100000000);
        const newHi = (
            Math.imul(hi, FNV_PRIME_LO) +
            Math.imul(lo, FNV_PRIME_HI) +
            carry
        ) >>> 0;
        hi = newHi;
        lo = newLo;
    }
    return toHex32(hi) + toHex32(lo);
}

function toHex32(n: number): string {
    return (n >>> 0).toString(16).padStart(8, '0');
}
