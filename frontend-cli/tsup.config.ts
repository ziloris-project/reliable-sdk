import { defineConfig } from 'tsup';

export default defineConfig({
    entry:   ['src/index.ts'],
    format:  ['esm'],
    target:  'node18',
    // Shebang so npm can run dist/index.js directly when symlinked into PATH.
    banner:  { js: '#!/usr/bin/env node' },
    clean:   true,
    dts:     false,
    shims:   true,
    splitting: false,
    sourcemap: false,
});
