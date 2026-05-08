// <ReliableProvider>: initializes the core client once on mount, exposes it
// via context to all child components, and flushes buffered events on unmount.

import React, { createContext, useContext, useEffect, useRef } from 'react';
import { init, flush } from '@reliableapp/frontend-core';
import type { ReliableClient, ReliableConfig } from '@reliableapp/frontend-core';

const ReliableContext = createContext<ReliableClient | null>(null);

export interface ReliableProviderProps {
    config: ReliableConfig;
    children: React.ReactNode;
}

/**
 * Mount at the root of your app (outside any router). Calls `init()` once and
 * flushes on unmount so in-flight events aren't lost during hot reloads or
 * StrictMode double-invocations.
 *
 * @example
 * <ReliableProvider config={{ publicKey: 'pk_live_rl_...' }}>
 *   <App />
 * </ReliableProvider>
 */
export function ReliableProvider({ config, children }: ReliableProviderProps) {
    // Initialize exactly once. Calling init() in render body (guarded by ref)
    // is intentional — useEffect would be too late for errors thrown during
    // first render, and we need the client before children mount.
    const clientRef = useRef<ReliableClient | null>(null);
    if (clientRef.current === null) {
        clientRef.current = init(config);
    }

    useEffect(() => {
        return () => { flush(); };
    }, []);

    return (
        <ReliableContext.Provider value={clientRef.current}>
            {children}
        </ReliableContext.Provider>
    );
}

/** Raw context accessor used by hooks and the error boundary. */
export function useReliableContext(): ReliableClient | null {
    return useContext(ReliableContext);
}
