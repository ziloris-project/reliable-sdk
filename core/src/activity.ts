// Small signals shared between feature modules without making them import
// each other. The network module marks every request it sees start; the
// click module reads that to tell a click that fired a request (a response)
// from one that did nothing. A request can take seconds to finish, so the
// start is what matters, not the completion.

let lastNetworkStartAt = Number.NEGATIVE_INFINITY;

/** Called by the network module when a fetch or XHR is sent. */
export function markNetworkStart(): void {
    lastNetworkStartAt = performance.now();
}

/** Whether any request started at or after `perfTime` (a performance.now() value). */
export function networkStartedSince(perfTime: number): boolean {
    return lastNetworkStartAt >= perfTime;
}
