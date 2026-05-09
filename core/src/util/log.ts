// Namespaced console logger. `debug` is gated so production SDKs stay silent
// by default; `warn` and `error` always speak up because if we're warning,
// the integrator needs to see it.
//
// IMPORTANT: console.* references are captured at logger creation time so
// our own SDK warnings bypass any later monkey-patching of `console` (e.g.
// the optional console-capture module). Otherwise the SDK warning about
// "replay flush failed" would itself be re-captured as a captureMessage,
// which would feedback-loop on the next failure.

export interface Logger {
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

const PREFIX = '[reliable]';

export function createLogger(debug: boolean): Logger {
    // Bind the originals NOW. Anything that patches console.* after this
    // point cannot affect what the logger calls.
    const origDebug = console.debug.bind(console);
    const origWarn  = console.warn.bind(console);
    const origError = console.error.bind(console);

    return {
        debug: debug
            ? (...args: unknown[]): void => { origDebug(PREFIX, ...args); }
            : (): void => {},
        warn:  (...args: unknown[]): void => { origWarn(PREFIX, ...args); },
        error: (...args: unknown[]): void => { origError(PREFIX, ...args); },
    };
}
