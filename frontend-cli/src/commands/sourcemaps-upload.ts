import { promises as fs } from 'fs';
import path from 'path';
import { red, green, yellow, cyan, gray, bold } from 'kleur/colors';
import { detectCI } from '../lib/env.js';
import { walkForMaps } from '../lib/walk.js';
import { uploadSourcemap } from '../lib/upload.js';
import { autodetectRelease } from '../lib/release.js';

export interface SourcemapsUploadOpts {
    token?:      string;
    release?:    string;
    dist:        string;
    urlPrefix:   string;
    environment: string;
    api:         string;
    concurrency: string;
    force?:      boolean;
    dryRun?:     boolean;
}

export async function sourcemapsUpload(opts: SourcemapsUploadOpts): Promise<void> {
    // ── Safety: skip local builds unless --force ───────────────────────
    // Exits 0 (not 2) so chaining the CLI into a `package.json` build
    // script doesn't break local `npm run build`. Production builds in
    // CI still upload normally — only laptop builds silently skip.
    const ci = detectCI();
    if (!ci && !opts.force) {
        console.log(yellow('⊘  Skipping sourcemap upload — not running in CI.'));
        console.log(gray('   This is normal for local builds. Add --force to override.'));
        return;
    }
    if (ci) console.log(gray(`CI detected via $${ci}`));

    // ── Resolve token: explicit flag wins, else $RELIABLE_TOKEN ────────
    // Read at runtime (not module load) so env vars set by the script
    // runner before exec are picked up correctly.
    const token: string = (opts.token?.trim() || process.env.RELIABLE_TOKEN?.trim()) ?? '';
    if (!token) {
        console.error(red('✗ No API token provided.'));
        console.error(gray('  Pass --token=rl_fpt_... or set the RELIABLE_TOKEN environment variable.'));
        console.error(gray('  Generate a token in: Frontend Project → Settings → API Tokens.'));
        process.exit(2);
    }

    // ── Resolve release: explicit flag wins, else sniff platform env vars ──
    const explicit = opts.release?.trim();
    const auto     = explicit ? null : autodetectRelease();
    const release: string =
        explicit ?? auto?.release ?? '';
    const releaseSrc =
        explicit ? '--release flag' : auto ? `$${auto.source}` : '';
    if (!release) {
        console.error(red('✗ --release not provided and could not auto-detect.'));
        console.error(gray(''));
        console.error(gray('  Auto-detect tries (in order):'));
        console.error(gray('    1. Platform env vars (GITHUB_SHA, VERCEL_GIT_COMMIT_SHA,'));
        console.error(gray('       RAILWAY_GIT_COMMIT_SHA, RENDER_GIT_COMMIT, etc).'));
        console.error(gray('    2. `git rev-parse HEAD` if .git/ is in the build context.'));
        console.error(gray(''));
        console.error(gray('  For Docker-based PaaS (Dokploy, Coolify, Nixpacks-based) where'));
        console.error(gray('  .git/ is typically excluded from the build, do ONE of:'));
        console.error(gray('    a) Set RELEASE=<your-build-id> in the platform\'s env vars UI.'));
        console.error(gray('    b) Pass --release=$npm_package_version (uses package.json version).'));
        console.error(gray('    c) Add !.git to your .dockerignore so git rev-parse works.'));
        process.exit(2);
    }

    // ── Validate dist path ─────────────────────────────────────────────
    try {
        const stat = await fs.stat(opts.dist);
        if (!stat.isDirectory()) {
            console.error(red(`✗ --dist is not a directory: ${opts.dist}`));
            process.exit(2);
        }
    } catch {
        console.error(red(`✗ --dist not found: ${opts.dist}`));
        process.exit(2);
    }

    // ── Find sourcemaps ────────────────────────────────────────────────
    const maps = await walkForMaps(opts.dist);
    if (maps.length === 0) {
        console.error(yellow(`No .js.map files found under ${opts.dist}`));
        console.error(gray('  Make sure your bundler emits sourcemaps in production.'));
        return;
    }

    // ── Header ─────────────────────────────────────────────────────────
    console.log();
    console.log(bold('Reliable sourcemap upload'));
    console.log(`  release      ${cyan(release)} ${gray(`(${releaseSrc})`)}`);
    console.log(`  environment  ${opts.environment}`);
    console.log(`  found        ${maps.length} maps`);
    console.log(`  dist         ${opts.dist}`);
    console.log(`  url-prefix   ${opts.urlPrefix}`);
    console.log(`  api          ${opts.api}`);
    console.log();

    if (opts.dryRun) {
        for (const m of maps) {
            const assetUrl = computeAssetUrl(opts.urlPrefix, m.relativePath);
            console.log(gray('  [dry]'), assetUrl);
        }
        console.log(gray('\nDry run, no uploads sent.'));
        return;
    }

    // ── Upload in parallel ─────────────────────────────────────────────
    const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 4);
    const queue   = [...maps];
    const results = { ok: 0, fail: 0 };

    async function worker(): Promise<void> {
        for (;;) {
            const m = queue.shift();
            if (!m) return;

            const assetUrl = computeAssetUrl(opts.urlPrefix, m.relativePath);
            try {
                await uploadSourcemap({
                    api:         opts.api,
                    token,
                    release,
                    environment: opts.environment,
                    assetUrl,
                    mapPath:     m.absolutePath,
                });
                results.ok++;
                console.log(green('  ✓'), assetUrl);
            } catch (err) {
                results.fail++;
                const msg = err instanceof Error ? err.message : String(err);
                console.log(red('  ✗'), assetUrl, gray(`(${msg})`));
            }
        }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    // ── Summary ────────────────────────────────────────────────────────
    console.log();
    console.log(
        `Uploaded ${green(String(results.ok))} · ` +
        `Failed ${results.fail > 0 ? red(String(results.fail)) : '0'}`,
    );

    if (results.fail > 0) process.exit(1);
}

/**
 * Convert a sourcemap's path-within-dist into the URL the browser will
 * use to load the corresponding JS file.
 *
 *   relative:   "static/main.abc.js.map"
 *   url-prefix: "https://app.example.com/"
 *   ⇒          "https://app.example.com/static/main.abc.js"
 */
function computeAssetUrl(urlPrefix: string, relativePath: string): string {
    // Normalize Windows backslashes to forward slashes.
    const cleanRel = relativePath.split(path.sep).join('/');
    // Strip the .map suffix to get the JS file path the browser sees.
    const jsRel    = cleanRel.replace(/\.map$/, '');
    const prefix   = urlPrefix.endsWith('/') ? urlPrefix : urlPrefix + '/';
    const rel      = jsRel.startsWith('/') ? jsRel.slice(1) : jsRel;
    return prefix + rel;
}
