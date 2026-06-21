// Private memory-search MCP handler — config-driven persona memory search over
// a private/restricted memory zone. A persona is "configured" when EITHER:
//
//   1. PRIVATE_* env vars are set (env path; takes precedence), OR
//   2. a persona config file exists at $PERSONA_CONFIG_PATH or
//      ~/.claude/persona.config.json.
//
// With NEITHER, the tool is disabled — this is the safe default for public
// distribution: no maintainer-specific hostname is hardcoded anywhere, so a
// fresh checkout ships the tool "off" until the operator drops in their own
// persona.config.json (see persona.config.example.json). Host / marker gating
// applies only when the active persona configures them.
//
// Env contract: when PRIVATE_* env vars are present the resolution and gate
// behaviour follow the env path (the private-memory-search-*.test.js suites
// exercise it). An unset PRIVATE_EXPECTED_HOST skips the host check rather than
// gating on any hardcoded machine name.

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { runMemorySearch } from './memory-search-mcp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PERSONA_DIR = join(homedir(), '.claude', 'memory', 'private')

// Expand a leading "~" to the user's home dir so config files can stay portable.
function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function resolveConfigPath() {
  return process.env.PERSONA_CONFIG_PATH || join(homedir(), '.claude', 'persona.config.json')
}

// undefined = not yet loaded, null = absent or malformed (→ disabled, safe).
let _configCache
function loadPersonaConfig() {
  if (_configCache !== undefined) return _configCache
  const p = resolveConfigPath()
  if (!existsSync(p)) { _configCache = null; return _configCache }
  try {
    _configCache = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    // A broken config must never silently open the gate — treat it as absent.
    _configCache = null
  }
  return _configCache
}

// Test-only: clear the cached persona config so each test re-resolves
// $PERSONA_CONFIG_PATH (mirror of _resetCorpusForTests below).
export function _resetConfigForTests() {
  _configCache = undefined
}

// Resolve the active persona settings, or null when no persona is configured.
// Precedence: PRIVATE_* env → persona config file → null.
function resolveSettings() {
  const hasEnv = process.env.PRIVATE_EXPECTED_HOST
    || process.env.PRIVATE_MARKER
    || process.env.PRIVATE_MEMORY_DIR
  if (hasEnv) {
    const memoryDir = process.env.PRIVATE_MEMORY_DIR || DEFAULT_PERSONA_DIR
    return {
      name: 'private',
      memoryDir,
      // Env path keeps the default marker location alongside the memory dir.
      marker: process.env.PRIVATE_MARKER || join(memoryDir, '.marker'),
      // No hardcoded host default: unset PRIVATE_EXPECTED_HOST → no host gate.
      expectedHost: process.env.PRIVATE_EXPECTED_HOST || null,
      corpusManifestPath: process.env.RELVETIA_CORPUS_MANIFEST_PATH || null,
      excludeRoots: ['archive'],
    }
  }
  const cfg = loadPersonaConfig()
  if (cfg) {
    const memoryDir = cfg.memoryDir ? expandHome(cfg.memoryDir) : DEFAULT_PERSONA_DIR
    return {
      name: cfg.name || 'persona',
      memoryDir,
      // Config path: host / marker gating is OPT-IN (only when specified).
      marker: cfg.marker ? expandHome(cfg.marker) : null,
      expectedHost: cfg.expectedHost || null,
      corpusManifestPath: cfg.corpusManifestPath
        ? expandHome(cfg.corpusManifestPath)
        : (process.env.RELVETIA_CORPUS_MANIFEST_PATH || null),
      excludeRoots: Array.isArray(cfg.excludeRoots) ? cfg.excludeRoots : ['archive'],
    }
  }
  return null
}

function gateOk(settings) {
  // Opt-out escape via CLAUDE_NO_PRIVATE=1, kept aligned with the SessionStart
  // hook. Strictly "1" — "0" / "true" / unset all mean "persona mode stays on".
  if (process.env.CLAUDE_NO_PRIVATE === '1') return false
  if (!settings) return false // no persona configured → disabled (public-safe)
  if (settings.expectedHost) {
    if ((process.env.COMPUTERNAME || '') !== settings.expectedHost) return false
  }
  if (settings.marker) {
    if (!existsSync(settings.marker)) return false
  }
  return true
}

// The persona corpus = relvetia-extracted defaults plus the persona's
// excludeRoots (default `['archive']`). The archive/ namespace physically
// isolates "dropped" decisions and is removed from the search corpus. Default
// exclusions (`.backup`, `.staging`, `tmp-*`) come from CorpusManifest.ts's
// getDefaultCorpusManifest() to avoid drift.
function resolveCorpusManifestPath(settings) {
  if (settings && settings.corpusManifestPath) return settings.corpusManifestPath
  if (process.env.RELVETIA_CORPUS_MANIFEST_PATH) return process.env.RELVETIA_CORPUS_MANIFEST_PATH
  // Monorepo layout: packages/team/src/ -> packages/extracted/dist/...
  const monorepo = resolve(
    __dirname, '..', '..', 'extracted', 'dist', 'memory', 'CorpusManifest.js',
  )
  if (existsSync(monorepo)) return monorepo
  // Legacy multi-repo layout: <workspace>/relvetia/relvetia-extracted/dist/...
  return resolve(
    __dirname, '..', '..',
    'relvetia', 'relvetia-extracted', 'dist', 'memory', 'CorpusManifest.js',
  )
}

let _corpusFnCache = null
async function getDefaultCorpusManifestFn(settings) {
  if (_corpusFnCache) return _corpusFnCache
  const modPath = resolveCorpusManifestPath(settings)
  const mod = await import(pathToFileURL(modPath).href)
  if (typeof mod.getDefaultCorpusManifest !== 'function') {
    throw new Error(
      `relvetia-extracted CorpusManifest did not export getDefaultCorpusManifest. ` +
      `Resolved path: ${modPath}. Set RELVETIA_CORPUS_MANIFEST_PATH or persona config ` +
      `corpusManifestPath to override.`,
    )
  }
  _corpusFnCache = mod.getDefaultCorpusManifest
  return _corpusFnCache
}

// Test-only: clear the cached import so each test run re-resolves the corpus
// manifest path (mirror of memory-search-mcp.js's _resetForTests pattern).
export function _resetCorpusForTests() {
  _corpusFnCache = null
}

async function buildPersonaCorpusManifest(settings) {
  const defaults = (await getDefaultCorpusManifestFn(settings))()
  const baseExclusions = defaults.excludedRoots ?? []
  return {
    ...defaults,
    excludedRoots: [...baseExclusions, ...settings.excludeRoots],
  }
}

export async function privateMemorySearchToolHandler(args) {
  const settings = resolveSettings()
  if (!gateOk(settings)) {
    return {
      content: [{ type: 'text', text: '0 result(s): private_memory_search disabled on this host (gate)' }],
      structuredContent: { results: [], hits: 0, disabled: true },
    }
  }
  const corpus = await buildPersonaCorpusManifest(settings)
  const out = await runMemorySearch(
    { query: args.query, maxResults: args.k ?? 8 },
    { memoryDir: settings.memoryDir, recordUsage: false, corpus },
  )
  const label = settings.name || 'private'
  const lines = out.results.length === 0
    ? 'No results found (all items fell below the screening threshold).'
    : out.results.map(r => {
        const snippet = (r.snippet || '').slice(0, 200).replace(/\s+/g, ' ').trim()
        return `[${r.score.toFixed(3)}] ${r.path}\n  ${snippet}`
      }).join('\n\n')
  return {
    content: [{ type: 'text', text: `${out.results.length} result(s) from ${label}/:\n${lines}` }],
    structuredContent: { results: out.results, hits: out.hits },
  }
}
