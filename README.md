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

### Shipping a release

The release loop is fully driven by Changesets + GitHub Actions. There
is no manual `npm publish`, no version bumping by hand, no long-lived
npm token in the publish path.

**1. Branch + code.**

```bash
git checkout -b feat/network-timing-percentiles
# ...edit core/src/...
```

**2. Author a changeset alongside the code change.**

```bash
pnpm changeset
```

The interactive prompt asks for:

- *Which packages changed?* Space-select. `@reliableapp/frontend-core`
  and `@reliableapp/react` are linked, so picking one bumps both — but
  still select both if both surfaces actually changed (more accurate
  CHANGELOG attribution).
- *Bump type?* `patch` for fixes, `minor` for new features, `major` for
  breaking API changes. When in doubt, `patch` — cheap insurance.
- *Summary.* One line that lands in `CHANGELOG.md`. Write it for SDK
  consumers, not for the team.

Commit the generated `.changeset/*.md` alongside the code:

```bash
git add -A
git commit -m "feat(core): network timing p50/p95/p99"
```

**3. Open a PR.**

```bash
git push -u origin feat/network-timing-percentiles
gh pr create --fill
```

CI runs automatically on the PR: typecheck, build, and `npm publish
--dry-run` for every changed package. All three must pass — branch
protection on `main` blocks the merge otherwise. Reviewers see the
proposed CHANGELOG entry in the diff.

**4. Merge to main → bot opens "Version Packages" PR.**

The Release workflow sees the pending `.changeset/*.md` file and opens
a PR titled `chore(release): version packages`. This PR:

- Bumps each affected package's `version` in `package.json`
- Regenerates each `CHANGELOG.md`
- Updates the internal `workspace:^` pins (e.g. `@reliableapp/react`'s
  dep on `@reliableapp/frontend-core`)
- Deletes the consumed `.changeset/*.md` files

CI runs against this PR too (the workflow uses `CHANGESETS_PAT`, so
the bot's PR isn't blocked by GitHub's bot-PR-no-CI rule). Review the
version bumps + changelog, then merge.

**5. Merge the Version PR → publish.**

The Release workflow re-runs. With no pending changesets, it executes
`pnpm release` → `changeset publish` → npm. Each artifact is signed
with sigstore provenance; npmjs.com renders a verified badge linking
the published tarball to this exact workflow run + commit.

#### Auth model for the publish

The workflow does **not** use a long-lived npm token for publishing.
Each publish call presents a fresh GitHub OIDC token to npm; npm
verifies the `repository`, `workflow_ref`, and `environment` claims
against the trusted publisher configured on each package
(`ziloris-project/reliable-sdk` / `release.yml` / no environment). A
mismatch — wrong fork, wrong branch, manually-triggered run — is
rejected. `NPM_TOKEN` is still set as a workflow secret because
`changesets/action` requires its env check, but it is no longer the
authorization for the registry write.

#### When to skip a changeset

Some changes don't ship — docs typos, CI tweaks, internal refactors
with no consumer-facing impact. For those, open the PR without
`pnpm changeset`. The Release workflow will run on the merge, see no
pending changesets, and exit cleanly. Nothing publishes.

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
