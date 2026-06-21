// Regression: team_delete used to leave behind ~/.claude/teams/<team>/traces.jsonl
// because withSpan's finally-block processor called ensureDir on the just-removed
// team dir. Fix routes the team_delete span to the global trace path by setting
// span team_name to null (via { traceTeam: false } option in safeTool).
//
// This test exercises the fixed behavior end-to-end without going through the
// MCP server: it constructs the same span attrs that safeTool now produces and
// verifies the team dir stays gone, with audit preserved in the global path.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, stat, readFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withSpan, setProcessors } from '../tracing.js'
import { createTeam, deleteTeam } from '../team.js'
import { getTeamDir, ensureDir } from '../paths.js'

const TEST_TEAM = '__test-delete-residue__'
const TMP = join(process.cwd(), '.test-tmp-delete-residue')
const origDir = process.env.CLAUDE_CONFIG_DIR

before(() => { process.env.CLAUDE_CONFIG_DIR = TMP })
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  // Mirror the production jsonlSink: span.team_name decides the path.
  setProcessors([async (span) => {
    const path = span.team_name
      ? join(getTeamDir(span.team_name), 'traces.jsonl')
      : join(TMP, 'swarm-traces.jsonl')
    await ensureDir(dirname(path))
    await appendFile(path, JSON.stringify(span) + '\n')
  }])
})

describe('team_delete trace residue', () => {
  it('does NOT recreate the team dir when the span team_name is null', async () => {
    await createTeam(TEST_TEAM, [], 'test')
    await stat(getTeamDir(TEST_TEAM))  // sanity: dir exists

    // Simulates safeTool with { traceTeam: false } — span attrs.team_name = null.
    await withSpan('tool.team_delete', { tool: 'team_delete', team_name: null }, async () => {
      await deleteTeam(TEST_TEAM)
    })

    await assert.rejects(stat(getTeamDir(TEST_TEAM)), /ENOENT/)
  })

  it('writes the team_delete span to the global trace path (audit preserved)', async () => {
    await createTeam(TEST_TEAM, [], 'test')
    await withSpan('tool.team_delete', { tool: 'team_delete', team_name: null }, async () => {
      await deleteTeam(TEST_TEAM)
    })

    const content = await readFile(join(TMP, 'swarm-traces.jsonl'), 'utf-8')
    const span = JSON.parse(content.trim())
    assert.equal(span.name, 'tool.team_delete')
    assert.equal(span.team_name, null)
    assert.equal(span.status, 'ok')
  })
})
