# Reliable SDK — Core Features

Per-feature scope + build order. Sections are ordered in the sequence we'll
actually implement them. Within each section, the bullets are the concrete
build steps (not a wishlist).

---

## 0. Foundations (build first — everything else depends on it)

Everything the three feature groups need before a single event can fly.

### 0.1 Init API
- Single entry: `reliable.init({ publicKey, endpoint?, sampleRate?, debug? })`.
- `endpoint` defaults to `https://ingest.reliable.dev/v1` (dev override allowed).
- Throws synchronously on missing `publicKey` — fail loud in dev, never silent.
- Idempotent: calling `init` twice is a no-op with a console warning.
- After init, `reliable` is a singleton holding: config, session, transport, scrubbers.

### 0.2 Session management (critical — shared by every event)
The session is the anchor every event hangs off. Get this wrong and
per-session metrics (bounce rate, duration, engaged sessions) all break.

A session is one **visit**: every tab of the same browser shares it, and it
ends after 30 minutes without user activity. This is the definition analytics
tools use, and what makes visit counts, bounce rate and returning visitors
mean what they say.

1. On `init`, read `localStorage['reliable:session']`. If it is empty, adopt a
   session an older SDK left in `sessionStorage` (so upgrading does not split
   a visit in two), then remove the old key.
2. If present and not idle-expired → **reuse it**. Refreshes, route changes,
   new tabs and links opened in new tabs all keep the same `session_uuid`.
3. If absent or expired → generate a new `session_uuid` (UUIDv4), stamp
   `started_at = now`, `last_active_at = now`, persist to `localStorage`.
   Loading a page is activity.
4. On every page load, fire `POST /ingest/sessions` (an idempotent upsert; the
   backend keeps the first values it saw). The payload carries the visitor id,
   `is_bot` (crawler user agent or `navigator.webdriver`), the real SDK
   version, and `initial_referrer`, which is only set when the referrer is
   another site and the session starts with this page load.
5. **Only user activity extends the session**: page views, custom events,
   `identify()`, dead/rage clicks, and pointer, key, touch and scroll input
   (throttled to one update per 10s, written to storage at most every 5s).
   Background events (network, WebSocket, errors, vitals) attach to the
   current session without extending it.
6. **Idle rotation**: if `now - last_active_at > 30 min`, the next *activity*
   rotates to a new `session_uuid` and opens a new session row. Background
   events never rotate: a tab left open with polling must not open a fresh
   "visit" every 30 minutes with nobody there.
7. **Hard rotation on identify change**: if `identify()` is called with a
   different user than the current session is tied to, rotate.
8. Tabs stay in sync through storage: every read adopts a session another tab
   started, so the whole browser moves to the new visit together.

### 0.3 Transport (batching + delivery)
- In-memory queue, flushed on these triggers:
  - Batch size ≥ 20 events
  - 5s debounce after last enqueue
  - `visibilitychange` → `hidden`
  - `pagehide` / `beforeunload`
- Delivery preference:
  1. `navigator.sendBeacon` when available and payload < 64KB (survives unload).
  2. `fetch(..., { keepalive: true })` fallback.
  3. Regular `fetch` for non-unload flushes.
- Retry: single retry with 500ms backoff on network failure, then drop.
  (Don't build an offline queue in v1 — too much state, too little return.)
- Auth: `x-reliable-key: <publicKey>` on every request.
- Every event carries a client-generated `uuid` (UUIDv4) for idempotency.

### 0.4 Sampling
- At `init`, roll a per-session dice: `Math.random() * 100 < sampleRate`.
- If the session loses the roll, the SDK goes into "dark mode":
  transport is a no-op, but hooks still install so identify / tags work.
- Decision is cached on the session object — every event in the session
  is kept or dropped together (no half-sampled sessions). Replays too.
- The project's **sample rate setting** (dashboard) applies on top,
  server-side: the backend decides per session from its UUID, drops
  everything for sampled-out sessions, and answers the session start with
  `sampled: false`. The SDK then drops that session's queued events and
  marks it dark, so it stops sending after its first request.

### 0.5 Scope & identify
- `reliable.identify({ externalId, email?, name?, traits? })` → attaches
  user to current session; fires `POST /ingest/identify`.
- `reliable.setTag(key, value)` / `setTags({})` → merged into every event.
- `reliable.addBreadcrumb({ category, message, level, data })` → in-memory
  ring buffer of last 30, attached to error events for context. Clicks
  (selector, tag, coordinates, never text) and route changes are added
  automatically. An error is only attributed to a click or route change
  from the last second.

### 0.6 Scrubbers
- PII regex on strings: email, credit card, SSN-ish patterns → replaced with `[redacted]`.
- URL sanitizer: redact query params in a denylist (`token`, `auth`, `sid`, etc.).
- Path scrubber: every page path the SDK reports (`getCurrentPath()`,
  navigation from/to, the session's entry path and referrer) redacts those
  params and removes emails, including percent-encoded ones.
- Selector scrubber: emails removed, UUIDs and long digit runs collapsed.
- Header denylist on network capture: never send `Authorization`, `Cookie`, `Set-Cookie`.
- Pluggable: `init({ beforeSend: (event) => event | null })` lets the app
  drop or mutate events before they leave.

---

## 1. Core Web Vitals

Report Google's Core Web Vitals tied to the route where they happened.

### What we capture
- **LCP** (Largest Contentful Paint) — ms
- **CLS** (Cumulative Layout Shift) — unitless
- **INP** (Interaction to Next Paint) — ms
- **FCP** (First Contentful Paint) — ms
- **TTFB** (Time to First Byte) — ms

Each metric carries: `metric`, `value`, `rating` (`good` / `needs_improvement` /
`poor`), `path` (the route the metric was measured on), `occurred_at`.

### Build steps
1. Depend on the official [`web-vitals`](https://github.com/GoogleChrome/web-vitals) library (tiny, maintained by Google).
2. In `vitals/index.ts`, expose `initVitals(ctx)` — called from `init` if
   `capture_vitals` is on.
3. Register each metric with its `on*` subscriber: `onLCP`, `onCLS`, `onINP`,
   `onFCP`, `onTTFB`. Use `reportAllChanges: false` — we only want the final
   value per page, not every intermediate snapshot.
4. In each callback:
   - Snapshot `path = location.pathname` (the route the metric is actually
     measured on — important for SPA navigations, route changes later get
     their own vitals window).
   - Map `rating` from web-vitals' built-in rating.
   - Enqueue `{ uuid, session_uuid, metric, value, rating, path, occurred_at }`.
5. **SPA route changes**: on navigation (`push` / `replace` / `pop`), call
   `web-vitals`'s per-route APIs where available; for metrics that are
   page-load-only (LCP, FCP, TTFB), only the initial route gets them.
6. Honor `capture_vitals` flag: if false, skip registration entirely.

---

## 2. Errors & Network

### 2A. Errors

Catch uncaught JS errors and unhandled promise rejections; attach breadcrumbs.

**What we capture**
- `message`, `stack`, `type` (`js` / `unhandled_promise`)
- `filename`, `lineno`, `colno`
- `fingerprint` — hash of `(message + top stack frame)` so the server can
  group occurrences into error_groups.
- `breadcrumbs` — last 30 entries from the scope ring buffer
- `path`, `occurred_at`

**Build steps**
1. Install `window.addEventListener('error', ...)` for sync errors.
2. Install `window.addEventListener('unhandledrejection', ...)` for promise errors.
3. Normalize both into a single `CapturedError` shape.
4. Generate `fingerprint` client-side (cheap sha1 of message + first stack line).
5. **De-dup throttle**: if the same fingerprint fired in the last 5s, drop it
   (prevents render-loop floods from killing the queue).
6. Attach current breadcrumbs + tags + user from scope.
7. Enqueue → `POST /ingest/errors`.
8. Source maps: out of scope in v1. We send raw stacks; symbolication can
   happen server-side later.

### 2B. Network

Monkey-patch `fetch` and `XMLHttpRequest` on init.

**What we capture**
- `method`, `url` (scrubbed), `status`, `duration_ms`, `size_bytes`
- `failed` (boolean: network error or status ≥ 400)
- `initiator` (`fetch` / `xhr`)
- `path` (the app route that triggered it), `occurred_at`

**Build steps**
1. On `init`, save originals: `originalFetch = window.fetch`, same for XHR.
2. Replace `window.fetch` with a wrapper that:
   - Records `start = performance.now()`.
   - Calls through to `originalFetch`.
   - On success → `status`, `duration_ms`, `size_bytes` from content-length.
   - On throw → `failed: true`, synthetic status 0.
   - Runs URL scrubber before enqueuing.
3. XHR: wrap `open` to stash method+url, wrap `send` to attach `loadend`
   listener that records status + duration.
4. **Default sampling**: only enqueue failures (status ≥ 400 or thrown).
   Opt-in full sampling via `init({ captureAllRequests: true })`.
5. **Self-ignore**: any request whose URL starts with the ingest endpoint
   is skipped (otherwise we'd infinite-loop reporting our own POSTs).
6. Enqueue → `POST /ingest/network`.

---

## 3. Business & UX Metrics

### 3A. Clicks (dead + rage)

Detect frustration clicks — the cheapest UX signal that "something is broken
but isn't throwing an error".

**Dead click** = user clicks something, nothing happens.
**Rage click** = user clicks the same spot repeatedly out of frustration.

**What counts**
- Only elements whose job is to act when clicked are judged: `a[href]`,
  `button`, `input[type=button|submit|reset|image]`, `summary`, and
  `[role=button|link|menuitem|tab]`. Text fields, checkboxes, selects and
  iframes are not: focusing a field changes nothing in the DOM, and counting
  them made about half of all dead clicks false.
- Ignored: non-primary buttons, clicks with ctrl/cmd/shift/alt, and links
  that open elsewhere by design (`target=_blank`, `download`, `mailto:`,
  `tel:`, `sms:`).

**Build steps**
1. Install a single `document.addEventListener('click', handler, true)` in
   capture phase so we see the click before React handlers run.
2. Group rapid clicks on the same element into a **burst** (each within
   1000ms of the previous).
3. While a burst is pending, watch for any **response**: a DOM mutation
   anywhere in the document, a URL change, a scroll, focus moving to another
   element or window, or a network request starting (the network module
   marks request starts; completed resource timings are the fallback).
4. 1000ms after the burst's last click, with no response since its first
   click: 3 or more clicks → one `kind: 'rage'` with `rage_click_count`;
   otherwise one `kind: 'dead'` per click. Any response → nothing is sent,
   however fast the clicks were (a working +/- stepper is not rage).
5. Leaving the page is a response: pending bursts are dropped on `pagehide`.
6. Build a **compact CSS selector** for the element: tag + id if present,
   else tag + class list (truncated), walking up max 4 ancestors. Cap total
   length at 200 chars.
7. Enqueue → `POST /ingest/clicks`.

### 3B. Navigation

Track route changes in SPAs and traditional apps.

**What we capture**
- `kind` (`initial` | `push` | `replace` | `pop` | `reload`)
- `from_path`, `to_path`, `occurred_at`
- Bumps `page_views_count` on the session server-side (already handled in
  `recordNavigation`, and only once per event even when a retry repeats it).
- A history change is only reported when the **pathname** changes.
  Rewriting just the query string (search boxes, filters, pagination) keeps
  the visitor on the same page, so it is not a page view. The tracked current
  path still follows the full URL for errors and vitals.

**Build steps**
1. On `init`:
   - Emit `initial` with `to_path = location.pathname` and `from_path = null`.
   - Detect reload via `performance.getEntriesByType('navigation')[0].type === 'reload'`.
2. Monkey-patch `history.pushState` and `history.replaceState`:
   - Before calling original, snapshot `from_path`.
   - After calling original, emit `push` or `replace` with new `to_path`
     when the pathname changed.
3. Listen for `popstate` → emit `pop` when the pathname changed.
4. Crucially: **re-arm Core Web Vitals** on each push/replace so per-route
   vitals work on SPAs (see vitals section 5).
5. Enqueue → `POST /ingest/navigation`.

### 3C. Sessions wiring (bounce, duration, page views)

These aren't a feature to "build" — they fall out of sessions + navigation +
activity signals the server already rolls up. The SDK just needs to make
sure those signals flow:

The backend computes these over **visits**: human (non-bot) sessions with
at least one page view.

- `bounce_rate`: visits with exactly one page view. Our job: make sure the
  **initial** navigation event always fires.
- `avg_duration`: from the session start to its last engagement signal (page
  views, vitals, dead/rage clicks, custom events) on the client clock. Our
  job: send accurate client timestamps; background events are not engagement.
- `page_views`: page loads plus history changes that change the pathname.
  Our job: emit exactly those from the navigation tracker.
- Nothing is sent while a page is being prerendered; the queue is held until
  the page is shown (`prerenderingchange`) or dropped if it never is.

No new endpoints — just verify these three signals stay honest once the
above features are wired.

---

## Build order (explicit)

1. **Foundations** (0.1 → 0.6). Nothing else works without these.
2. **Navigation** (3B) — unlocks correct `path` tagging for every other feature.
3. **Core Web Vitals** (1) — small, well-scoped, library does most of the work.
4. **Errors** (2A) — also small, independent.
5. **Network** (2B) — touchier (monkey-patching fetch + self-ignore).
6. **Clicks** (3A) — the most heuristic feature, last.
7. **Sessions wiring sanity pass** (3C) — verify bounce/duration/PV rollups
   look right end-to-end.

**Out of scope for v1**: source map symbolication, offline event queue,
React component stack traces.

---

## 4. Session Replay

Always-on DOM recording kept in IndexedDB. When an error or another notable
event fires, the SDK uploads the recording of the moments before it. The
backend stores it as is in R2, and the dashboard and the engineer app replay
it in the viewer with `rrweb-player`. Nothing is rendered to video on the
server (ADR 0006 in reliable-architecture has the history).

### 4.0 Architecture overview

```
Browser (SDK)                        Backend                        Viewers
─────────────                        ───────                        ───────
rrweb records the page, with a       POST /ingest/replays           Dashboard: GET .../replays/:chunk/events
full snapshot every 30s               ↓                               → DecompressionStream('deflate')
  ↓                                  zlib blob → R2                   → rrweb-player
IndexedDB, per tab, ~110s kept       replay-raw/{fp}/{session}/     Engineer app: GET /mobile/incidents/:uid/
  ↓                                    {chunk}.gz                     replay/:chunk/events
On error / rage or dead click /      replay_chunks row                → inflate in Dart → WebView
failed request:                        (status 'pending')               → bundled rrweb-player
  POST from the snapshot before       ↓
  the last 60s                       PATCH /ingest/replays/:chunk
  +10s: PATCH with the extended        replaces the blob
  recording
```

### 4.1 SDK: recording and buffer

**Library**: [`rrweb`](https://github.com/rrweb-io/rrweb) 2.x.

1. On `init`, if `captureReplay` is enabled, start `rrweb.record()` with
   `checkoutEveryNms: 30_000`: besides the snapshot at start, rrweb takes a
   fresh full snapshot (Meta + FullSnapshot events) at most 30s after the
   previous one while the page keeps changing. A replay can only start from
   a snapshot; up to 1.5.0 there was just the one at page load, so errors
   more than a minute into a visit uploaded changes with nothing to apply
   them to (about 60% of production chunks replayed as a blank frame).
2. Events are written to **IndexedDB** in batches every 500ms, then
   everything older than ~110s (60s window + 10s post-incident + one 30s
   snapshot interval + margin) is pruned.
   - DB name: `reliable_replay_v2`, object store: `events`, indexed by
     `timestamp` (pruning) and `[tab, timestamp]` (reads).
   - **Per tab**: every event is stored with the recording tab's id (kept
     in `sessionStorage`, so it survives reloads of that tab), and a flush
     reads only its own tab. The database is shared by every tab of the
     site, so without this two open tabs mixed into one replay.
3. **Trigger flush**: when the error, click or network module reports
   something, and only for sampled sessions, and not within 10s of the
   previous flush:
   - Read this tab's events from the last snapshot at or before `now - 60s`
     (so the chunk is 60-90s long and starts with a snapshot). If the page
     has not changed for long enough that no snapshot is left, take one
     now: the page looks the same as before.
   - Compress with `pako.deflate` (zlib format).
   - POST to `/ingest/replays` with `{ session_uuid, trigger_event_uuid,
     started_at, ended_at, snapshot_count, compressed_events (base64) }`.
   - 10s later, PATCH `/ingest/replays/:chunk` with everything from the same
     snapshot to now, so the chunk shows what happened right after too.
     Closing the tab before then keeps the initial upload.
4. **Size guard**: if the compressed payload exceeds 5MB, drop the older
   half, cutting at a snapshot so it still replays. A single event over 5MB
   is not uploaded.
5. **Privacy**: `maskAllInputs: true` (every input value is recorded as
   `*`). Page text is recorded as is except inside `[data-rl-mask]`, which
   is masked, and `[data-rl-block]` elements are not recorded at all (an
   empty box of the same size). `data-rr-mask` and `data-rr-block` work the
   same (older docs used those names).
6. **Performance**: while the page is hidden nothing is stored. When it
   becomes visible again the SDK takes a fresh snapshot, because changes made
   while hidden were not recorded.

### 4.2 Backend

- `POST /ingest/replays` (public key + origin check): uploads the blob to R2
  under `replay-raw/{frontend_project_id}/{session_uuid}/{chunk_uuid}.gz`
  (zlib despite the extension), inserts a `replay_chunks` row with
  `status = 'pending'`, returns the chunk uuid.
- `PATCH /ingest/replays/:chunkUuid`: replaces the blob with the extended
  recording while the row is still `pending`.
- `GET /projects/:projectId/frontend-projects/:uuid/replays/:chunkUuid/events`
  (dashboard) and `GET /mobile/incidents/:uid/replay/:chunkUuid/events`
  (engineer app) stream the stored bytes unchanged, scoped to the caller's
  project. The server never decompresses a recording.
- `replay_chunks.status` and `video_url` are kept for an optional later
  processing step (videos, thumbnails). None runs today, so chunks stay
  `pending`, and viewers never wait on them.

### 4.3 Viewers

- **Dashboard** (error detail → Session replay): pressing play fetches the
  events, inflates them with the browser's `DecompressionStream`, and mounts
  `rrweb-player`, which rebuilds the page in a sandboxed iframe where none of
  the recorded page's scripts run.
- **Engineer app**: inflates in Dart (older iOS WebViews lack
  `DecompressionStream`) and passes the JSON to a WebView running the same
  player from bundled assets.
- A chunk with no full snapshot (recorded by 1.5.0 or earlier, more than a
  minute into a visit) cannot be replayed; both viewers say so instead of
  showing a blank frame.
