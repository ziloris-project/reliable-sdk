// Bounded-memory sketch aggregator — one instance per WebSocket
// connection. Accumulates everything the L2/L3 anomaly engine needs
// (per-fingerprint counts, size & inter-message-delay sketches, and the
// from→to adjacency graph) without ever touching payload contents.
//
// On `close`, `toEnvelope()` produces the JSON shape posted to the
// backend's `/websocket/sketch` endpoint.
//
// Memory budget: capped at ~16 distinct fingerprints per direction
// before excess collapses into `__other__`. Each fingerprint carries
// two DDSketches (size, delay). Adjacency graph capped at 8 sources ×
// 4 successors. Real-world per-session envelope: 4-8KB JSON.

import type { WSMessageData } from './fingerprint';
import { extractFingerprint } from './fingerprint';

// ── DDSketch (log-bucketed percentile estimator) ────────────────────────
//
// Single-buffer DDSketch with relative-error guarantee alpha. Buckets are
// integer indices in a Map; bucket i covers values in
// (gamma^(i-1), gamma^i]. Zero gets its own counter — Math.log(0) = -Inf.
//
// Mergeable across sessions by simply summing the bucket maps — this is
// the property that lets the backend EWMA percentiles into a project-wide
// rollup. Per-percentile values stored on the rollup table are derived
// from the merged sketch, not stored separately.

export const DEFAULT_ALPHA = 0.05;   // 5% relative error — good for both ms delays and KB sizes

export class DDSketch {
    readonly alpha: number;
    readonly gamma: number;
    readonly logGamma: number;
    private readonly buckets = new Map<number, number>();
    private zeroCount = 0;
    private _count = 0;
    private _min: number | null = null;
    private _max: number | null = null;

    constructor(alpha: number = DEFAULT_ALPHA) {
        this.alpha = alpha;
        this.gamma = (1 + alpha) / (1 - alpha);
        this.logGamma = Math.log(this.gamma);
    }

    get count(): number { return this._count; }

    add(value: number): void {
        if (!Number.isFinite(value) || value < 0) return;
        this._count++;
        this._min = this._min === null || value < this._min ? value : this._min;
        this._max = this._max === null || value > this._max ? value : this._max;

        if (value === 0) {
            this.zeroCount++;
            return;
        }
        const idx = Math.ceil(Math.log(value) / this.logGamma);
        this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + 1);
    }

    /** Inverse-CDF percentile. q in [0, 1]. Returns NaN on empty. */
    percentile(q: number): number {
        if (this._count === 0) return NaN;
        const target = q * this._count;
        let running = this.zeroCount;
        if (running >= target) return 0;
        const sorted = [...this.buckets.entries()].sort((a, b) => a[0] - b[0]);
        for (const [idx, n] of sorted) {
            running += n;
            if (running >= target) {
                // Mid-bucket point. Gives bounded relative error <= alpha.
                return Math.pow(this.gamma, idx) * 2 / (1 + this.gamma);
            }
        }
        return this._max ?? NaN;
    }

    /** Wire form. The backend deserialises and merges. */
    toJSON(): SerializedSketch {
        return {
            a: this.alpha,
            n: this._count,
            z: this.zeroCount,
            mn: this._min,
            mx: this._max,
            b: [...this.buckets.entries()],
        };
    }
}

export interface SerializedSketch {
    a: number;                       // alpha
    n: number;                       // total count
    z: number;                       // zero-bucket count
    mn: number | null;               // min observed
    mx: number | null;               // max observed
    b: Array<[number, number]>;      // [bucket_index, count] pairs
}

// ── Top-K fingerprint table (Misra-Gries with overflow → __other__) ─────
//
// Real WS protocols are low-cardinality: a chat app has ~10 message
// shapes, a trading desk has ~20. Top-K capped at 16 per direction
// catches them with room to spare; the rare project that genuinely has
// more is the __other__ ratio detector's job to flag.

export const TOP_K_PER_DIRECTION = 16;
export const OTHER_FP = '__other__';

interface FingerprintStat {
    direction:    'in' | 'out';
    count:        number;
    sizeSketch:   DDSketch;
    delaySketch:  DDSketch;
    lastObservedAtMs: number | null;
}

// ── Adjacency tracker (the L3 sequence graph) ───────────────────────────
//
// When an outbound is observed, it's pushed onto a rolling buffer with
// its timestamp. The next inbound within ADJACENCY_WINDOW_MS is attributed
// as the "response" to the most recent outbound. We don't try to be
// clever about request/response pairing — most protocols are single-track
// enough that "most recent outbound → next inbound" gets >80% accurate
// on real traffic, and the L3 anomaly fires on aggregate drift not single
// pair correctness.
//
// Capped: 8 source fingerprints × 4 successors each = 32 edges max.

export const ADJACENCY_WINDOW_MS = 5_000;
export const TOP_K_ADJACENCY_FROM = 8;
export const TOP_K_ADJACENCY_TO   = 4;

interface AdjacencyEdge {
    count:        number;
    delaySketch:  DDSketch;
}

interface PendingSend {
    fp:   string;
    atMs: number;
}

// ── SessionAggregator ───────────────────────────────────────────────────

export interface SessionEnvelope {
    fingerprints: Array<{
        direction:        'in' | 'out';
        fingerprint:      string;
        count:            number;
        size_sketch:      SerializedSketch;
        delay_sketch:     SerializedSketch;
    }>;
    adjacency: Array<{
        from_fp:          string;
        to_fp:            string;
        count:            number;
        delay_sketch:     SerializedSketch;
    }>;
    /** Total messages observed (sum of fingerprint counts, including __other__). */
    total_messages_in:    number;
    total_messages_out:   number;
}

export class SessionAggregator {
    private readonly fingerprints = new Map<string, FingerprintStat>();
    private readonly adjacency    = new Map<string, Map<string, AdjacencyEdge>>();
    /** Sliding window of recent outbound messages, oldest first. */
    private readonly pendingSends: PendingSend[] = [];

    private totalIn  = 0;
    private totalOut = 0;

    /** Convenience for the SDK side — extracts fingerprint and dispatches. */
    observeOutgoing(data: WSMessageData, sizeBytes: number, atMs: number): void {
        const fp = extractFingerprint(data);
        this.observeOutboundFingerprint(fp, sizeBytes, atMs);
    }

    observeIncoming(data: WSMessageData, sizeBytes: number, atMs: number): void {
        const fp = extractFingerprint(data);
        this.observeInboundFingerprint(fp, sizeBytes, atMs);
    }

    // Public for tests / direct callers that already have a fingerprint.
    observeOutboundFingerprint(fp: string, sizeBytes: number, atMs: number): void {
        this.totalOut++;
        const stat = this.statFor('out', fp);
        this.recordObservation(stat, sizeBytes, atMs);

        // Push onto the pending-send buffer for adjacency attribution.
        // We never attribute __other__ as a source — it's a junk bucket.
        if (stat.direction === 'out' && this.fingerprintKey(fp, 'out') !== this.otherKey('out')) {
            this.pendingSends.push({ fp, atMs });
            this.trimPendingSends(atMs);
        }
    }

    observeInboundFingerprint(fp: string, sizeBytes: number, atMs: number): void {
        this.totalIn++;
        const stat = this.statFor('in', fp);
        this.recordObservation(stat, sizeBytes, atMs);

        // Attribute this inbound to the most recent eligible outbound,
        // if any, and record the edge with the round-trip delay.
        this.trimPendingSends(atMs);
        const responseTo = this.pendingSends[this.pendingSends.length - 1];
        if (!responseTo) return;

        const delay = Math.max(0, atMs - responseTo.atMs);
        this.recordAdjacency(responseTo.fp, fp, delay);

        // Pop — one outbound matches one inbound. Approximate, but stops
        // a single outbound from "claiming" every following inbound for
        // the remainder of the window.
        this.pendingSends.pop();
    }

    toEnvelope(): SessionEnvelope {
        const fingerprints: SessionEnvelope['fingerprints'] = [];
        for (const stat of this.fingerprints.values()) {
            const fpKey = this.findFpKeyFor(stat);
            if (!fpKey) continue;
            fingerprints.push({
                direction:    stat.direction,
                fingerprint:  fpKey,
                count:        stat.count,
                size_sketch:  stat.sizeSketch.toJSON(),
                delay_sketch: stat.delaySketch.toJSON(),
            });
        }

        const adjacency: SessionEnvelope['adjacency'] = [];
        for (const [from, edges] of this.adjacency) {
            for (const [to, edge] of edges) {
                adjacency.push({
                    from_fp:      from,
                    to_fp:        to,
                    count:        edge.count,
                    delay_sketch: edge.delaySketch.toJSON(),
                });
            }
        }

        return {
            fingerprints,
            adjacency,
            total_messages_in:  this.totalIn,
            total_messages_out: this.totalOut,
        };
    }

    // ── Internals ────────────────────────────────────────────────────────

    private fingerprintKey(fp: string, direction: 'in' | 'out'): string {
        return `${direction}:${fp}`;
    }

    private otherKey(direction: 'in' | 'out'): string {
        return this.fingerprintKey(OTHER_FP, direction);
    }

    /**
     * Return (creating if needed) the FingerprintStat to record this
     * observation against. When the per-direction map is at capacity AND
     * the fingerprint is novel, the observation collapses into the
     * synthetic `__other__` bucket — which is itself counted against
     * one of the K slots (always pre-allocated implicitly).
     */
    private statFor(direction: 'in' | 'out', fp: string): FingerprintStat {
        const directKey = this.fingerprintKey(fp, direction);
        const existing = this.fingerprints.get(directKey);
        if (existing) return existing;

        const currentDirCount = this.countForDirection(direction);
        // -1 because __other__ permanently reserves a slot once it appears.
        const cap = TOP_K_PER_DIRECTION;
        const hasOther = this.fingerprints.has(this.otherKey(direction));
        const freeSlots = cap - currentDirCount;

        if (fp === OTHER_FP || freeSlots > (hasOther ? 0 : 1)) {
            const stat = this.makeStat(direction);
            this.fingerprints.set(directKey, stat);
            return stat;
        }

        // No room. Fall through to __other__.
        const otherKey = this.otherKey(direction);
        const otherStat = this.fingerprints.get(otherKey);
        if (otherStat) return otherStat;
        const fresh = this.makeStat(direction);
        this.fingerprints.set(otherKey, fresh);
        return fresh;
    }

    private makeStat(direction: 'in' | 'out'): FingerprintStat {
        return {
            direction,
            count: 0,
            sizeSketch:  new DDSketch(),
            delaySketch: new DDSketch(),
            lastObservedAtMs: null,
        };
    }

    private recordObservation(stat: FingerprintStat, sizeBytes: number, atMs: number): void {
        stat.count++;
        stat.sizeSketch.add(sizeBytes);
        if (stat.lastObservedAtMs !== null) {
            stat.delaySketch.add(Math.max(0, atMs - stat.lastObservedAtMs));
        }
        stat.lastObservedAtMs = atMs;
    }

    private countForDirection(direction: 'in' | 'out'): number {
        let n = 0;
        for (const stat of this.fingerprints.values()) {
            if (stat.direction === direction) n++;
        }
        return n;
    }

    private findFpKeyFor(stat: FingerprintStat): string | null {
        for (const [key, value] of this.fingerprints) {
            if (value === stat) {
                // key = "direction:fingerprint" — return just the fingerprint part.
                return key.slice(key.indexOf(':') + 1);
            }
        }
        return null;
    }

    private trimPendingSends(nowMs: number): void {
        const cutoff = nowMs - ADJACENCY_WINDOW_MS;
        while (this.pendingSends.length > 0 && this.pendingSends[0]!.atMs < cutoff) {
            this.pendingSends.shift();
        }
    }

    private recordAdjacency(fromFp: string, toFp: string, delayMs: number): void {
        let edges = this.adjacency.get(fromFp);

        if (!edges) {
            if (this.adjacency.size >= TOP_K_ADJACENCY_FROM) {
                // Source-side cap reached. Drop the edge — losing rare
                // sources is better than letting the graph grow unbounded.
                return;
            }
            edges = new Map();
            this.adjacency.set(fromFp, edges);
        }

        let edge = edges.get(toFp);
        if (!edge) {
            if (edges.size >= TOP_K_ADJACENCY_TO) return;
            edge = { count: 0, delaySketch: new DDSketch() };
            edges.set(toFp, edge);
        }
        edge.count++;
        edge.delaySketch.add(delayMs);
    }
}
