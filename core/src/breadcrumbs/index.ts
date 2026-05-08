// Ring buffer of user actions (clicks, navigations, console, network) leading
// up to an error. Feature modules push crumbs here via `client.addBreadcrumb`
// or — for feature-internal events — directly through the context. Error
// events read the latest snapshot at send time.

import type { Breadcrumb, LogLevel } from '../types';
import { nowIso } from '../util/now';

const MAX_BREADCRUMBS = 30;

export interface BreadcrumbInput {
    category: string;
    message: string;
    level?: LogLevel;
    data?: Record<string, unknown>;
}

export interface BreadcrumbRing {
    add(crumb: BreadcrumbInput): void;
    list(): Breadcrumb[];
    clear(): void;
}

export function createBreadcrumbRing(): BreadcrumbRing {
    const buf: Breadcrumb[] = [];

    return {
        add(crumb) {
            buf.push({
                category: crumb.category,
                message: crumb.message,
                level: crumb.level ?? 'info',
                data: crumb.data,
                timestamp: nowIso(),
            });
            if (buf.length > MAX_BREADCRUMBS) buf.shift();
        },
        list() {
            return buf.slice();
        },
        clear() {
            buf.length = 0;
        },
    };
}
