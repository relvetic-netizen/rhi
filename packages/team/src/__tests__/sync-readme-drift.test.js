import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSync } from '../../scripts/sync-readme.mjs'

async function withCapturedConsole(fn) {
  const logs = []
  const errors = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const result = await fn()
    return { result, logs, errors, output: [...logs, ...errors].join('\n') }
  } finally {
    console.log = origLog
    console.error = origError
  }
}

async function makeFixture({ srcTools, docTools }) {
  const root = await mkdtemp(join(tmpdir(), 'sync-readme-'))
  await mkdir(join(root, 'src/__tests__'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(
    join(root, 'src/__tests__/dummy.test.js'),
    [
      'import test from "node:test"',
      'import assert from "node:assert/strict"',
      'test("dummy", () => assert.equal(1, 1))',
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'src/index.js'),
    [
      'function safeTool(server, name) {}',
      ...srcTools.map(name => `safeTool(server, '${name}', 'description', {}, async () => {})`),
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'README.md'),
    [
      `- **${srcTools.length} MCP tools**`,
      '- **1 tests, concurrent-safe**',
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'CLAUDE.md'),
    [
      '# Project',
      '',
      `## MCP Tools (${srcTools.length} total)`,
      '',
      ...docTools.map(name => `- \`${name}(...)\` \u2014 documented`),
      '',
      '## Development',
      '',
    ].join('\n')
  )
  return root
}

describe('sync-readme tool name drift', () => {
  it('passes when src/index.js and CLAUDE.md tool names match', async () => {
    const root = await makeFixture({ srcTools: ['team_create'], docTools: ['team_create'] })
    try {
      const { result, output } = await withCapturedConsole(() => runSync({ rootDir: root, mode: 'check' }))
      assert.equal(result.ok, true, output)
      assert.deepEqual(result.srcOnly, [])
      assert.deepEqual(result.docOnly, [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports srcOnly drift in check mode', async () => {
    const root = await makeFixture({ srcTools: ['team_create', 'team_new'], docTools: ['team_create'] })
    try {
      const { result, output } = await withCapturedConsole(() => runSync({ rootDir: root, mode: 'check' }))
      assert.equal(result.ok, false)
      assert.deepEqual(result.srcOnly, ['team_new'])
      assert.match(output, /\[sync-readme\] tool name drift in CLAUDE\.md:/)
      assert.match(output, /srcOnly: \[team_new\]/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports docOnly drift in check mode', async () => {
    const root = await makeFixture({ srcTools: ['team_create'], docTools: ['team_create', 'team_old'] })
    try {
      const { result, output } = await withCapturedConsole(() => runSync({ rootDir: root, mode: 'check' }))
      assert.equal(result.ok, false)
      assert.deepEqual(result.docOnly, ['team_old'])
      assert.match(output, /docOnly: \[team_old\]/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds srcOnly stubs to Other auto-stub in update mode', async () => {
    const root = await makeFixture({ srcTools: ['team_create', 'team_new'], docTools: ['team_create'] })
    try {
      const { result } = await withCapturedConsole(() => runSync({ rootDir: root, mode: 'update' }))
      assert.equal(result.ok, true)
      const claudeMd = await readFile(join(root, 'CLAUDE.md'), 'utf8')
      assert.match(claudeMd, /### Other \(auto-stub\)/)
      assert.match(claudeMd, /`team_new\(\.\.\.\)` \u2014 TODO: describe this tool/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not delete docOnly entries in update mode', async () => {
    const root = await makeFixture({ srcTools: ['team_create'], docTools: ['team_create', 'team_old'] })
    try {
      const { result } = await withCapturedConsole(() => runSync({ rootDir: root, mode: 'update' }))
      assert.equal(result.ok, true)
      assert.deepEqual(result.docOnly, ['team_old'])
      const claudeMd = await readFile(join(root, 'CLAUDE.md'), 'utf8')
      assert.match(claudeMd, /`team_old\(\.\.\.\)`/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
