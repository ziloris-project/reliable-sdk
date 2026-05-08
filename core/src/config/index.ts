// Config resolution. User-facing `ReliableConfig` is loose and forgiving;
// `ResolvedConfig` is the strict, fully-populated shape the rest of the SDK
// consumes. Validation happens once at init() — we want to fail loud if the
// integrator forgot the public key, not silently send events to nowhere.

import type { ReliableConfig } from '../types';

export interface ResolvedConfig {
    publicKey: string;
    endpoint: string;
    sampleRate: number;
    debug: boolean;
    beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
    captureVitals: boolean;
    captureErrors: boolean;
    captureNetwork: boolean;
    captureClicks: boolean;
    captureNavigation: boolean;
    captureAllRequests: boolean;
    captureReplay: boolean;
}

const DEFAULT_ENDPOINT = 'https://reliablebackend.ziloris.com/api/v1/ingest';

export function resolveConfig(input: ReliableConfig): ResolvedConfig {
    if (!input || typeof input !== 'object') {
        throw new Error('[reliable] init() requires a config object.');
    }
    if (typeof input.publicKey !== 'string' || input.publicKey.length === 0) {
        throw new Error('[reliable] init() requires a non-empty publicKey.');
    }
    if (!input.publicKey.startsWith('pk_')) {
        throw new Error('[reliable] publicKey must start with "pk_". Copy it from your project settings.');
    }

    const sampleRate =
        typeof input.sampleRate === 'number' && Number.isFinite(input.sampleRate)
            ? clamp(input.sampleRate, 0, 100)
            : 100;

    const endpoint = (input.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');

    return Object.freeze<ResolvedConfig>({
        publicKey:          input.publicKey,
        endpoint,
        sampleRate,
        debug:              input.debug ?? false,
        beforeSend:         input.beforeSend ?? ((e) => e),
        captureVitals:      input.captureVitals ?? true,
        captureErrors:      input.captureErrors ?? true,
        captureNetwork:     input.captureNetwork ?? true,
        captureClicks:      input.captureClicks ?? true,
        captureNavigation:  input.captureNavigation ?? true,
        captureAllRequests: input.captureAllRequests ?? true,
        captureReplay:      input.captureReplay ?? true,
    });
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}
