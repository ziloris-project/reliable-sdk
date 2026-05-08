// Scope holds the current user + tags. It's the cheap, mutable state that
// every event pulls from at send time. Feature modules never set the user
// directly — they go through `client.identify()`, which owns session rotation
// on user changes.

import type { UserIdentity } from '../types';

export type TagValue = string | number | boolean;

export interface ScopeSnapshot {
    user: UserIdentity | null;
    tags: Record<string, TagValue>;
}

export interface Scope {
    setUser(user: UserIdentity | null): void;
    getUser(): UserIdentity | null;
    setTag(key: string, value: TagValue): void;
    setTags(tags: Record<string, TagValue>): void;
    clearTags(): void;
    snapshot(): ScopeSnapshot;
}

export function createScope(): Scope {
    let user: UserIdentity | null = null;
    const tags: Record<string, TagValue> = {};

    return {
        setUser(u) { user = u; },
        getUser()  { return user; },
        setTag(k, v) { tags[k] = v; },
        setTags(t)   { Object.assign(tags, t); },
        clearTags()  { for (const k of Object.keys(tags)) delete tags[k]; },
        snapshot()   { return { user, tags: { ...tags } }; },
    };
}
