// Detect whether we're running inside a CI / build pipeline. Used as a
// safety guard — uploading sourcemaps from a developer's laptop pollutes
// the release index with throwaway local builds.

const CI_ENV_VARS = [
    'CI',                       // generic, set by most CI systems
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'VERCEL',
    'NETLIFY',
    'CLOUDFLARE_PAGES',
    'BITBUCKET_BUILD_NUMBER',
    'TF_BUILD',                 // Azure Pipelines
    'JENKINS_URL',
    'TEAMCITY_VERSION',
];

/** Returns the env var name that triggered detection, or null if not in CI. */
export function detectCI(): string | null {
    for (const k of CI_ENV_VARS) {
        if (process.env[k]) return k;
    }
    return null;
}
