// Bundle the server (and @reconnotes/core) into a single ESM file.
// Native / heavy modules stay external and are installed from package.json.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['better-sqlite3', '@resvg/resvg-js', '@anthropic-ai/sdk', '@hocuspocus/server', 'ws', 'yjs'],
  banner: { js: '#!/usr/bin/env node' },
})
console.log('built dist/index.js')
