#!/usr/bin/env node
// sync-readme.mjs - verify or update tool/test counts in README.md and CLAUDE.md
//
// Drift detection for the Single Source of Truth principle: README.md and
// CLAUDE.md MUST agree with src/index.js (tool count + tool names)
// and `node --test src/__tests__/` (test count).
//
// Usage:
//   node scripts/sync-readme.mjs            # default: --check (exit 1 on drift)
//   node scripts/sync-readme.mjs --check    # explicit check
//   node scripts/sync-readme.mjs --update   # write back actual values / missing tool stubs
//
// Patterns checked:
//   README:  "**N MCP tools**", "**N tests, concurrent-safe**"
//   CLAUDE:  "## MCP Tools (N total)" and tool names listed under that section

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(__dirname, '..')

export function extractSourceToolNames(indexSrc) {
  return new Set([...indexSrc.matchAll(/^safeTool\(server,\s*['"]([^'"]+)['"]/gm)].map(m => m[1]))
}

export function extractClaudeToolNames(claudeMd) {
  const section = getMcpToolsSection(claudeMd)
  return new Set([...section.text.matchAll(/`([^`(\s]+)\(/g)].map(m => m[1]))
}

function getMcpToolsSection(claudeMd) {
  const heading = claudeMd.match(/^## MCP Tools\b.*$/m)
  if (!heading || heading.index === undefined) {
    return { start: -1, end: -1, text: '' }
  }

  const start = heading.index
  const afterHeading = start + heading[0].length
  const nextHeading = claudeMd.slice(afterHeading).match(/^## /m)
  const end = nextHeading?.index === undefined
    ? claudeMd.length
    : afterHeading + nextHeading.index

  return { start, end, text: claudeMd.slice(start, end) }
}

function sortedDiff(left, right) {
  return [...left].filter(name => !right.has(name)).sort()
}

function formatNameList(names) {
  return `[${names.join(', ')}]`
}

function addToolStubsToClaude(claudeMd, toolNames) {
  if (toolNames.length === 0) return claudeMd

  const section = getMcpToolsSection(claudeMd)
  if (section.start === -1) {
    throw new Error('## MCP Tools section not found in CLAUDE.md')
  }

  let sectionText = section.text
  const insert = toolNames
    .map(name => `- \`${name}(...)\` \u2014 TODO: describe this tool (auto-added by sync-readme)`)
    .join('\n')

  if (/^### Other \(auto-stub\)$/m.test(sectionText)) {
    sectionText = `${sectionText.replace(/\s*$/, '')}\n${insert}\n\n`
  } else {
    sectionText = `${sectionText.replace(/\s*$/, '')}\n\n### Other (auto-stub)\n${insert}\n\n`
  }

  return claudeMd.slice(0, section.start) + sectionText + claudeMd.slice(section.end)
}

async function getTestCounts(rootDir) {
  let testCount = 0
  let suiteCount = 0
  const fileList = (await readdir(join(rootDir, 'src/__tests__')))
    .filter(f => f.endsWith('.test.js'))
    .map(f => join('src/__tests__', f))
  const fileCount = fileList.length

  try {
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    const out = spawnSync('node', ['--test', ...fileList], {
      cwd: rootDir,
      encoding: 'utf8',
      env: childEnv,
    })
    const blob = (out.stdout || '') + (out.stderr || '')
    testCount = Number(blob.match(/^# tests (\d+)/m)?.[1] || 0)
    suiteCount = Number(blob.match(/^# suites (\d+)/m)?.[1] || 0)
  } catch (e) {
    console.error('[sync-readme] WARN: could not run node --test:', e.message)
  }

  return { testCount, suiteCount, fileCount }
}

export async function runSync({ rootDir = DEFAULT_ROOT, mode = 'check' } = {}) {
  const root = resolve(rootDir)
  const readme = join(root, 'README.md')
  const claudeMdPath = join(root, 'CLAUDE.md')

  const indexSrc = await readFile(join(root, 'src/index.js'), 'utf8')
  const toolNames = extractSourceToolNames(indexSrc)
  const toolCount = toolNames.size

  const { testCount, suiteCount, fileCount } = await getTestCounts(root)

  console.log(`[sync-readme] expected: tools=${toolCount} tests=${testCount} suites=${suiteCount} files=${fileCount}`)

  const patches = [
    {
      file: readme,
      re: /\*\*\d+ MCP tools\*\*/,
      expect: `**${toolCount} MCP tools**`,
    },
    {
      file: readme,
      re: /\*\*\d+ tests, concurrent-safe\*\*/,
      expect: `**${testCount} tests, concurrent-safe**`,
    },
    {
      file: claudeMdPath,
      re: /## MCP Tools \(\d+ total\)/,
      expect: `## MCP Tools (${toolCount} total)`,
    },
  ]

  let driftFound = false
  for (const p of patches) {
    const buf = await readFile(p.file, 'utf8')
    const m = buf.match(p.re)
    if (!m) {
      console.error(`[sync-readme] pattern not found in ${p.file}: ${p.re}`)
      driftFound = true
      continue
    }
    if (m[0] !== p.expect) {
      console.log(`[sync-readme] DRIFT in ${p.file}:\n  current:  ${m[0]}\n  expected: ${p.expect}`)
      driftFound = true
      if (mode === 'update') {
        await writeFile(p.file, buf.replace(p.re, p.expect))
        console.log('[sync-readme]   -> updated')
      }
    }
  }

  const claudeMd = await readFile(claudeMdPath, 'utf8')
  const docToolNames = extractClaudeToolNames(claudeMd)
  const srcOnly = sortedDiff(toolNames, docToolNames)
  const docOnly = sortedDiff(docToolNames, toolNames)

  if (srcOnly.length > 0 || docOnly.length > 0) {
    console.error('[sync-readme] tool name drift in CLAUDE.md:')
    console.error(`  srcOnly: ${formatNameList(srcOnly)} (missing in docs)`)
    console.error(`  docOnly: ${formatNameList(docOnly)} (stale in docs)`)
    driftFound = true

    if (mode === 'update' && srcOnly.length > 0) {
      const updatedClaudeMd = addToolStubsToClaude(claudeMd, srcOnly)
      await writeFile(claudeMdPath, updatedClaudeMd)
      console.log('[sync-readme]   -> added missing tool stubs to CLAUDE.md')
    }
  }

  if (driftFound && mode === 'check') {
    console.error('[sync-readme] drift detected. Run `node scripts/sync-readme.mjs --update` to fix.')
    return { ok: false, driftFound, toolCount, testCount, suiteCount, fileCount, srcOnly, docOnly }
  }

  console.log(`[sync-readme] ${mode === 'update' ? 'updated' : 'no drift'}`)
  return { ok: true, driftFound, toolCount, testCount, suiteCount, fileCount, srcOnly, docOnly }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) {
  const mode = process.argv.includes('--update') ? 'update' : 'check'
  const rootDir = process.env.ROOT || DEFAULT_ROOT
  const result = await runSync({ rootDir, mode })
  if (!result.ok) process.exit(1)
}
