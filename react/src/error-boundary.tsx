// <ReliableErrorBoundary>: class-based error boundary (React only supports
// class components for getDerivedStateFromError / componentDidCatch) that
// reports crashes to @reliableapp/frontend-core with the full React component stack.

import React from 'react';
import { captureException } from '@reliableapp/frontend-core';
import type { CaptureOptions } from '@reliableapp/frontend-core';

export interface ReliableErrorBoundaryProps {
    children: React.ReactNode;
    /**
     * What to render when the boundary catches an error.
     * - ReactNode: rendered as-is.
     * - Function: receives the error and a `reset` callback (clears state so
     *   the child tree re-mounts on next render).
     */
    fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
    /** Called after the error is reported to Reliable — useful for local logging. */
    onError?: (error: Error, info: React.ErrorInfo) => void;
    /** Extra tags merged into the error event. */
    tags?: CaptureOptions['tags'];
}

interface State {
    error: Error | null;
}

export class ReliableErrorBoundary extends React.Component<ReliableErrorBoundaryProps, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: React.ErrorInfo): void {
        captureException(error, {
            componentStack: info.componentStack ?? null,
            isCrash: true,
            tags: this.props.tags,
        });
        this.props.onError?.(error, info);
    }

    reset = (): void => {
        this.setState({ error: null });
    };

    override render(): React.ReactNode {
        const { error } = this.state;
        if (error) {
            const { fallback } = this.props;
            if (typeof fallback === 'function') {
                return fallback(error, this.reset);
            }
            return fallback ?? null;
        }
        return this.props.children;
    }
}
