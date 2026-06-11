import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    // Don't bundle native modules — they must be installed separately
    external: ['node-pty-prebuilt-multiarch', '@homebridge/node-pty-prebuilt-multiarch', 'node-pty', 'code-inspector-plugin', 'vite', 'webpack'],
    // Copy static assets to dist so fs.readFileSync works at runtime
    onSuccess: 'cp panel.html inject.js client-entry.js dist/ 2>/dev/null || copy panel.html inject.js client-entry.js dist/ 2>/dev/null || true',
  },
  {
    entry: ['src/next-plugin.ts'],
    outDir: 'dist',
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    external: ['node-pty-prebuilt-multiarch', '@homebridge/node-pty-prebuilt-multiarch', 'node-pty', 'code-inspector-plugin', 'vite', 'webpack'],
  },
  {
    entry: ['src/webpack-plugin.ts'],
    outDir: 'dist',
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    external: ['node-pty-prebuilt-multiarch', '@homebridge/node-pty-prebuilt-multiarch', 'node-pty', 'code-inspector-plugin', 'vite', 'webpack'],
  },
]);
