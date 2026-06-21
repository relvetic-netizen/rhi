import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'

function getConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function getTeamsDir() {
  return join(getConfigDir(), 'teams')
}

export function getTasksDir() {
  return join(getConfigDir(), 'tasks')
}

export function getTeamDir(teamName) {
  return join(getTeamsDir(), sanitize(teamName))
}

export function getInboxDir(teamName) {
  return join(getTeamDir(teamName), 'inboxes')
}

export function getInboxPath(teamName, agentName) {
  return join(getInboxDir(teamName), `${sanitize(agentName)}.json`)
}

export function getTeamConfigPath(teamName) {
  return join(getTeamDir(teamName), 'config.json')
}

export function getTaskListDir(teamName) {
  return join(getTasksDir(), sanitize(teamName))
}

export function getTaskPath(teamName, taskId) {
  return join(getTaskListDir(teamName), `${taskId}.json`)
}

export function getHighWaterMarkPath(teamName) {
  return join(getTaskListDir(teamName), '.highwatermark')
}

export function getTaskLockPath(teamName) {
  return join(getTaskListDir(teamName), '.lock')
}

/**
 * Sanitize a name for use as a filesystem path component.
 * Removes path traversal sequences, lowercases, replaces special chars with '-'.
 */
export function sanitize(name) {
  const result = name
    .replace(/\.\./g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')  // trim leading/trailing dashes
  if (!result) throw new Error(`Invalid name: "${name}" produces empty string after sanitization`)
  return result
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true })
}
