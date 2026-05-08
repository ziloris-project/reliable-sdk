// RFC4122 v4 UUID generator. Prefers crypto.randomUUID (native, fast, cryptographically
// strong) and falls back to getRandomValues. Math.random is the last resort for
// ancient runtimes — not suitable for anything security-sensitive, but event IDs
// only need to be collision-resistant, not secret.

export function uuid(): string {
    const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;

    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }

    // RFC4122 §4.4 — set version (0100) and variant (10).
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
    const h = hex.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
