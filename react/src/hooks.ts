// React hooks: thin wrappers over the core API that are context-aware and
// stable across renders (all returned functions are referentially stable).

import { useCallback, useEffect } from 'react';
import {
    identify,
    setTag,
    setTags,
    addBreadcrumb,
    captureException,
    captureMessage,
    flush,
} from '@reliableapp/frontend-core';
import type {
    ReliableClient,
    UserIdentity,
    LogLevel,
    CaptureOptions,
    CaptureMessageOptions,
} from '@reliableapp/frontend-core';
import { useReliableContext } from './provider';

/** Returns the ReliableClient from the nearest <ReliableProvider>, or null. */
export function useReliable(): ReliableClient | null {
    return useReliableContext();
}

/**
 * Identify the current user. Calls `identify()` on mount and whenever
 * `user.externalId` changes (e.g. after login). Pass `null` to skip.
 */
export function useIdentify(user: UserIdentity | null | undefined): void {
    useEffect(() => {
        if (!user?.externalId) return;
        identify(user);
    // Intentional: re-identify only when the user *id* changes, not every
    // render (caller's object reference is not stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.externalId]);
}

/** Returns a stable `captureException` function. */
export function useCaptureException(): (error: unknown, options?: CaptureOptions) => string | null {
    return useCallback(
        (error: unknown, options?: CaptureOptions) => captureException(error, options),
        [],
    );
}

/** Returns a stable `captureMessage` function. */
export function useCaptureMessage(): (message: string, options?: CaptureMessageOptions) => string | null {
    return useCallback(
        (message: string, options?: CaptureMessageOptions) => captureMessage(message, options),
        [],
    );
}

/** Returns a stable `addBreadcrumb` function. */
export function useAddBreadcrumb(): (crumb: {
    category: string;
    message: string;
    level?: LogLevel;
    data?: Record<string, unknown>;
}) => void {
    return useCallback(
        (crumb) => addBreadcrumb(crumb),
        [],
    );
}

/** Returns a stable `setTag` function. */
export function useSetTag(): (key: string, value: string | number | boolean) => void {
    return useCallback(
        (key: string, value: string | number | boolean) => setTag(key, value),
        [],
    );
}

/** Returns a stable `setTags` function. */
export function useSetTags(): (tags: Record<string, string | number | boolean>) => void {
    return useCallback(
        (tags: Record<string, string | number | boolean>) => setTags(tags),
        [],
    );
}

/** Returns a stable `flush` function. */
export function useFlush(): () => Promise<void> {
    return useCallback(() => flush(), []);
}
