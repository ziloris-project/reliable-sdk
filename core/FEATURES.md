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

1. On `init`, read `sessionStorage['reliable:session']`.
2. If present and not idle-expired → **reuse it**. Refreshes, route changes,
   and tab-internal navigation all keep the same `session_uuid`.
3. If absent or expired → generate a new `session_uuid` (UUIDv4), stamp
   `started_at = now`, `last_active_at = now`, persist to `sessionStorage`.
4. First time a new session is created, fire `POST /ingest/sessions` with
   `{ uuid, started_at, user_agent, viewport, referrer, entry_path, language, timezone }`.
5. On every captured event, bump `last_active_at` in `sessionStorage`.
6. **Idle rotation**: if `now - last_active_at > 30 min`, treat the session
   as expired on the next event → rotate to a new `session_uuid` and open a
   new session row. (The old one is already persisted server-side; nothing
   to close out.)
7. **Hard rotation on identify change**: if `identify()` is called with a
   different user than the current session is tied to, rotate.
8. `sessionStorage` (not `localStorage`) so closing the tab ends the
   session naturally; hard refresh keeps it.

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
  is kept or dropped together (no half-sampled sessions).

### 0.5 Scope & identify
- `reliable.identify({ externalId, email?, name?, traits? })` → attaches
  user to current session; fires `POST /ingest/identify`.
- `reliable.setTag(key, value)` / `setTags({})` → merged into every event.
- `reliable.addBreadcrumb({ category, message, level, data })` → in-memory
  ring buffer of last 30, attached to error events for context.

### 0.6 Scrubbers
- PII regex on strings: email, credit card, SSN-ish patterns → replaced with `[redacted]`.
- URL sanitizer: strip query params in a denylist (`token`, `auth`, `sid`, etc.).
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

**Build steps**
1. Install a single `document.addEventListener('click', handler, true)` in
   capture phase so we see the click before React handlers run.
2. On click, record `{ target, selector, path, timestamp, x, y }`.
3. **Rage detection**:
   - Keep a small ring of recent clicks (last 5).
   - If ≥3 clicks on the same `selector` within 1000ms → emit `kind: 'rage'`.
4. **Dead detection** (harder — requires waiting):
   - After a click, set a 300ms timeout.
   - Listen for signs of life during that window: DOM mutation near target
     (MutationObserver scoped to `target.closest('...')`), any `navigation`
     event, any fetch/XHR started.
   - If the timeout fires with no signs of life → emit `kind: 'dead'`.
   - Cancel the timeout if any sign fires.
5. Build a **compact CSS selector** for `target`: tag + id if present, else
   tag + class list (truncated), walking up max 4 ancestors. Cap total
   length at 200 chars.
6. Don't emit dead-click if the element is obviously non-interactive
   (plain `<div>` with no handlers, text, etc. — short allowlist of
   clickable tags: `a`, `button`, `input`, `select`, `[role=button]`,
   anything with `onClick`).
7. Enqueue → `POST /ingest/clicks`.

### 3B. Navigation

Track route changes in SPAs and traditional apps.

**What we capture**
- `kind` (`initial` | `push` | `replace` | `pop` | `reload`)
- `from_path`, `to_path`, `occurred_at`
- Bumps `page_views_count` on the session server-side (already handled in
  `recordNavigation`).

**Build steps**
1. On `init`:
   - Emit `initial` with `to_path = location.pathname` and `from_path = null`.
   - Detect reload via `performance.getEntriesByType('navigation')[0].type === 'reload'`.
2. Monkey-patch `history.pushState` and `history.replaceState`:
   - Before calling original, snapshot `from_path`.
   - After calling original, emit `push` or `replace` with new `to_path`.
3. Listen for `popstate` → emit `pop`.
4. Crucially: **re-arm Core Web Vitals** on each push/replace so per-route
   vitals work on SPAs (see vitals section 5).
5. Enqueue → `POST /ingest/navigation`.

### 3C. Sessions wiring (bounce, duration, page views)

These aren't a feature to "build" — they fall out of sessions + navigation +
activity signals the server already rolls up. The SDK just needs to make
sure those signals flow:

- `bounce_rate`: derived server-side from sessions with `page_views_count <= 1`.
  Our job: make sure the **initial** navigation event always fires.
- `avg_duration`: derived from `last_active_at - started_at`. Our job:
  keep bumping `last_active_at` on every event (already in foundations 0.2).
- `page_views`: bumped in `recordNavigation` for `initial` / `push` / `replace`.
  Our job: emit those accurately from the navigation tracker.

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

Always-on DOM recording with a 60-second sliding window stored in IndexedDB.
When an error or notable event fires, the SDK ships the buffered snapshots
to the backend, which queues a video-processing job. The processor converts
DOM/CSS snapshots into a playable video, uploads to R2, and links the video
URL back to the originating event.

### 4.0 Architecture overview

```
Browser (SDK)                   Backend                    Worker / Queue
─────────────                   ───────                    ──────────────
rrweb records DOM mutations     POST /ingest/replays       BullMQ job picks up
  ↓                               ↓                         ↓
60s ring buffer in IndexedDB    Store raw snapshot JSON    Headless browser renders
  ↓                             in pg (or S3/R2 staging)   snapshots via rrweb-player
On error/event → flush buffer     ↓                         ↓
  → POST /ingest/replays        Enqueue video job          Encode to MP4/WebM
                                  ↓                         ↓
                                Job status tracked         Upload to R2
                                in replay_jobs table         ↓
                                  ↓                        PATCH replay_jobs
                                Link video_url back        with video_url
                                to error_events/sessions     ↓
                                                           Update error_events
                                                           with replay_url
```

### 4.1 SDK — DOM recording + IndexedDB buffer

**Library**: [`rrweb`](https://github.com/rrweb-io/rrweb) — battle-tested
DOM serializer. Records a full snapshot on start, then incremental mutations.

1. On `init`, if `capture_replay` is enabled, start `rrweb.record()`.
2. Feed every rrweb event into a **60-second sliding-window ring buffer**.
   - Each event has a timestamp. On every new event, prune entries older
     than `now - 60_000ms`.
3. Store the ring buffer in **IndexedDB** (not memory alone) so it
   survives soft navigations and doesn't balloon the JS heap.
   - DB name: `reliable_replay`, object store: `events`.
   - Write in batches (every 500ms or 50 events, whichever comes first)
     to reduce IDB write pressure.
   - On prune, delete old entries by timestamp index.
4. **Trigger flush** — when the error module or any notable event fires:
   - Read the full 60s window from IndexedDB.
   - Compress with `pako` (gzip) to keep payload size sane.
   - POST to `/ingest/replays` with `{ session_uuid, trigger_event_uuid,
     started_at, ended_at, snapshot_count, compressed_events (base64) }`.
   - Clear the sent range from IDB so it's not double-sent.
5. **Size guard**: if the compressed payload exceeds 5MB, truncate oldest
   events until it fits. Log a warning.
6. **Privacy**: rrweb has built-in masking (`maskAllInputs: true`,
   `maskTextSelector: '[data-rl-mask]'`). Enable by default, let
   integrators customize via `init({ replayMaskSelector })`.
7. **Performance budget**: rrweb's mutation observer is lightweight but
   not free. If the page is in `hidden` state, pause recording (no
   point capturing an invisible tab). Resume on `visibilitychange`.

### 4.2 Backend — ingest endpoint + job queue

#### 4.2.1 Database schema

```sql
-- Stores raw snapshot data and tracks processing status.
CREATE TABLE replay_chunks (
    id                 BIGSERIAL PRIMARY KEY,
    uuid               UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    frontend_project_id BIGINT NOT NULL REFERENCES frontend_projects(id),
    session_id         BIGINT NOT NULL REFERENCES sessions(id),
    trigger_event_uuid UUID,              -- the error/event that triggered this flush
    started_at         TIMESTAMPTZ NOT NULL,
    ended_at           TIMESTAMPTZ NOT NULL,
    snapshot_count     INT NOT NULL,
    compressed_size    INT NOT NULL,       -- bytes, for monitoring
    raw_storage_key    TEXT,               -- R2 key for raw snapshot JSON (if offloaded)
    video_url          TEXT,               -- R2 URL of the rendered video
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','done','failed')),
    error_message      TEXT,               -- failure reason if status = 'failed'
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at       TIMESTAMPTZ
);

CREATE INDEX idx_replay_chunks_session ON replay_chunks (session_id);
CREATE INDEX idx_replay_chunks_status  ON replay_chunks (status) WHERE status = 'pending';
```

#### 4.2.2 Ingest endpoint

- `POST /ingest/replays`
- Auth: same `ingestAuth` middleware (public key + origin check).
- Validate: `session_uuid`, `trigger_event_uuid`, `started_at`, `ended_at`,
  `snapshot_count`, `compressed_events` (base64 string).
- Steps:
  1. Resolve `session_id` via `resolveSessionId`.
  2. Upload the compressed blob to R2 staging bucket under
     `raw/{frontend_project_id}/{session_uuid}/{chunk_uuid}.gz`.
  3. INSERT into `replay_chunks` with `status = 'pending'`,
     `raw_storage_key` pointing to the R2 object.
  4. Enqueue a BullMQ job `{ chunk_uuid }` on the `replay-render` queue.
  5. Return `202 { chunk_uuid }`.

#### 4.2.3 Job queue (BullMQ + Redis)

- Queue name: `replay-render`.
- Job payload: `{ chunk_uuid }`.
- Concurrency: configurable (start with 2 workers).
- Retry: 3 attempts with exponential backoff.
- On failure after retries: mark `replay_chunks.status = 'failed'`
  with `error_message`.

### 4.3 Video processor worker

A standalone Node service (or same process, separate BullMQ worker).

1. **Fetch raw data**: download `raw_storage_key` from R2, decompress.
2. **Render**: spin up a headless browser (Puppeteer/Playwright),
   load an HTML page with `rrweb-player`, feed the events, play at
   real speed (or accelerated), capture via `page.screencast()` or
   `page.video()`.
   - Viewport: 1280x720 (configurable).
   - Duration: the actual event window (up to 60s).
3. **Encode**: output as MP4 (H.264, broad compatibility) or WebM.
   If using Playwright `page.video()`, it outputs WebM natively.
4. **Upload**: PUT the video to R2 production bucket under
   `videos/{frontend_project_id}/{session_uuid}/{chunk_uuid}.mp4`.
5. **Update DB**:
   - `UPDATE replay_chunks SET status='done', video_url=..., processed_at=NOW()`
   - If `trigger_event_uuid` is set, also:
     `UPDATE error_events SET replay_url=... WHERE uuid=trigger_event_uuid`
6. **Cleanup**: optionally delete the raw snapshot from R2 staging
   after successful render (or keep for re-processing).

### 4.4 Frontend — replay viewer

1. Error detail page already exists. Add a "Replay" tab/section.
2. If `error_events.replay_url` is set, render a `<video>` player
   with the R2 URL. Simple HTML5 video — no custom player needed.
3. If `replay_url` is null and a `replay_chunks` row exists with
   `status = 'processing'`, show a "Rendering..." spinner.
4. If `status = 'failed'`, show the error message with a "Retry" button
   that re-enqueues the job.
5. Session detail page: list all replay chunks for that session,
   each with a video thumbnail / play button.

### 4.5 R2 storage layout

```
reliable-replay-bucket/
├── raw/                          # staging — raw compressed snapshots
│   └── {project_id}/
│       └── {session_uuid}/
│           └── {chunk_uuid}.gz
└── videos/                       # production — rendered videos
    └── {project_id}/
        └── {session_uuid}/
            └── {chunk_uuid}.mp4
```

- Bucket lifecycle rule: delete `raw/` objects after 7 days (processed
  or not — if processing failed after 7 days, re-ingest is needed).
- Videos: no auto-delete. Retention follows the project's data retention
  policy (future feature).

### 4.6 Build order

1. **SDK replay module** (4.1) — rrweb recording + IndexedDB buffer +
   flush-on-error hook. Can be tested with the test harness before the
   backend exists (just log the payload).
2. **DB migration** — `replay_chunks` table + indexes.
3. **Ingest endpoint** — `POST /ingest/replays` + R2 raw upload.
4. **BullMQ queue setup** — Redis connection, queue definition, job
   enqueue in the ingest handler.
5. **Video processor worker** — headless browser render + R2 upload +
   DB update. This is the hardest piece — test in isolation first.
6. **Frontend viewer** — video player on error detail page.
7. **End-to-end test** — throw an error in the test harness, verify
   the full pipeline: SDK → ingest → queue → render → R2 → frontend.
