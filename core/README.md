# @reliableapp/frontend-core

[![npm version](https://img.shields.io/npm/v/@reliableapp/frontend-core?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/frontend-core)
[![npm downloads](https://img.shields.io/npm/dm/@reliableapp/frontend-core?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/frontend-core)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@reliableapp/frontend-core?style=flat&color=green)](https://bundlephobia.com/package/@reliableapp/frontend-core)
[![types](https://img.shields.io/npm/types/@reliableapp/frontend-core?style=flat)](https://www.npmjs.com/package/@reliableapp/frontend-core)
[![license](https://img.shields.io/npm/l/@reliableapp/frontend-core?style=flat)](./LICENSE)

Framework-agnostic browser SDK for [Reliable](https://reliable.ziloris.com).
Captures errors, web vitals, network failures, user interactions,
session replays, and WebSocket health from any JavaScript application —
React, Vue, Svelte, plain JS, doesn't matter.

> Looking for the React-specific bindings? See
> [`@reliableapp/react`](https://www.npmjs.com/package/@reliableapp/react).

## Install

```bash
# pnpm
pnpm add @reliableapp/frontend-core

# npm
npm install @reliableapp/frontend-core

# yarn
yarn add @reliableapp/frontend-core
```

## Quick start

```ts
import { init } from '@reliableapp/frontend-core';

init({
    publicKey: 'pk_live_rl_xxxxxxxxxxxxxxxx',
});
```

That's it. The SDK now:

- Listens for `window.error` and `unhandledrejection` and forwards every
  crash with stack, breadcrumbs, browser state, and the last 30 seconds
  of session replay.
- Reports [Core Web Vitals](https://web.dev/vitals/) (LCP, INP, CLS,
  TTFB, FCP) every page load.
- Captures every failed `fetch` and `XMLHttpRequest` with timing
  breakdown and response body.
- Records click breadcrumbs (with scrubbed selectors), navigation
  events, and WebSocket connection lifecycles.
- Buffers everything through a low-priority queue that survives
  page-hide via `navigator.sendBeacon`.

Open your project at [reliable.ziloris.com](https://reliable.ziloris.com)
and the events will start landing within seconds.

## What gets captured

| Module | Default | What it does |
|---|---|---|
| `errors` | ✅ on | `window.error`, `unhandledrejection`, manual `captureException`. Stack normalisation + fingerprinting + de-dup. |
| `vitals` | ✅ on | LCP / INP / CLS / TTFB / FCP via [`web-vitals`](https://github.com/GoogleChrome/web-vitals). Reported per page change. |
| `network` | ✅ on | `fetch` + `XHR` monkey-patch. Failures only by default; opt in to all requests with `captureAllRequests`. |
| `clicks` | ✅ on | Click breadcrumbs only — coordinates and a CSS-path-style selector, never the click target's text. |
| `navigation` | ✅ on | History and `popstate` listening. Exposes `getCurrentPath()` other modules read. |
| `replay` | ✅ on | rrweb session recording. Last 30 s + 10 s post-error flush. |
| `console` | ✅ on | `console.error` and `console.warn` surfaced as soft errors. The SDK's own logs are excluded. |
| `websocket` | ✅ on | One row per WebSocket connection: open / close / reconnect storms / message and byte counts. Post-open errors flow into the errors pipeline. |
| `breadcrumbs` | — | Ring buffer of the last 30 breadcrumbs, attached to every error. |
| `session` | — | One session UUID per browser session, rotated on long idle. |

Anything you don't want, toggle off:

```ts
init({
    publicKey: 'pk_live_rl_...',
    captureReplay: false,
    captureConsole: false,
});
```

## Privacy

Reliable does not collect input values, form contents, password fields,
or message payloads. Specifically:

- **HTTP headers**: `authorization`, `cookie`, `set-cookie`,
  `proxy-authorization`, `x-api-key`, `x-auth-token`, and Reliable's
  own ingest key are always redacted to `[redacted]` before send.
- **URL query params**: `token`, `access_token`, `id_token`,
  `refresh_token`, `auth`, `password`, `pwd`, `secret`, `api_key`,
  `apikey`, `sid`, `session`, `code`, and `state` are stripped from
  every captured URL.
- **In-body strings**: email addresses and credit-card-shaped digit
  sequences are regex-scrubbed from any captured request or response
  body.
- **WebSocket frame contents** are NEVER captured. The SDK observes
  fingerprints (a hash of structural shape) and byte counts only.
- **Session replay**: rrweb's input masking, slim DOM, and password-
  field omission are enabled by default — input values are masked,
  scripts and external assets are stripped, password fields are never
  recorded.

`beforeSend` is the escape hatch for everything else:

```ts
init({
    publicKey: 'pk_live_rl_...',
    beforeSend(event) {
        if (event.path?.startsWith('/admin')) return null;        // drop entirely
        if (event.request_body) delete event.request_body;        // redact a field
        return event;
    },
});
```

## Configuration reference

```ts
init({
    /** REQUIRED. Public key from your project's Settings page. Starts with `pk_live_rl_` or `pk_test_rl_`. */
    publicKey: 'pk_live_rl_...',

    /** Custom ingest endpoint. Leave unset to use Reliable's hosted endpoint. */
    endpoint: 'https://reliablebackend.ziloris.com/api/v1/ingest',

    /** 0–100. Per-session sample dice roll. Losers go fully dark for the whole session — useful for cost control on high-traffic sites. */
    sampleRate: 100,

    /** Log SDK internals to console. Off in production; turn on while integrating. */
    debug: false,

    /** Return `null` to drop, or a mutated copy to rewrite. Runs synchronously. */
    beforeSend(event) { return event; },

    /** Build identifier (commit SHA, version tag, build ID). Required for sourcemap resolution. */
    release: process.env.NEXT_PUBLIC_GIT_SHA,

    // ── Feature toggles (every flag defaults to `true` unless noted)
    captureErrors:      true,
    captureVitals:      true,
    captureNetwork:     true,
    captureClicks:      true,
    captureNavigation:  true,
    captureReplay:      true,
    captureConsole:     true,
    captureWebSockets:  true,
    /** If true, network capture reports successful requests too. Default: false. */
    captureAllRequests: false,
});
```

The full reference, with type signatures and edge-case notes, lives at
[reliable.ziloris.com/docs/configuration](https://reliable.ziloris.com/docs/configuration).

## Manual API

For caught errors, custom events, identity, and tags:

```ts
import {
    captureException, captureMessage, identify,
    setTag, setTags, addBreadcrumb, flush,
} from '@reliableapp/frontend-core';

// Caught error
try { riskyThing(); }
catch (err) {
    captureException(err, { severity: 'high', tags: { feature: 'checkout' } });
}

// Soft failure that didn't throw
captureMessage('Payment retry succeeded after 3 attempts', { severity: 'low' });

// User identity (replaces the session's anonymous ID)
identify({ externalId: 'user_123', email: 'alex@example.com' });

// Tags + breadcrumbs attached to every subsequent event
setTag('plan', 'enterprise');
addBreadcrumb({ category: 'cart', message: 'Added item', data: { sku: 'X-42' } });

// Force-flush before navigation
await flush();
```

## Framework integrations

| Framework | Package |
|---|---|
| React | [`@reliableapp/react`](https://www.npmjs.com/package/@reliableapp/react) — Provider + ErrorBoundary + hooks + router adapters |
| Next.js | Use `@reliableapp/react` inside your root layout. See [docs](https://reliable.ziloris.com/docs/react). |
| Vue / Svelte / Solid | Use this package directly. `init()` once at app entry. |

## Sourcemaps

For de-minified stacks, upload your `.map` files alongside each release:

```bash
npx @reliableapp/frontend-cli sourcemaps-upload \
    --release "$GIT_SHA" \
    --dir ./dist
```

Then set `release` in `init()` to the same value. See the
[Sourcemaps guide](https://reliable.ziloris.com/docs/advanced/sourcemaps).

## Contributing

Issues, discussions, and PRs welcome on the
[`reliable-sdk`](https://github.com/ziloris-project/reliable-sdk) repo.
Releases are driven by [Changesets](https://github.com/changesets/changesets):

```bash
# After making a change
pnpm changeset
# Pick the affected packages and the semver impact; commit the
# generated .changeset/*.md alongside your code.
```

CI opens a "Version Packages" PR aggregating pending changesets;
merging it publishes to npm with sigstore provenance attestation.

## License

[MIT](./LICENSE) © [Ziloris](https://ziloris.com)
