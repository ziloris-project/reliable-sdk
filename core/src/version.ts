// SDK version, replaced at build time by tsup's `define` (see tsup.config.ts).
// Up to 1.4.x every session reported "0.0.0", so the backend could not tell
// SDK versions apart. Builds without the define (the manual esbuild harness)
// report "0.0.0-dev", deliberately distinct from that legacy value.

declare const __SDK_VERSION__: string | undefined;

export const SDK_VERSION: string =
    typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
