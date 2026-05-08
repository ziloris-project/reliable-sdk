# @reliable — manual test harnesses

Stage-by-stage browser sandboxes that exercise the SDK against the local
backend. Each folder maps to one package (`core`, `react`) and grows as we
add features.

## Layout

```
tests/
├── core/        # plain HTML + @reliable/core
│   └── index.html
└── react/       # React app using @reliable/react (empty for now)
```

## Running `core/index.html`

1. Make sure the backend is up:
   ```
   cd reliable/reliable-node
   npm run dev
   ```
   Ingest should be reachable at `http://localhost:5000/api/v1/ingest`.

2. Rebuild the SDK bundle after any change in `packages/core/src`:
   ```
   cd reliable/packages/core
   npx esbuild src/index.ts --bundle --format=esm \
       --outfile=dist/index.js --target=es2022 --sourcemap
   ```

3. Serve the tests folder (file:// won't work — ES modules need HTTP):
   ```
   cd reliable/packages
   npx serve tests -l 5173
   ```
   Then open `http://localhost:5173/core/index.html`.

## What the core harness currently covers

- Click **1. init()** — boots the SDK, expects a `POST /ingest/sessions`.
- Click **2. identify()** — expects a `POST /ingest/identify`.
- Click **3. flush()** — forces the transport queue.
- Click **reset sessionStorage** — wipes the stored session so the next
  init() creates a brand new one (for testing rotation).

Every fetch the SDK makes is intercepted and printed to the log pane so
you can see the status codes without opening DevTools.
