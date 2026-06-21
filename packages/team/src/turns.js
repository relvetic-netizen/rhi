// max_turns — inspired by OpenAI Agents SDK `max_turns` + `error_handlers`.
// In a multi-process file-based system, a "turn" = one outbound message from
// a given sender. Exceeding the limit blocks further sends from that sender
// and enqueues a notice to team-lead so the coordinator can intervene.
//
// Limits live in team config (rarely changed). Counters live in **per-agent**
// shard files (Step 3a — `turn-counts/{agent}.json`) so concurrent writes
// from N parallel agents contend on N independent locks instead of one hot
// file. Aggregate read (getTurnCounts) merges the shards on demand.
//
// Backward compat: a legacy single-file `turn-counts.json` is migrated into
// shards on the first call per process; the legacy file is then deleted.

import { readFile, writeFile, mkdir, readdir, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getTeamDir, ensureDir, sanitize } from './paths.js'
import { withLock } from './lockfile.js'
import { readTeam } from './team.js'
import { errorMessage, isEnoent } from './errors.js'

function legacyCountsPath(teamName) {
  return join(getTeamDir(teamName), 'turn-counts.json')
}

function shardDir(teamName) {
  return join(getTeamDir(teamName), 'turn-counts')
}

function agentShardPath(teamName, agentName) {
  return join(shardDir(teamName), `${sanitize(agentName)}.json`)
}

// Best-effort migration of the legacy single-file turn-counts.json into
// per-agent shards. Triggered on every recordTurn / resetTurns / getTurnCounts
// call but cheap when the legacy file does not exist (single ENOENT readFile).
// Idempotent: missing legacy file = no-op. Race across processes is benign
// (re-write same shard content, then both try to delete the legacy file).
async function migrateLegacyOnce(teamName) {
  const legacy = legacyCountsPath(teamName)
  let raw
  try {
    raw = await readFile(legacy, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return // common path: legacy already gone
    console.error(`[turns] migration read: ${errorMessage(e)}`)
    return
  }
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') {
      await unlink(legacy).catch(() => {})
      return
    }
    await mkdir(shardDir(teamName), { recursive: true })
    for (const [agent, count] of Object.entries(obj)) {
      if (typeof count !== 'number' || count <= 0) continue
      const file = agentShardPath(teamName, agent)
      let existing = 0
      try {
        const cur = JSON.parse(await readFile(file, 'utf-8'))
        if (cur && typeof cur.count === 'number') existing = cur.count
      } catch (e) {
        if (!isEnoent(e)) throw e
      }
      await writeFile(file, JSON.stringify({ count: existing + count }))
    }
    await unlink(legacy)
  } catch (e) {
    console.error(`[turns] migration: ${errorMessage(e)}`)
  }
}

async function readShard(teamName, agentName) {
  try {
    const raw = await readFile(agentShardPath(teamName, agentName), 'utf-8')
    const obj = JSON.parse(raw)
    return obj && typeof obj.count === 'number' ? obj.count : 0
  } catch (e) {
    if (isEnoent(e)) return 0
    console.error(`[turns] readShard ${agentName}: ${errorMessage(e)}`)
    return 0
  }
}

async function writeShard(teamName, agentName, count) {
  await mkdir(shardDir(teamName), { recursive: true })
  await writeFile(agentShardPath(teamName, agentName), JSON.stringify({ count }))
}

/**
 * Resolve the turn limit for a given agent. Returns null (no limit) when:
 *   - team has no turnLimits config, OR
 *   - no per-agent or default limit is set.
 *
 * turnLimits schema (in team config):
 *   { default: number|null, perAgent: { [name]: number } }
 */
function resolveLimit(team, agentName) {
  const cfg = team.turnLimits
  if (!cfg || typeof cfg !== 'object') return null
  if (cfg.perAgent && typeof cfg.perAgent[agentName] === 'number') {
    return cfg.perAgent[agentName]
  }
  if (typeof cfg.default === 'number') return cfg.default
  return null
}

/**
 * Increment the turn counter for `agentName`. If the new count exceeds the
 * limit, returns { over_limit: true, limit, count }. Otherwise returns
 * { over_limit: false, count, limit }.
 *
 * Atomic: acquired under a per-agent lock (Step 3a) so concurrent writes
 * from different agents do not contend.
 */
export async function recordTurn(teamName, agentName) {
  const team = await readTeam(teamName)
  if (!team) return { over_limit: false, count: 0, limit: null }

  await migrateLegacyOnce(teamName)
  const limit = resolveLimit(team, agentName)
  const path = agentShardPath(teamName, agentName)
  await ensureDir(shardDir(teamName))

  let count = 0
  await withLock(path, async () => {
    count = (await readShard(teamName, agentName)) + 1
    await writeShard(teamName, agentName, count)
  }, { lockfilePath: `${path}.lock` })

  if (limit !== null && count > limit) {
    return { over_limit: true, count, limit }
  }
  return { over_limit: false, count, limit }
}

/**
 * Reset turn counters. Pass agentName=null to reset all agents on the team.
 */
export async function resetTurns(teamName, agentName = null) {
  await migrateLegacyOnce(teamName)
  if (agentName === null) {
    // Wipe entire shard dir + recreate empty (matches legacy "{}" semantics)
    await rm(shardDir(teamName), { recursive: true, force: true })
    return
  }
  const path = agentShardPath(teamName, agentName)
  await ensureDir(shardDir(teamName))
  await withLock(path, async () => {
    await unlink(path).catch(e => { if (!isEnoent(e)) throw e })
  }, { lockfilePath: `${path}.lock` })
}

/**
 * Set a turn limit. Pass agentName=null to set the team default.
 * Pass limit=null to remove the limit.
 *
 * (Unchanged from pre-shard: limits live in team config, not the counts file.)
 */
export async function setTurnLimit(teamName, agentName, limit) {
  const configPath = join(getTeamDir(teamName), 'config.json')
  await withLock(configPath, async () => {
    const raw = await readFile(configPath, 'utf-8')
    const team = JSON.parse(raw)
    team.turnLimits = team.turnLimits || { default: null, perAgent: {} }
    if (agentName === null) {
      team.turnLimits.default = limit
    } else if (limit === null) {
      delete team.turnLimits.perAgent[agentName]
    } else {
      team.turnLimits.perAgent[agentName] = limit
    }
    await writeFile(configPath, JSON.stringify(team, null, 2))
  }, { lockfilePath: `${configPath}.lock` })
}

/**
 * Aggregate all per-agent shards into a single { [agent]: count } object.
 * Same return shape as the pre-shard implementation.
 */
export async function getTurnCounts(teamName) {
  await migrateLegacyOnce(teamName)
  const dir = shardDir(teamName)
  let entries
  try {
    entries = await readdir(dir)
  } catch (e) {
    if (isEnoent(e)) return {}
    console.error(`[turns] getTurnCounts: ${errorMessage(e)}`)
    return {}
  }
  const out = {}
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const agent = f.slice(0, -5) // strip .json
    const count = await readShard(teamName, agent)
    if (count > 0) out[agent] = count
  }
  return out
}
