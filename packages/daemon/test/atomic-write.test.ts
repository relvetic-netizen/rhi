import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWrite, atomicWriteJSON } from '../../extracted/util/atomicWrite.js'

describe('atomicWrite', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-atomic-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes content to the final path', async () => {
    const p = join(dir, 'out.txt')
    await atomicWrite(p, 'hello')
    expect(await readFile(p, 'utf8')).toBe('hello')
  })

  it('overwrites an existing file', async () => {
    const p = join(dir, 'out.txt')
    await writeFile(p, 'old content')
    await atomicWrite(p, 'new content')
    expect(await readFile(p, 'utf8')).toBe('new content')
  })

  it('creates parent directories when missing', async () => {
    const p = join(dir, 'nested', 'deep', 'out.txt')
    await atomicWrite(p, 'ok')
    expect(await readFile(p, 'utf8')).toBe('ok')
  })

  it('does not leave tmp files after a successful write', async () => {
    const p = join(dir, 'out.txt')
    await atomicWrite(p, 'x')
    const entries = await readdir(dir)
    const tmps = entries.filter(e => e.includes('.tmp.'))
    expect(tmps).toEqual([])
  })

  it('concurrent writers do not corrupt one another', async () => {
    const p = join(dir, 'concurrent.json')
    // Launch 20 concurrent writes of distinct payloads. Final content must
    // match exactly one of them — never a mix.
    const payloads = Array.from({ length: 20 }, (_, i) => ({ n: i, tag: `writer-${i}` }))
    await Promise.all(payloads.map(p2 => atomicWriteJSON(p, p2)))

    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw)
    expect(payloads).toContainEqual(parsed)

    const entries = await readdir(dir)
    const tmps = entries.filter(e => e.includes('.tmp.'))
    expect(tmps).toEqual([])
  })

  it('atomicWriteJSON serializes with trailing newline', async () => {
    const p = join(dir, 'out.json')
    await atomicWriteJSON(p, { a: 1 })
    const raw = await readFile(p, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({ a: 1 })
  })

  it('readers always observe a valid JSON document', async () => {
    // Interleave writes and reads; readers must never see half-written JSON.
    const p = join(dir, 'race.json')
    await atomicWriteJSON(p, { n: 0 })

    const writers = Array.from({ length: 30 }, (_, i) =>
      atomicWriteJSON(p, { n: i }),
    )
    const readers = Array.from({ length: 30 }, async () => {
      const raw = await readFile(p, 'utf8')
      // If rename were non-atomic, JSON.parse would occasionally throw.
      return JSON.parse(raw)
    })

    await Promise.all([...writers, ...readers])
  })
})
