// In-memory FIFO queue. Stupidly simple by design — no persistence, no
// offline support in v1 (see FEATURES.md: dropped after one retry). If we
// ever want a persistent queue it goes in a separate module so this one
// stays a five-line primitive.

export interface OutboundEvent {
    /** Endpoint path relative to config.endpoint, e.g. `/errors`. */
    path: string;
    payload: Record<string, unknown>;
}

export interface Queue {
    enqueue(event: OutboundEvent): void;
    drain(): OutboundEvent[];
    size(): number;
}

export function createQueue(): Queue {
    const items: OutboundEvent[] = [];
    return {
        enqueue(event) {
            items.push(event);
        },
        drain() {
            return items.splice(0, items.length);
        },
        size() {
            return items.length;
        },
    };
}
