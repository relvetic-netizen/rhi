// Team management — modeled on Claude Code's teamHelpers.ts
// Key patterns adopted:
//   - Async cleanup with per-step try/catch and logging (teamHelpers.ts:661-682)
//   - execFile instead of execSync (non-blocking)
//   - Error logging on all failure paths

import { readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getTeamConfigPath, getInboxDir, getTaskListDir, getTeamDir, getTeamsDir, ensureDir, sanitize } from './paths.js'
import { withLock } from './lockfile.js'
import { writeFileAtomic } from './fs-utils.js'
import { resetTaskList } from './tasks.js'
import { errorMessage, isEnoent } from './errors.js'

const execFileAsync = promisify(execFile)

const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

export async function createTeam(teamName, members, description) {
  const configPath = getTeamConfigPath(teamName)
  await ensureDir(getInboxDir(teamName))
  await ensureDir(getTaskListDir(teamName))

  const safeName = sanitize(teamName)
  const teamFile = {
    name: teamName,
    description: description || '',
    createdAt: Date.now(),
    leadAgentId: `team-lead@${safeName}`,
    members: [
      {
        agentId: `team-lead@${safeName}`,
        name: 'team-lead',
        role: 'coordinator',
        model: 'claude-opus-4-8[1m]',
        color: 'white',
        joinedAt: Date.now(),
        cwd: process.cwd(),
        isActive: true,
      },
      ...members.map((m, i) => ({
        agentId: `${sanitize(m.name)}@${safeName}`,
        name: m.name,
        role: m.role || m.name,
        prompt: m.prompt || '',
        model: m.model || '',
        effort: m.effort || '',
        color: COLORS[i % COLORS.length],
        joinedAt: Date.now(),
        cwd: m.cwd || process.cwd(),
        isActive: false,
      })),
    ],
  }

  await writeFileAtomic(configPath, JSON.stringify(teamFile, null, 2))
  await resetTaskList(teamName)
  return teamFile
}

export async function readTeam(teamName) {
  try {
    const data = await readFile(getTeamConfigPath(teamName), 'utf-8')
    const parsed = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object' || !parsed.name) {
      console.error(`[team] Invalid team config for "${teamName}"`)
      return null
    }
    return parsed
  } catch (e) {
    if (isEnoent(e)) return null
    console.error(`[team] Failed to read team "${teamName}": ${errorMessage(e)}`)
    return null
  }
}

export async function updateMemberStatus(teamName, agentName, isActive) {
  const configPath = getTeamConfigPath(teamName)
  const lockFilePath = `${configPath}.lock`

  await withLock(configPath, async () => {
    let team
    try {
      team = JSON.parse(await readFile(configPath, 'utf-8'))
    } catch (e) {
      console.error(`[team] Failed to read team config for status update: ${errorMessage(e)}`)
      return
    }

    const member = team.members.find(m => m.name === agentName)
    if (member) {
      member.isActive = isActive
      member.lastUpdated = Date.now()
    }
    await writeFileAtomic(configPath, JSON.stringify(team, null, 2))
  }, { lockfilePath: lockFilePath })
}

/**
 * Delete a team and all associated data.
 * Modeled on teamHelpers.ts:641-683: per-step try/catch with logging.
 */
export async function deleteTeam(teamName) {
  const teamDir = getTeamDir(teamName)
  const taskDir = getTaskListDir(teamName)
  const safeName = sanitize(teamName)

  // Kill tmux session (async, non-blocking)
  try {
    await execFileAsync('tmux', ['kill-session', '-t', `relvetia-team-${safeName}`])
    console.log(`[team] Killed tmux session relvetia-team-${safeName}`)
  } catch (e) {
    // Expected to fail if no session exists, or if tmux is not installed
    // (common on Windows). ENOENT is spawn's error when the binary is missing.
    const msg = errorMessage(e)
    if (e?.code !== 'ENOENT' && !msg.includes('no session') && !msg.includes('session not found')) {
      console.error(`[team] Failed to kill tmux session: ${msg}`)
    }
  }

  // Clean up team directory
  try {
    await rm(teamDir, { recursive: true, force: true })
    console.log(`[team] Cleaned up team directory: ${teamDir}`)
  } catch (e) {
    console.error(`[team] Failed to clean up team directory ${teamDir}: ${errorMessage(e)}`)
  }

  // Clean up tasks directory
  try {
    await rm(taskDir, { recursive: true, force: true })
    console.log(`[team] Cleaned up tasks directory: ${taskDir}`)
  } catch (e) {
    console.error(`[team] Failed to clean up tasks directory ${taskDir}: ${errorMessage(e)}`)
  }
}

export async function listTeams() {
  const { readdir } = await import('node:fs/promises')
  try {
    const dirs = await readdir(getTeamsDir())
    const teams = []
    for (const dir of dirs) {
      const team = await readTeam(dir)
      if (team) teams.push(team)
    }
    return teams
  } catch (e) {
    if (isEnoent(e)) return []
    console.error(`[team] Failed to list teams: ${errorMessage(e)}`)
    return []
  }
}

/**
 * Clone an existing member into a new member with optional overrides.
 * Mirrors OpenAI Agents SDK's Agent.clone(). Useful for creating role
 * variants (e.g. an A/B version of an implementer) without duplicating
 * the full member definition.
 *
 * @param {string} teamName
 * @param {string} fromName
 * @param {string} toName
 * @param {object} [overrides] — any of: role, prompt, model, color, cwd
 * @returns {{ ok: boolean, member?: object, error?: string }}
 */
export async function cloneMember(teamName, fromName, toName, overrides = {}) {
  const configPath = getTeamConfigPath(teamName)
  let result = { ok: false, error: 'unknown' }

  await withLock(configPath, async () => {
    let team
    try {
      team = JSON.parse(await readFile(configPath, 'utf-8'))
    } catch (e) {
      result = { ok: false, error: `team not found: ${errorMessage(e)}` }
      return
    }

    const source = team.members.find(m => m.name === fromName)
    if (!source) {
      result = { ok: false, error: `source member "${fromName}" not found` }
      return
    }
    if (team.members.some(m => m.name === toName)) {
      result = { ok: false, error: `member "${toName}" already exists` }
      return
    }

    const safeName = sanitize(teamName)
    const clone = {
      ...source,
      agentId: `${sanitize(toName)}@${safeName}`,
      name: toName,
      role: overrides.role ?? source.role,
      prompt: overrides.prompt ?? source.prompt,
      model: overrides.model ?? source.model,
      effort: overrides.effort ?? source.effort,
      color: overrides.color ?? source.color,
      cwd: overrides.cwd ?? source.cwd,
      joinedAt: Date.now(),
      isActive: false,
      lastUpdated: Date.now(),
    }
    team.members.push(clone)
    await writeFileAtomic(configPath, JSON.stringify(team, null, 2))
    result = { ok: true, member: clone }
  }, { lockfilePath: `${configPath}.lock` })

  return result
}
