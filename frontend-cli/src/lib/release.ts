// Auto-detect a release identifier (typically a git commit SHA) from
// whatever env var the current build platform sets. Lets users drop
// --release from their CLI invocation when running on a known PaaS.
//
// Order matters loosely — most-specific first, fallback CI-generic last.

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
    // CircleCI
    'CIRCLE_SHA1',
    // Buildkite
    'BUILDKITE_COMMIT',
    // Bitbucket Pipelines
    'BITBUCKET_COMMIT',
    // Azure Pipelines
    'BUILD_SOURCEVERSION',
    // Generic
    'GIT_COMMIT',
    'COMMIT_SHA',
];

export interface DetectedRelease {
    release: string;
    source:  string;  // env var name we read it from
}

export function autodetectRelease(): DetectedRelease | null {
    for (const k of SHA_ENV_VARS) {
        const v = process.env[k];
        if (v && v.trim()) {
            return { release: v.trim(), source: k };
        }
    }
    return null;
}
