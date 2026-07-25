---
"@reliableapp/frontend-core": minor
"@reliableapp/react": minor
---

Capture the signals that make the "business" metrics real instead of hollow:

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
