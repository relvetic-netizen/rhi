// Dynamic instructions — inspired by OpenAI Agents SDK's callable `instructions`.
// Template variables available in member prompts:
//   {team}           — team name
//   {agent}          — this agent's name
//   {role}           — this agent's role
//   {members}        — comma-separated list of other members
//   {unread_count}   — number of unread messages in this agent's inbox
//   {open_tasks}     — count of pending + in_progress tasks owned by this agent
//   {total_tasks}    — total task count across team

import { readTeam } from './team.js'
import { readUnreadMessages } from './mailbox.js'
import { listTasks } from './tasks.js'
import { errorMessage } from './errors.js'

export async function buildContext(teamName, agentName) {
  const team = await readTeam(teamName)
  if (!team) return { team: teamName, agent: agentName }

  const member = team.members.find(m => m.name === agentName)
  const others = team.members
    .filter(m => m.name !== agentName)
    .map(m => m.name)
    .join(', ')

  const ctx = {
    team: team.name,
    agent: agentName,
    role: member?.role || agentName,
    members: others,
    unread_count: 0,
    open_tasks: 0,
    total_tasks: 0,
  }

  try {
    const unread = await readUnreadMessages(teamName, agentName)
    ctx.unread_count = unread.length
  } catch (e) {
    console.error(`[prompt-template] Failed to count unread: ${errorMessage(e)}`)
  }

  try {
    const tasks = await listTasks(teamName)
    ctx.total_tasks = tasks.length
    ctx.open_tasks = tasks.filter(
      t => (t.status === 'pending' || t.status === 'in_progress') && t.owner === agentName
    ).length
  } catch (e) {
    console.error(`[prompt-template] Failed to count tasks: ${errorMessage(e)}`)
  }

  return ctx
}

/**
 * Substitute {var} placeholders in `template` using `ctx`.
 * Unknown variables are left as-is so non-template strings pass through unchanged.
 */
export function render(template, ctx) {
  if (!template || typeof template !== 'string') return template || ''
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return String(ctx[key])
    return match
  })
}

/**
 * High-level: render a template string in the context of (team, agent).
 */
export async function renderForAgent(template, teamName, agentName) {
  const ctx = await buildContext(teamName, agentName)
  return render(template, ctx)
}
