import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    treeshake: true,
    target: "es2022",
    external: ["react", "react-dom", "@reliableapp/frontend-core"],
    outExtension({ format }) {
        return { js: format === "cjs" ? ".cjs" : ".js" };
    },
});
