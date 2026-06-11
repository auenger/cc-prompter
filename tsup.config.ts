import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Don't bundle node-pty — it's a native module
  external: ['node-pty-prebuilt-multiarch', '@homebridge/node-pty-prebuilt-multiarch', 'node-pty', 'code-inspector-plugin'],
  // Copy static assets to dist so fs.readFileSync works at runtime
  // panel.html and inject.js are read from __dirname (which is dist/ after build)
  onSuccess: 'cp panel.html inject.js dist/ 2>/dev/null || copy panel.html inject.js dist/ 2>/dev/null || true',
});
