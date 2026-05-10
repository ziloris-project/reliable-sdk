// Auto-detect a release identifier (typically a git commit SHA) from
// whatever env var the current build platform sets. Lets users drop
// --release from their CLI invocation when running on a known PaaS.
//
// Order: env vars first (most specific), then `git rev-parse HEAD` as a
// fallback (catches self-hosted PaaS where no SHA env var is auto-injected
// but .git/ is in the build context — Dokploy, Coolify, etc).

import { execSync } from 'child_process';

const SHA_ENV_VARS = [
    // GitHub Actions
    'GITHUB_SHA',
    // GitLab CI
    'CI_COMMIT_SHA',
    // Vercel
    'VERCEL_GIT_COMMIT_SHA',
    // Netlify
    'COMMIT_REF',
    // Railway
    'RAILWAY_GIT_COMMIT_SHA',
    // Render
    'RENDER_GIT_COMMIT',
    // Cloudflare Pages
    'CF_PAGES_COMMIT_SHA',
    // Coolify (older), Heroku (Nixpacks-derived)
    'SOURCE_COMMIT',
    // Heroku (newer)
    'SOURCE_VERSION',
    // CircleCI
    'CIRCLE_SHA1',
    // Buildkite
    'BUILDKITE_COMMIT',
    // Bitbucket Pipelines
    'BITBUCKET_COMMIT',
    // Azure Pipelines
    'BUILD_SOURCEVERSION',
    // Generic / self-hosted escape hatches users can set themselves
    'GIT_COMMIT',
    'COMMIT_SHA',
    'RELEASE',
    'RELEASE_ID',
];

export interface DetectedRelease {
    release: string;
    source:  string;  // human-readable origin (env var name with $ prefix, or "git")
}

export function autodetectRelease(): DetectedRelease | null {
    // 1. Standard CI env vars first.
    for (const k of SHA_ENV_VARS) {
        const v = process.env[k];
        if (v && v.trim()) {
            return { release: v.trim(), source: `$${k}` };
        }
    }

    // 2. Fall back to `git rev-parse HEAD`. Useful for self-hosted PaaS
    // (Dokploy, Coolify) where no SHA env var is auto-injected. Only works
    // if the build context includes .git/ — Docker .dockerignore commonly
    // excludes it, in which case this throws and we return null.
    try {
        const sha = execSync('git rev-parse HEAD', {
            stdio:   ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        }).toString().trim();
        if (sha) {
            return { release: sha, source: 'git rev-parse HEAD' };
        }
    } catch {
        // git not installed, not a repo, or .git/ excluded from Docker context
    }

    return null;
}
