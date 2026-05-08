# @reliableapp/frontend-core

Framework-agnostic browser observability SDK. Captures errors, web vitals, network requests, clicks, navigation, and session replays — with a single `init()` call.

Built by [Ziloris](https://ziloris.com) · **[Full documentation →](https://reliable.ziloris.com/docs)**

---

## Install

```bash
npm install @reliableapp/frontend-core
```

## Quick start

```ts
import { init, identify, captureException } from '@reliableapp/frontend-core';

init({
  publicKey: 'pk_live_rl_...',
});

// Optional: attach a user to the session
identify({ externalId: 'user_123', email: 'user@example.com' });

// Manually report a caught error
try {
  riskyOperation();
} catch (err) {
  captureException(err);
}
```

## What gets captured automatically

| Feature | Default | Config flag |
|---|---|---|
| JavaScript errors + unhandled rejections | ✅ on | `captureErrors` |
| Web Vitals (LCP, CLS, INP, FID, TTFB) | ✅ on | `captureVitals` |
| Network requests (failures by default) | ✅ on | `captureNetwork` |
| Click events | ✅ on | `captureClicks` |
| Navigation / route changes | ✅ on | `captureNavigation` |
| Session replay (rrweb) | ✅ on | `captureReplay` |

## Configuration

```ts
init({
  publicKey: 'pk_live_rl_...',     // required
  endpoint: 'https://...',          // override ingest endpoint
  sampleRate: 100,                   // 0–100, per-session sampling
  debug: false,                      // verbose console output
  captureErrors: true,
  captureVitals: true,
  captureNetwork: true,
  captureClicks: true,
  captureNavigation: true,
  captureAllRequests: false,         // true = report successful requests too
  captureReplay: true,
  beforeSend(event) {
    // return null to drop, or mutate and return to rewrite
    return event;
  },
});
```

## Manual capture API

```ts
import {
  captureException,
  captureMessage,
  identify,
  setTag,
  setTags,
  addBreadcrumb,
  flush,
} from '@reliableapp/frontend-core';

// Report a caught error
captureException(new Error('payment failed'), { severity: 'high' });

// Report a message (no Error object needed)
captureMessage('checkout retry succeeded', { severity: 'low' });

// Attach user
identify({ externalId: 'user_123', email: 'user@example.com', name: 'Jane' });

// Attach tags to all future events
setTag('plan', 'pro');
setTags({ region: 'us-east', version: '2.1.0' });

// Add a breadcrumb (last 30 are attached to errors)
addBreadcrumb({ category: 'ui', message: 'clicked checkout button', level: 'info' });

// Force-flush the queue (useful before navigation or logout)
await flush();
```

## If you use React

Install [`@reliableapp/react`](https://www.npmjs.com/package/@reliableapp/react) instead — it wraps this package with `<ReliableProvider>`, `<ReliableErrorBoundary>`, and hooks.

---

**Docs:** [reliable.ziloris.com/docs](https://reliable.ziloris.com/docs) · **Built by:** [Ziloris](https://ziloris.com)
