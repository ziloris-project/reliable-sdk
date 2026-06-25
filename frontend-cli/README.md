# @reliableapp/frontend-cli

Reliable frontend CLI — upload sourcemaps from your CI / build pipeline so production stack traces resolve to real source code.

> Frontend-only. Backend / devops uploads will live in a separate `@reliableapp/backend-cli` package later.

```bash
npx @reliableapp/frontend-cli sourcemaps upload \
  --dist=./dist \
  --url-prefix=https://app.example.com/
```

That's it on a supported platform — release SHA auto-detects, project IDs come from env vars.

## Installation

Pick whichever fits your workflow:

**As a devDependency (recommended for build scripts):**
```bash
npm install --save-dev @reliableapp/frontend-cli
```
The `reliableapp-frontend` binary then resolves automatically inside any npm script — fastest option for repeat builds.

**Via `npx` (zero install):**
```bash
npx --yes @reliableapp/frontend-cli sourcemaps upload [options]
```
Slower on first run (downloads the package) but zero setup. Good for one-off CI YAML steps.

**Globally:**
```bash
npm i -g @reliableapp/frontend-cli
reliableapp-frontend sourcemaps upload [options]
```

Requires Node 18+.

> **Heads up:** if you write `reliableapp-frontend ...` directly in a shell or build script *without* installing the package locally or globally, you'll get `command not found`. The binary lives in `node_modules/.bin/` (after install) — npm scripts find it there automatically; raw shell does not.

## Setup (one-time)

In the Reliable dashboard, generate an API token for your frontend project:

> Project → Frontend Project → Settings → API Tokens → **Create token**

Copy the `rl_fpt_...` value (shown once) and set it as a secret in your CI / deploy platform:

| Variable | Description |
|---|---|
| `RELIABLE_TOKEN` | The `rl_fpt_...` token. **Mark as secret.** |

That's the only thing you need — the token already names the frontend project to upload to.

## Usage

### CI step (GitHub Actions, GitLab, CircleCI, Buildkite, Jenkins…)

```yaml
- name: Upload sourcemaps
  env:
    RELIABLE_TOKEN: ${{ secrets.RELIABLE_TOKEN }}
  run: |
    npx @reliableapp/frontend-cli sourcemaps upload \
      --dist=./dist \
      --url-prefix=https://app.example.com/
```

### `package.json` script (Vercel, Netlify, Railway, Render, Coolify, Dokploy, anything Nixpacks-based)

PaaS platforms that auto-build don't have CI step injection — chain the CLI into your build script. Install it as a devDependency once so the binary resolves on every build:

```bash
npm install --save-dev @reliableapp/frontend-cli
```

```json
{
  "scripts": {
    "build": "vite build && reliableapp-frontend sourcemaps upload --dist=./dist --url-prefix=https://app.example.com/"
  }
}
```

**Or skip the install and use `npx --yes`** (slower on repeat builds — downloaded each time):

```json
{
  "scripts": {
    "build": "vite build && npx --yes @reliableapp/frontend-cli sourcemaps upload --dist=./dist --url-prefix=https://app.example.com/"
  }
}
```

Set `RELIABLE_TOKEN` in the platform's environment variables UI. The CLI auto-detects the commit SHA from the platform's own env vars (no `--release` needed).

## Required SDK config

In your application code, pass `release` to `init()` so events arrive tagged with the matching build:

```ts
import { init } from '@reliableapp/react';

init({
    publicKey: 'pk_live_...',
    release:   process.env.GIT_SHA,  // same value the CLI uploads under
});
```

Without `release`, events arrive but the resolver has no way to find the right map.

## Options

| Flag | Default | Description |
|---|---|---|
| `--token <token>` | `$RELIABLE_TOKEN` | API token (`rl_fpt_...`). The token names the frontend project — no other IDs needed. |
| `--release <id>` | auto | Release identifier. Auto-detected on supported platforms |
| `--dist <path>` | required | Local path to the build output folder |
| `--url-prefix <url>` | required | Browser-visible URL prefix that maps to `--dist` root |
| `--environment <env>` | `production` | `production` / `staging` / `development` |
| `--api <url>` | Reliable backend | Override for self-hosted backends |
| `--concurrency <n>` | `4` | Parallel upload workers |
| `--force` | — | Bypass the CI safety check (use with care) |
| `--dry-run` | — | Walk and report what would be uploaded; don't POST |

## How `--url-prefix` works

The CLI walks `--dist` for every `*.js.map` file. For each one, the corresponding JS file's URL is computed as:

```
url-prefix + path-relative-to-dist (with .map stripped)
```

Example:

| `--dist` | file found | `--url-prefix` | computed asset URL |
|---|---|---|---|
| `./dist` | `dist/assets/main-abc.js.map` | `https://app.example.com/` | `https://app.example.com/assets/main-abc.js` |
| `./.next/static` | `.next/static/chunks/page-x.js.map` | `https://app.example.com/_next/static/` | `https://app.example.com/_next/static/chunks/page-x.js` |

Match the prefix to whatever URL your CDN actually serves the JS from.

## Auto-detected platforms

Release SHA is auto-resolved from these env vars (in order):

`GITHUB_SHA` · `CI_COMMIT_SHA` · `VERCEL_GIT_COMMIT_SHA` · `COMMIT_REF` (Netlify) · `RAILWAY_GIT_COMMIT_SHA` · `RENDER_GIT_COMMIT` · `CF_PAGES_COMMIT_SHA` · `SOURCE_COMMIT` (Coolify, Heroku) · `CIRCLE_SHA1` · `BUILDKITE_COMMIT` · `BITBUCKET_COMMIT` · `BUILD_SOURCEVERSION` (Azure) · `GIT_COMMIT` · `COMMIT_SHA`

Pass `--release` explicitly if your platform isn't on this list.

## Safety

The CLI refuses to upload when no CI env var is detected, to prevent your local builds from polluting the release index. Override with `--force` only when you know what you're doing.

## License

[Apache 2.0](./LICENSE) © [Ziloris](https://ziloris.com)
