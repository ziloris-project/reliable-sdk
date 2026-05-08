// Namespaced console logger. `debug` is gated so production SDKs stay silent
// by default; `warn` and `error` always speak up because if we're warning,
// the integrator needs to see it.

export interface Logger {
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

const PREFIX = '[reliable]';

export function createLogger(debug: boolean): Logger {
    return {
        debug: debug
            ? (...args: unknown[]): void => {
                  // eslint-disable-next-line no-console
                  console.debug(PREFIX, ...args);
              }
            : (): void => {},
        warn: (...args: unknown[]): void => {
            // eslint-disable-next-line no-console
            console.warn(PREFIX, ...args);
        },
        error: (...args: unknown[]): void => {
            // eslint-disable-next-line no-console
            console.error(PREFIX, ...args);
        },
    };
}
