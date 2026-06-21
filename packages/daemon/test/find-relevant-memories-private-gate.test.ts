import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { findRelevantMemories } from '../../extracted/screening/findRelevantMemories.js'

const tempDirs: string[] = []
const ORIGINAL_INCLUDE_PRIVATE = process.env.RELVETIA_INCLUDE_PRIVATE

async function makeMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-find-private-'))
  tempDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = join(dir, ...rel.split('/'))
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }
  return dir
}

function normalizedFilename(m: { filename: string }): string {
  return m.filename.replace(/\\/g, '/')
}

beforeEach(() => {
  delete process.env.RELVETIA_INCLUDE_PRIVATE
})

afterEach(async () => {
  if (ORIGINAL_INCLUDE_PRIVATE === undefined) {
    delete process.env.RELVETIA_INCLUDE_PRIVATE
  } else {
    process.env.RELVETIA_INCLUDE_PRIVATE = ORIGINAL_INCLUDE_PRIVATE
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
})

describe('findRelevantMemories private gate', () => {
  it('excludes private/ files from scanMemoryFiles by default', async () => {
    const memoryDir = await makeMemoryDir({
      'private/private.md': '# private\nuniquetokenABC content from diary',
      'topics/public.md': '# public\nuniquetokenABC content from a public topic',
    })

    const result = await findRelevantMemories('uniquetokenABC', memoryDir, {
      enableSonnet: false,
      enableMultiResolution: true,
    })

    const filenames = result.map(normalizedFilename)
    expect(filenames.some(f => f.startsWith('private/'))).toBe(false)
  })

  it('safety valve fallback drops private/ even when zero hits and private is the newest file', async () => {
    const memoryDir = await makeMemoryDir({
      'private/private.md': 'sensitive diary content nobody else may see',
      'topics/public.md': 'ordinary public material',
    })

    const now = new Date()
    const past = new Date(Date.now() - 60_000)
    await utimes(join(memoryDir, 'private', 'private.md'), now, now)
    await utimes(join(memoryDir, 'topics', 'public.md'), past, past)

    const result = await findRelevantMemories('xyzdoesnotmatch9999', memoryDir, {
      enableSonnet: false,
      enableMultiResolution: true,
    })

    expect(
      result.find(r => r.path.replace(/\\/g, '/').includes('/private/')),
    ).toBeUndefined()
  })

  it('includes private/ files when opted in via RELVETIA_INCLUDE_PRIVATE=1', async () => {
    process.env.RELVETIA_INCLUDE_PRIVATE = '1'
    const memoryDir = await makeMemoryDir({
      'private/private.md': '# private\nuniquetokenDEF content from diary',
      'topics/public.md': 'unrelated material',
    })

    const result = await findRelevantMemories('uniquetokenDEF', memoryDir, {
      enableSonnet: false,
      enableMultiResolution: true,
    })

    const filenames = result.map(normalizedFilename)
    expect(filenames.some(f => f.startsWith('private/'))).toBe(true)
  })
})
