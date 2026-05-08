// SdkContext is the object feature modules receive. It's the *only* way
// features touch shared state — they never import the transport or session
// directly. This keeps each feature swappable and testable in isolation:
// pass a hand-built SdkContext and you can unit-test a feature without
// booting a real client.

import type { ResolvedConfig } from './config';
import type { BreadcrumbRing } from './breadcrumbs';
import type { Scope } from './scope';
import type { SessionManager } from './session';
import type { Transport } from './transport';
import type { Logger } from './util/log';

export interface SdkContext {
    config: ResolvedConfig;
    logger: Logger;
    scope: Scope;
    breadcrumbs: BreadcrumbRing;
    session: SessionManager;
    transport: Transport;
    /**
     * Convenience helper: enrich a feature payload with session_uuid +
     * occurred_at (if not already set), touch the session, and enqueue.
     * Feature modules should prefer this over calling transport directly.
     */
    capture(path: string, payload: Record<string, unknown>): void;
}
