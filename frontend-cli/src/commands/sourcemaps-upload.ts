import { promises as fs } from 'fs';
import path from 'path';
import { red, green, yellow, cyan, gray, bold } from 'kleur/colors';
import { detectCI } from '../lib/env.js';
import { walkForMaps } from '../lib/walk.js';
import { uploadSourcemap } from '../lib/upload.js';
import { autodetectRelease } from '../lib/release.js';

export interface SourcemapsUploadOpts {
    token:       string;
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

    // ── Resolve release: explicit flag wins, else sniff platform env vars ──
    const explicit = opts.release?.trim();
    const auto     = explicit ? null : autodetectRelease();
    const release: string =
        explicit ?? auto?.release ?? '';
    const releaseSrc =
        explicit ? '--release flag' : auto ? `$${auto.source}` : '';
    if (!release) {
        console.error(red('✗ --release not provided and could not auto-detect.'));
        console.error(gray('  Pass --release explicitly, or run on a platform that sets one of:'));
        console.error(gray('    GITHUB_SHA, VERCEL_GIT_COMMIT_SHA, RAILWAY_GIT_COMMIT_SHA,'));
        console.error(gray('    RENDER_GIT_COMMIT, CF_PAGES_COMMIT_SHA, SOURCE_COMMIT, etc.'));
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
                    token:       opts.token,
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
