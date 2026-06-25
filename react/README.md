# @reliableapp/react

[![npm version](https://img.shields.io/npm/v/@reliableapp/react?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/react)
[![npm downloads](https://img.shields.io/npm/dm/@reliableapp/react?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/react)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@reliableapp/react?style=flat&color=green)](https://bundlephobia.com/package/@reliableapp/react)
[![types](https://img.shields.io/npm/types/@reliableapp/react?style=flat)](https://www.npmjs.com/package/@reliableapp/react)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat)](./LICENSE)

React bindings for [Reliable](https://reliable.ziloris.com).
Wraps [`@reliableapp/frontend-core`](https://www.npmjs.com/package/@reliableapp/frontend-core)
with a `<ReliableProvider>`, an error boundary that captures component
stacks, hooks that get you the active client, and adapters for the two
React Router setups.

You only need this package — the core SDK is re-exported, so a single
install covers both surfaces.

## Install

```bash
# pnpm
pnpm add @reliableapp/react

# npm
npm install @reliableapp/react

# yarn
yarn add @reliableapp/react
```

Peer dependency: React `>= 18`.

## Quick start

Mount `<ReliableProvider>` at the root of your tree and wrap your app
in `<ReliableErrorBoundary>`:

```tsx
import {
    ReliableProvider,
    ReliableErrorBoundary,
} from '@reliableapp/react';

export default function App() {
    return (
        <ReliableProvider config={{ publicKey: 'pk_live_rl_xxxxxxxxxxxxxxxx' }}>
            <ReliableErrorBoundary fallback={<p>Something went wrong.</p>}>
                <YourApp />
            </ReliableErrorBoundary>
        </ReliableProvider>
    );
}
```

That's enough to capture errors, web vitals, network failures,
interactions, session replays, WebSockets, and console output across
the whole app. Every component-tree crash from `ReliableErrorBoundary`
is reported with the React component stack alongside the JS stack.

## Next.js

For the App Router, mount the provider inside `app/layout.tsx`:

```tsx
// app/layout.tsx
'use client';

import { ReliableProvider } from '@reliableapp/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html>
            <body>
                <ReliableProvider config={{
                    publicKey: process.env.NEXT_PUBLIC_RELIABLE_KEY!,
                    release:   process.env.NEXT_PUBLIC_GIT_SHA,
                }}>
                    {children}
                </ReliableProvider>
            </body>
        </html>
    );
}
```

For the Pages Router, mount in `_app.tsx`. See the
[full Next.js guide](https://reliable.ziloris.com/docs/react).

## What's in the box

### `<ReliableProvider config={...}>`

Initialises the SDK exactly once (idempotent through React StrictMode
and HMR), exposes the client via context, and flushes the outbound
queue on unmount so events aren't lost during hot reload.

Accepts the same `ReliableConfig` shape as `init()` from the core
package — see the [config reference](https://reliable.ziloris.com/docs/configuration).

### `<ReliableErrorBoundary fallback={...}>`

A standard React error boundary that, on catch, forwards the error to
Reliable along with the React `componentStack`. Pair with a `key`
prop to reset on navigation:

```tsx
<ReliableErrorBoundary
    fallback={({ error, reset }) => (
        <div>
            <h1>Something broke.</h1>
            <button onClick={reset}>Try again</button>
        </div>
    )}
>
    <Routes />
</ReliableErrorBoundary>
```

### Hooks

```ts
import {
    useReliable,           // → the active ReliableClient
    useIdentify,           // → call identify on mount / on user change
    useCaptureException,   // → stable captureException reference
    useCaptureMessage,     // → stable captureMessage reference
    useAddBreadcrumb,      // → stable addBreadcrumb reference
    useSetTag,             // → stable setTag reference
    useSetTags,            // → stable setTags reference
    useFlush,              // → stable flush reference
} from '@reliableapp/react';
```

Example:

```tsx
function Checkout() {
    const captureException = useCaptureException();

    const onSubmit = async () => {
        try {
            await placeOrder();
        } catch (err) {
            captureException(err, { severity: 'high', tags: { step: 'submit' } });
            throw err;
        }
    };

    // ...
}
```

```tsx
function AuthSync({ user }: { user: User | null }) {
    useIdentify(user
        ? { externalId: user.id, email: user.email, name: user.name }
        : null);
    return null;
}
```

### Router adapters

```ts
import {
    useReliableRouter,            // generic — call from any router on path change
    useReliableNextPagesRouter,   // Next.js Pages Router (next/router)
} from '@reliableapp/react';
```

The adapters push navigation breadcrumbs and update `getCurrentPath()`
so subsequent errors / vitals / network events know which route they
fired from. Mount once at the root of the routed subtree.

For the Next.js App Router or React Router v6, use
`useReliableRouter()` with the relevant location hook:

```tsx
// Next.js App Router
'use client';
import { usePathname } from 'next/navigation';
import { useReliableRouter } from '@reliableapp/react';

export function ReliableNavSync() {
    useReliableRouter(usePathname());
    return null;
}
```

```tsx
// React Router v6
import { useLocation } from 'react-router-dom';
import { useReliableRouter } from '@reliableapp/react';

export function ReliableNavSync() {
    useReliableRouter(useLocation().pathname);
    return null;
}
```

## Re-exported from core

Everything in [`@reliableapp/frontend-core`](https://www.npmjs.com/package/@reliableapp/frontend-core)
is re-exported, so you don't need a second install:

```ts
import {
    init, getClient, identify, setTag, setTags,
    addBreadcrumb, flush, captureException, captureMessage,
    type ReliableConfig, type ReliableClient, type UserIdentity,
    type CaptureOptions, type CaptureMessageOptions,
} from '@reliableapp/react';
```

## Contributing

Issues, discussions, and PRs welcome on the
[`reliable-sdk`](https://github.com/ziloris-project/reliable-sdk) repo.
Releases are driven by [Changesets](https://github.com/changesets/changesets) —
see the [core README](../core/README.md#contributing) for the workflow.

## License

[Apache 2.0](./LICENSE) © [Ziloris](https://ziloris.com)
