# @reliableapp/react

React bindings for [@reliableapp/frontend-core](https://www.npmjs.com/package/@reliableapp/frontend-core). Adds `<ReliableProvider>`, `<ReliableErrorBoundary>`, hooks, and router adapters — plus re-exports the full core API so you only need one package.

Built by [Ziloris](https://ziloris.com) · **[Full documentation →](https://reliable.ziloris.com/docs)**

---

## Install

```bash
npm install @reliableapp/react
```

React 18+ is required as a peer dependency.

## Quick start

Wrap your app root with `<ReliableProvider>` and add `<ReliableErrorBoundary>` wherever you want crash reporting:

```tsx
import { ReliableProvider, ReliableErrorBoundary } from '@reliableapp/react';

export default function RootLayout({ children }) {
  return (
    <ReliableProvider config={{ publicKey: 'pk_live_rl_...' }}>
      <ReliableErrorBoundary fallback={<p>Something went wrong.</p>}>
        {children}
      </ReliableErrorBoundary>
    </ReliableProvider>
  );
}
```

## Components

### `<ReliableProvider>`

Initializes the SDK once and exposes the client via context. Place this at the root of your app, outside any router.

```tsx
<ReliableProvider
  config={{
    publicKey: 'pk_live_rl_...',
    sampleRate: 100,
    captureReplay: true,
  }}
>
  <App />
</ReliableProvider>
```

### `<ReliableErrorBoundary>`

Catches render-phase crashes, reports them to Reliable with the full React component stack, and renders a fallback UI.

```tsx
// Static fallback
<ReliableErrorBoundary fallback={<ErrorPage />}>
  <Dashboard />
</ReliableErrorBoundary>

// Render-prop fallback with reset
<ReliableErrorBoundary
  fallback={(error, reset) => (
    <div>
      <p>{error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  )}
  onError={(error, info) => console.error(error, info)}
  tags={{ section: 'checkout' }}
>
  <CheckoutFlow />
</ReliableErrorBoundary>
```

## Hooks

### `useIdentify(user)`

Calls `identify()` on mount and whenever `user.externalId` changes. Pass `null` when the user isn't logged in.

```tsx
function App() {
  const { user } = useAuth();
  useIdentify(user ? { externalId: user.id, email: user.email } : null);
  return <Routes />;
}
```

### `useCaptureException()` / `useCaptureMessage()`

Stable references to the manual capture functions — safe to put in dependency arrays.

```tsx
const captureException = useCaptureException();

async function handleSubmit() {
  try {
    await submitOrder();
  } catch (err) {
    captureException(err, { severity: 'high', tags: { flow: 'checkout' } });
  }
}
```

### `useAddBreadcrumb()`

```tsx
const addBreadcrumb = useAddBreadcrumb();

function StepWizard() {
  const goToStep = (step: number) => {
    addBreadcrumb({ category: 'ui', message: `step ${step}`, level: 'info' });
    setStep(step);
  };
}
```

### `useSetTag()` / `useSetTags()`

Attach tags to all future events from this session.

```tsx
const setTag = useSetTag();
useEffect(() => { setTag('plan', user.plan); }, [user.plan]);
```

### `useReliable()`

Returns the raw `ReliableClient` from context if you need direct access.

```tsx
const client = useReliable();
client?.flush();
```

## Router adapters

### `useReliableRouter(pathname)` — generic

Works with any router. Pass the current pathname string.

```tsx
// React Router v6
import { useLocation } from 'react-router-dom';
import { useReliableRouter } from '@reliableapp/react';

function RouterSync() {
  const { pathname, search } = useLocation();
  useReliableRouter(pathname + search);
  return null;
}
```

```tsx
// Next.js App Router — add to your root layout
'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useReliableRouter } from '@reliableapp/react';

export function ReliableRouterSync() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useReliableRouter(pathname + (searchParams.toString() ? '?' + searchParams.toString() : ''));
  return null;
}
```

### `useReliableNextPagesRouter(router)` — Next.js Pages Router

```tsx
// pages/_app.tsx
import { useRouter } from 'next/router';
import { useReliableNextPagesRouter } from '@reliableapp/react';

export default function MyApp({ Component, pageProps }) {
  const router = useRouter();
  useReliableNextPagesRouter(router);
  return <Component {...pageProps} />;
}
```

## Core API re-exports

You don't need to install `@reliableapp/frontend-core` separately — everything is re-exported:

```ts
import {
  init, getClient, identify,
  setTag, setTags, addBreadcrumb,
  flush, captureException, captureMessage,
} from '@reliableapp/react';
```

---

**Docs:** [reliable.ziloris.com/docs](https://reliable.ziloris.com/docs) · **Built by:** [Ziloris](https://ziloris.com)
