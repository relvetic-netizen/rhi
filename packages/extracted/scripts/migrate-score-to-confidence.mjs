import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const MEMORY_DIR = process.env.RELVETIA_MEMORY_DIR ?? path.join(os.homedir(), '.claude', 'memory')
const TARGET = path.join(MEMORY_DIR, 'index.json')
const DAEMONS = ['relvetia-daemon', 'inbox-watcher']

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function entrySlots(data) {
  const container = isObject(data) && (Array.isArray(data.entries) || isObject(data.entries))
    ? data.entries
    : data

  if (Array.isArray(container)) {
    return container.map((entry, index) => ({ key: String(index), entry }))
  }
  if (isObject(container)) {
    return Object.entries(container).map(([key, entry]) => ({ key, entry }))
  }
  return []
}

export function parseIndexJson(raw) {
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

export function transformEntries(data, warn = () => {}) {
  const stats = { migrated: 0, skipped: 0, missing: 0, warnings: 0, total: 0 }

  for (const { key, entry } of entrySlots(data)) {
    stats.total++
    if (!isObject(entry)) {
      warn(`Entry ${key}: not an object; skipped`)
      stats.warnings++
      continue
    }

    const hasScore = Object.prototype.hasOwnProperty.call(entry, 'score')
    const hasConfidence = Object.prototype.hasOwnProperty.call(entry, 'confidence')

    if (hasScore && !hasConfidence) {
      entry.confidence = entry.score
      delete entry.score
      stats.migrated++
    } else if (hasScore && hasConfidence) {
      warn(`Entry ${key}: both score and confidence found; keeping confidence`)
      delete entry.score
      stats.skipped++
      stats.warnings++
    } else if (hasConfidence) {
      stats.skipped++
    } else {
      warn(`Entry ${key}: neither score nor confidence found`)
      stats.missing++
      stats.warnings++
    }
  }

  return { data, ...stats }
}

export function assertNoScoreFields(data) {
  for (const { key, entry } of entrySlots(data)) {
    if (isObject(entry) && Object.prototype.hasOwnProperty.call(entry, 'score')) {
      throw new Error(`post-write smoke failed: entry ${key} still has score`)
    }
  }
}

function backupPathFor(target) {
  const stamp = new Date().toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, '')
    .replace(/^(\d{8})(\d{6})$/, '$1-$2')
  return path.join(path.dirname(target), `index.json.bak-${stamp}-${process.pid}`)
}

function usage() {
  console.error('Usage: node relvetia-extracted/scripts/migrate-score-to-confidence.mjs --apply')
  console.error(`Target: ${TARGET}`)
}

function runPm2(command, bestEffort = false) {
  console.log(`$ ${command}`)
  try {
    execSync(command, { stdio: 'inherit' })
    return true
  } catch (error) {
    if (!bestEffort) throw error
    console.error(`WARN: ${command} failed; restart manually after inspection`)
    return false
  }
}

function restartDaemonsBestEffort() {
  for (const daemon of DAEMONS) {
    runPm2(`pm2 start ${daemon}`, true)
  }
}

export function runMigration(target = TARGET) {
  console.log(`Target: ${target}`)
  fs.accessSync(target, fs.constants.R_OK)

  for (const daemon of DAEMONS) {
    runPm2(`pm2 stop ${daemon}`)
  }

  const backup = backupPathFor(target)
  const tmp = path.join(path.dirname(target), 'index.json.tmp')

  try {
    if (fs.existsSync(backup)) {
      throw new Error(`backup collision: ${backup}`)
    }

    console.log(`Backup: ${backup}`)
    fs.copyFileSync(target, backup)

    const data = parseIndexJson(fs.readFileSync(target, 'utf8'))
    const warnings = []
    const result = transformEntries(data, message => warnings.push(message))
    for (const warning of warnings) console.warn(`WARN: ${warning}`)

    fs.writeFileSync(tmp, JSON.stringify(result.data, null, 2), { encoding: 'utf8' })
    fs.renameSync(tmp, target)

    try {
      const reread = parseIndexJson(fs.readFileSync(target, 'utf8'))
      assertNoScoreFields(reread)
    } catch (error) {
      console.error(`ERROR: ${(error && error.message) || error}`)
      console.error(`Restoring from backup: ${backup}`)
      fs.copyFileSync(backup, target)
      throw new Error('post-write smoke failed; backup restored')
    }

    restartDaemonsBestEffort()
    console.log(`Migrated: ${result.migrated} entries (score \u2192 confidence)`)
    console.log(`Skipped: ${result.skipped} entries (already confidence)`)
    console.log(`Backup: ${backup}`)
    console.log('Status: SUCCESS')
    return { ...result, backup }
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {}
    restartDaemonsBestEffort()
    throw error
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const modulePath = path.resolve(fileURLToPath(import.meta.url))

if (invokedPath === modulePath) {
  if (!process.argv.includes('--apply')) {
    usage()
    process.exit(1)
  }

  try {
    runMigration()
  } catch (error) {
    console.error(`Status: FAILED - ${(error && error.message) || error}`)
    console.error('If daemons did not restart, run: pm2 start relvetia-daemon && pm2 start inbox-watcher')
    process.exit(1)
  }
}
