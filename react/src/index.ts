// @reliable/react — React bindings for @reliableapp/frontend-core.
// Re-exports the full core public API and adds React-specific primitives:
//   <ReliableProvider>       — initializes the SDK, exposes context
//   <ReliableErrorBoundary>  — catches render crashes, reports with componentStack
//   useReliable()            — access the client from context
//   useIdentify()            — call identify() on mount / user change
//   useCaptureException()    — stable captureException reference
//   useCaptureMessage()      — stable captureMessage reference
//   useAddBreadcrumb()       — stable addBreadcrumb reference
//   useSetTag/useSetTags()   — stable tag setters
//   useReliableRouter()      — generic router breadcrumb adapter
//   useReliableNextPagesRouter() — Next.js Pages Router adapter

// ── React-specific ────────────────────────────────────────────────────────
export { ReliableProvider } from './provider';
export type { ReliableProviderProps } from './provider';

export { ReliableErrorBoundary } from './error-boundary';
export type { ReliableErrorBoundaryProps } from './error-boundary';

export {
    useReliable,
    useIdentify,
    useCaptureException,
    useCaptureMessage,
    useAddBreadcrumb,
    useSetTag,
    useSetTags,
    useFlush,
} from './hooks';

export {
    useReliableRouter,
    useReliableNextPagesRouter,
} from './router';

// ── Core re-exports ───────────────────────────────────────────────────────
// Consumers only need to install @reliable/react; they get the full API.
export {
    init,
    getClient,
    identify,
    setTag,
    setTags,
    addBreadcrumb,
    flush,
    captureException,
    captureMessage,
} from '@reliableapp/frontend-core';

export type {
    ReliableConfig,
    ReliableClient,
    UserIdentity,
    Breadcrumb,
    LogLevel,
    ErrorSeverity,
    CaptureOptions,
    CaptureMessageOptions,
} from '@reliableapp/frontend-core';
