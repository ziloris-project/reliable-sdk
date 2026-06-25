---
"@reliableapp/frontend-core": minor
"@reliableapp/react": minor
---

WebSocket L2 + L3 anomaly engine SDK side.

`window.WebSocket` is now instrumented for structural fingerprinting:
every message contributes to a bounded-memory `SessionAggregator` that
tracks per-fingerprint counts, payload-size and inter-message-delay
sketches, and the from→to adjacency graph. On close, one sketch
envelope is emitted to the backend's new `/ingest/websocket/sketch`
endpoint alongside the existing L1 lifecycle event.

Payloads are never captured. Fingerprints are FNV-1a 64-bit hashes of
shape (sorted JSON keys + discriminator value, binary header bytes, or
digit-stripped text), so two messages with the same structure cluster
even when their values differ. Memory ceiling per connection: ~4–8KB
regardless of message volume.

Behind the existing `captureWebSockets` flag — already on by default
since `1.1.0`, no new config knob.
