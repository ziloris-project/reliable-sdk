import { Command } from 'commander';
import { sourcemapsUpload, type SourcemapsUploadOpts } from './commands/sourcemaps-upload.js';

const program = new Command();

program
    .name('reliableapp-frontend')
    .description('Reliable frontend CLI — sourcemaps, releases, and other build-time uploads')
    .version('1.0.0');

const sourcemaps = program
    .command('sourcemaps')
    .description('Sourcemap operations');

sourcemaps
    .command('upload')
    .description('Upload sourcemaps for a release to the Reliable backend')
    .requiredOption(
        '--token <token>',
        'API token (rl_fpt_...). Falls back to $RELIABLE_TOKEN. The token already names which frontend project to upload to — no other IDs needed.',
        process.env.RELIABLE_TOKEN,
    )
    .option(
        '--release <id>',
        'Release identifier. Auto-detected from common platform env vars if omitted (GITHUB_SHA, VERCEL_GIT_COMMIT_SHA, RAILWAY_GIT_COMMIT_SHA, RENDER_GIT_COMMIT, etc.).',
    )
    .requiredOption(
        '--dist <path>',
        'Path to the build output folder containing .js + .js.map files.',
    )
    .requiredOption(
        '--url-prefix <url>',
        'URL prefix that maps to your dist root (e.g. https://app.example.com/).',
    )
    .option(
        '--environment <env>',
        'production | staging | development',
        'production',
    )
    .option(
        '--api <url>',
        'API base URL.',
        process.env.RELIABLE_API_URL ?? 'https://reliablebackend.ziloris.com/api',
    )
    .option(
        '--concurrency <n>',
        'How many uploads to run in parallel.',
        '4',
    )
    .option(
        '--force',
        'Bypass the CI detection check (use with care).',
    )
    .option(
        '--dry-run',
        "Don't actually upload anything; just report what would be sent.",
    )
    .action(async (opts: SourcemapsUploadOpts) => {
        await sourcemapsUpload(opts);
    });

program.parseAsync(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
});
