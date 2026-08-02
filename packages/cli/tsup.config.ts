import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsup'

// Inlined as a literal so the bin never resolves its own package.json at runtime:
// the bundle is a single file whose location relative to the manifest is an install
// detail. The unbundled tsx run gets no `define` and falls back (see commands/version).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  entry: { main: 'src/apps/cli/main.ts' },
  define: {
    'process.env.NOTARIUM_CLI_VERSION': JSON.stringify(pkg.version),
  },
  banner: { js: '#!/usr/bin/env node' },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  clean: true,
})
