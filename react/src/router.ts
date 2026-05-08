// Router instrumentation adapters. Each hook adds a 'navigation' breadcrumb
// when the pathname changes, which the errors module uses for trigger detection.
//
// Available adapters:
//   useReliableRouter(pathname)     — generic, works with any router
//   useReliableNextAppRouter()      — Next.js App Router (next/navigation)
//   useReliableNextPagesRouter(router) — Next.js Pages Router (useRouter)

import { useEffect, useRef } from 'react';
import { addBreadcrumb } from '@reliableapp/frontend-core';

/**
 * Generic adapter. Pass the current pathname (or pathname + search string).
 * Works with React Router, TanStack Router, or any router that exposes a
 * string path you can read in a component.
 *
 * @example (React Router v6)
 * const location = useLocation();
 * useReliableRouter(location.pathname + location.search);
 *
 * @example (TanStack Router)
 * const router = useRouter();
 * useReliableRouter(router.state.location.pathname);
 */
export function useReliableRouter(pathname: string): void {
    const prevRef = useRef<string | null>(null);
    useEffect(() => {
        // Skip the initial mount — the navigation module already records the
        // initial path via initNavigation. Only record actual transitions.
        if (prevRef.current === null) {
            prevRef.current = pathname;
            return;
        }
        if (prevRef.current === pathname) return;
        prevRef.current = pathname;
        addBreadcrumb({ category: 'navigation', message: pathname, level: 'info' });
    }, [pathname]);
}

/**
 * Next.js Pages Router adapter. Pass the router object from `useRouter()`.
 * Subscribes to `routeChangeComplete` events.
 *
 * @example
 * import { useRouter } from 'next/router';
 * import { useReliableNextPagesRouter } from '@reliable/react';
 *
 * export function MyApp({ Component, pageProps }) {
 *     const router = useRouter();
 *     useReliableNextPagesRouter(router);
 *     return <Component {...pageProps} />;
 * }
 */
export function useReliableNextPagesRouter(router: {
    events: {
        on(event: string, handler: (...args: unknown[]) => void): void;
        off(event: string, handler: (...args: unknown[]) => void): void;
    };
}): void {
    useEffect(() => {
        const handler = (url: unknown) => {
            if (typeof url === 'string') {
                addBreadcrumb({ category: 'navigation', message: url, level: 'info' });
            }
        };
        router.events.on('routeChangeComplete', handler);
        return () => { router.events.off('routeChangeComplete', handler); };
    }, [router.events]);
}
