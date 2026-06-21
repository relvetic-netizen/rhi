#!/usr/bin/env node
// Bundle standalone runner scripts into single files with all dependencies.
// This allows them to run from ~/.claude/relvetia/dist/ without node_modules.

import { build } from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const runners = [
  { entry: 'src/search-runner.ts', out: 'dist-runners/search-runner.js' },
  { entry: 'src/observe-runner.ts', out: 'dist-runners/observe-runner.js' },
  { entry: 'src/run-task.ts', out: 'dist-runners/run-task.js' },
  { entry: 'src/verify-runner.ts', out: 'dist-runners/verify-runner.js' },
  { entry: 'src/topology-runner.ts', out: 'dist-runners/topology-runner.js' },
]

for (const runner of runners) {
  await build({
    entryPoints: [join(__dirname, runner.entry)],
    outfile: join(__dirname, runner.out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Shebang is already in source files; don't duplicate
    // Mark Node built-ins as external
    external: ['fs', 'fs/promises', 'path', 'os', 'url', 'crypto', 'stream', 'util', 'events', 'buffer', 'string_decoder', 'worker_threads', 'child_process', 'assert', 'module', 'net', 'tls', 'http', 'https', 'zlib'],
    minify: false,
    sourcemap: true,
  })
  console.log(`✓ Bundled ${runner.entry} → ${runner.out}`)
}
