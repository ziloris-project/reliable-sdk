# Reliable SDK

The browser SDK for [Reliable](https://reliable.ziloris.com) — a
unified observability platform for frontend errors, web vitals,
network failures, WebSocket health, session replay, and intelligent
on-call paging.

## Packages

| Package | Description | npm |
|---|---|---|
| [`@reliableapp/frontend-core`](./core) | Framework-agnostic browser SDK | [![npm](https://img.shields.io/npm/v/@reliableapp/frontend-core?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/frontend-core) |
| [`@reliableapp/react`](./react) | React bindings (Provider, ErrorBoundary, hooks, routers) | [![npm](https://img.shields.io/npm/v/@reliableapp/react?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/react) |
| [`@reliableapp/frontend-cli`](./frontend-cli) | Sourcemap upload CLI for de-minified stacks | [![npm](https://img.shields.io/npm/v/@reliableapp/frontend-cli?style=flat&color=blue)](https://www.npmjs.com/package/@reliableapp/frontend-cli) |

## Quick start

```bash
pnpm add @reliableapp/react        # most users
# or
pnpm add @reliableapp/frontend-core # framework-agnostic
```

```tsx
import { ReliableProvider } from '@reliableapp/react';

<ReliableProvider config={{ publicKey: 'pk_live_rl_xxxxxxxxxxxxxxxx' }}>
    <App />
</ReliableProvider>
```

Full guide at [reliable.ziloris.com/docs](https://reliable.ziloris.com/docs).

## Development

```bash
pnpm install           # install workspace
pnpm build             # build every package
pnpm typecheck         # typecheck every package
pnpm dev               # watch-mode build for every package
```

### Adding a change that ships in a release

```bash
pnpm changeset         # interactive — pick affected packages + semver
git add .changeset/*.md
git commit -m "feat(react): ..."
```

CI handles versioning and publishing:

1. Push to `main`. The Release workflow runs.
2. If pending changesets exist, the workflow opens a "Version Packages"
   PR that bumps versions, regenerates each package's `CHANGELOG.md`,
   and propagates internal dep ranges (`@reliableapp/react`'s pin on
   `@reliableapp/frontend-core` stays accurate).
3. Merging that PR re-runs the workflow, this time with no pending
   changesets. The action publishes to npm with sigstore provenance.

No manual `npm publish` ever. Reviewers see the changelog as part of
PR review, and the published artifacts on npmjs.com carry verified
provenance attestation linking each one to the exact commit + workflow
run.

## Privacy

The SDK is built to be safe to deploy in customer browsers without a
data-protection review. Headers, query params, body strings, and
WebSocket frame contents are all scrubbed or counted-only. See
[`core/README.md#privacy`](./core/README.md#privacy) for the full
contract.

## Contributing

Issues, discussions, and PRs are welcome. The project uses Changesets
(see above) for versioning, Apache 2.0 for licensing, and a single
PR-to-`main` flow for all changes.

## License

[Apache 2.0](./LICENSE) © [Ziloris](https://ziloris.com)
