# @reliableapp/frontend-core

## 1.4.0

### Minor Changes

- 895908e: Capture the signals that make the "business" metrics real instead of hollow:

  - **Anonymous visitor id** — a persistent, first-party, anonymous UUID
    (localStorage) sent as `anonymous_id` on the session event. The session
    itself lives in sessionStorage (per-tab), so without this every tab and
    revisit looked like a new person; unique-visitor and returning cohorts are
    now real for anonymous traffic, not just `identify()`-ed users.
  - **Negotiated WebSocket subprotocol** — the SDK now captures `ws.protocol`
    (what the server accepted) in addition to the requested `protocols`.
  - **WebSocket unload flush** — connections still open at page unload are now
    flushed on `pagehide` (previously they were only recorded on `close`, so
    long-lived sockets that outlived the page were invisible — survivorship
    bias toward mid-session closes).

## 1.3.0

### Minor Changes

- b56c8b9: Correlate JS errors with the network request that caused them. When an error
  is triggered by a recently-finished request (api_response trigger), the SDK
  now attaches that request's event UUID (`network_event_uuid`) to the error
  payload, so the dashboard can link a JS error to its failing API call and show
  the request/response inline. Previously the recent-network buffer was used only
  to classify the trigger and the correlation was dropped.

## 1.2.0

### Minor Changes

- a405ed8: WebSocket L2 + L3 anomaly engine SDK side.

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
