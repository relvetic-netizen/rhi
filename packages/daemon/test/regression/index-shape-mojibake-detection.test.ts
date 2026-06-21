import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkMojibakeAbsent } from '../../../extracted/memory/distillVerifier.js'

// ---------------------------------------------------------------------------
// Phase C regression fixture — mojibake-regex axis
// memory-hardening followup regression guard
//
// Intentional-break dogfood: a single `_index.md` with /\?{4,}/ MUST fail
// the axis. A topics tree with clean Japanese MUST pass. This pins the
// contract behind the Phase B regenerator (scripts/regenerate-index-md.mjs).
// ---------------------------------------------------------------------------

describe('regression: mojibake-regex detection', () => {
  let dir: string
  let topicsDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shape-mojibake-'))
    topicsDir = join(dir, 'topics')
    await mkdir(topicsDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('FAILS when a single _index.md has a mojibake run', async () => {
    const areaDir = join(topicsDir, 'architecture')
    await mkdir(areaDir, { recursive: true })
    await writeFile(
      join(areaDir, '_index.md'),
      '# Architecture Index\n\n- [foo](foo.md) — settings.json ? CLAUDE.md ????????\n',
      'utf8',
    )

    const result = await checkMojibakeAbsent(dir)
    expect(result.axis).toBe('mojibake-regex')
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(1)
    expect(result.samples[0]).toMatch(/architecture[\\/]_index\.md$/)
  })

  it('FAILS when a topic body file has a mojibake run', async () => {
    const areaDir = join(topicsDir, 'project-context')
    await mkdir(areaDir, { recursive: true })
    await writeFile(
      join(areaDir, 'ai-contracting-flow.md'),
      '# AI Contracting\n\nAI?????????????????? Discord thread UX ????\n',
      'utf8',
    )

    const result = await checkMojibakeAbsent(dir)
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(1)
    expect(result.samples[0]).toMatch(/ai-contracting-flow\.md$/)
  })

  it('FAILS with multiple offenders reported (capped at 5 samples)', async () => {
    for (let i = 0; i < 8; i++) {
      const areaDir = join(topicsDir, `area-${i}`)
      await mkdir(areaDir, { recursive: true })
      await writeFile(
        join(areaDir, '_index.md'),
        `# A${i}\n\n???????????? body\n`,
        'utf8',
      )
    }
    const result = await checkMojibakeAbsent(dir)
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(8)
    expect(result.samples).toHaveLength(5)
  })

  it('PASSES on clean Japanese topic bodies (mojibake-free baseline)', async () => {
    const areaDir = join(topicsDir, 'tooling')
    await mkdir(areaDir, { recursive: true })
    await writeFile(
      join(areaDir, '_index.md'),
      '# Tooling Index\n\n- [bun](bun.md) — Bun 1.3.11 を Windows にインストール済み。\n',
      'utf8',
    )
    await writeFile(
      join(areaDir, 'bun.md'),
      '# Bun\n\nBun 1.3.11 を Windows にインストール済み (2026-04-07)。\n',
      'utf8',
    )

    const result = await checkMojibakeAbsent(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
  })

  it('PASSES when topics dir is absent (treated as clean)', async () => {
    // dir exists but no topics/
    await rm(topicsDir, { recursive: true, force: true })
    const result = await checkMojibakeAbsent(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
  })

  it('does NOT match clean Japanese containing legitimate question marks', async () => {
    const areaDir = join(topicsDir, 'self')
    await mkdir(areaDir, { recursive: true })
    await writeFile(
      join(areaDir, 'environment.md'),
      '# Environment\n\nどんな環境? それとも別の?? 短い ?? は許容される。\n',
      'utf8',
    )

    const result = await checkMojibakeAbsent(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
  })
})
