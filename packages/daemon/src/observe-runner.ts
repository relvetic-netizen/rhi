#!/usr/bin/env node
// observe-runner — standalone Node.js script for the Stop hook.
//
// Called by relvetia-observe.sh to screen Claude's response for novel
// observations worth recording to the daily log. Uses inverse
// Trim-and-Square (noveltyScreening) to reject redundant information.
//
// Usage:
//   node dist/observe-runner.js '{"responseText":"...","memoryDir":"..."}'
//   echo '{"responseText":"..."}' | node dist/observe-runner.js --stdin
//
// Output: JSON array of novel observation strings, one per line.

import { readdir, readFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  splitIntoObservations,
  screenForNovelty,
  type NoveltyConfig,
} from '../../extracted/screening/noveltyScreening.js'

// ---------------------------------------------------------------------------
// Memory loading (lightweight: first 500 chars per file)
// ---------------------------------------------------------------------------

const MAX_FILES = 200
const SNIPPET_BYTES = 500

async function loadMemoryTexts(memoryDir: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries
      .filter(f => f.endsWith('.md'))
      .slice(0, MAX_FILES)

    const results = await Promise.allSettled(
      mdFiles.map(async (relativePath) => {
        const filePath = join(memoryDir, relativePath)
        const buf = await readFile(filePath)
        const text = buf.toString('utf8', 0, SNIPPET_BYTES)
        return `${relativePath.replace(/[-_./]/g, ' ')} ${text}`
      }),
    )

    return results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map(r => r.value)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: NoveltyConfig = {
  threshold: 0.25,
  maxObservations: 10,
}

async function main() {
  let input: { responseText: string; memoryDir?: string }

  // Parse input from args or stdin
  const args = process.argv.slice(2)
  if (args.includes('--stdin')) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    const stdinText = Buffer.concat(chunks).toString('utf8')
    // When --stdin, responseText comes from stdin, memoryDir from --memory-dir flag
    const memDirIdx = args.indexOf('--memory-dir')
    const memoryDir = memDirIdx >= 0 ? args[memDirIdx + 1] : undefined
    input = { responseText: stdinText, memoryDir }
  } else if (args[0]) {
    input = JSON.parse(args[0])
  } else {
    process.exit(0)
  }

  if (!input.responseText?.trim()) {
    process.exit(0)
  }

  const memoryDir = input.memoryDir
    ?? process.env.RELVETIA_MEMORY_DIR
    ?? join(process.env.HOME ?? '', '.claude', 'memory')

  // Split response into candidate observations
  const observations = splitIntoObservations(input.responseText)
  if (observations.length === 0) {
    process.exit(0)
  }

  // Load existing memory for comparison
  const existingMemory = await loadMemoryTexts(memoryDir)

  // Screen for novelty (inverse Trim-and-Square)
  const novel = screenForNovelty(observations, existingMemory, DEFAULT_CONFIG)

  if (novel.length === 0) {
    process.exit(0)
  }

  // Output novel observations as newline-delimited text
  const output = novel.map(n => n.item).join('\n')
  process.stdout.write(output)
}

main().catch(() => process.exit(0)) // Silent failure — never crash the hook
