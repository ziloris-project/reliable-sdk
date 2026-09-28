import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Baked into the bundle so sessions report the SDK version they came from
// (src/version.ts). Read at build time, after changesets has bumped it.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
    entry: ["src/index.ts"],
    define: { __SDK_VERSION__: JSON.stringify(version) },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    treeshake: true,
    target: "es2022",
    noExternal: ["rrweb", "pako", "web-vitals"],
    outExtension({ format }) {
        return { js: format === "cjs" ? ".cjs" : ".js" };
    },
});
