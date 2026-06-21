#!/usr/bin/env node

import { copyFile, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

function usage() {
  return [
    'Usage: node scripts/sanitize-private-stats.mjs [--memory-dir path] [--dry-run|--apply]',
    '',
    'Defaults to --dry-run and ~/.claude/memory.',
  ].join('\n')
}

function parseArgs(argv) {
  const args = {
    memoryDir: join(process.env.HOME || homedir(), '.claude', 'memory'),
    dryRun: true,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--memory-dir') {
      const value = argv[++i]
      if (!value) throw new Error('--memory-dir requires a path')
      args.memoryDir = value
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--apply') {
      args.dryRun = false
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  return args
}

async function readStats(statsPath) {
  const raw = await readFile(statsPath, 'utf8')
  return JSON.parse(raw)
}

function findPrivateEntries(stats) {
  const entries = stats?.entries && typeof stats.entries === 'object'
    ? stats.entries
    : {}

  return Object.entries(entries)
    .filter(([key]) => key.startsWith('private/'))
    .map(([key, value]) => ({
      key,
      hitCount: value?.hitCount ?? '',
      lastHitAt: value?.lastHitAt ?? '',
    }))
}

function timestampForBackup() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function loadAtomicWriteJSON() {
  const mod = await import('../dist/extracted/util/atomicWrite.js')
  return mod.atomicWriteJSON
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const statsPath = join(args.memoryDir, 'stats.json')
  const stats = await readStats(statsPath)
  const privateEntries = findPrivateEntries(stats)

  if (privateEntries.length === 0) {
    console.log('no private keys found')
    return
  }

  if (args.dryRun) {
    console.log(`dry-run: found ${privateEntries.length} private keys in ${statsPath}`)
    console.table(privateEntries)
    return
  }

  const backupPath = join(
    args.memoryDir,
    `stats.json.bak.sanitize-private-${timestampForBackup()}`,
  )
  await copyFile(statsPath, backupPath)

  for (const { key } of privateEntries) {
    delete stats.entries[key]
  }

  const atomicWriteJSON = await loadAtomicWriteJSON()
  await atomicWriteJSON(statsPath, stats)

  console.log(`removed ${privateEntries.length} private keys`)
  console.log(`backup: ${backupPath}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
