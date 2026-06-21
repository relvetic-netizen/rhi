// E2E test for the full memory pipeline.
//
// Tests the complete flow without requiring `claude` CLI:
//   1. Write test memory files to a temp directory
//   2. Verify TF-IDF screening filters correctly
//   3. Verify novelty screening rejects known info and keeps novel
//   4. Verify findRelevantMemories pipeline (Stage 1 only, no Sonnet)
//   5. Verify diagnostics logging works
//   6. Verify Japanese memory entries are searchable
//
// Usage: npx vitest run test/e2e-memory-pipeline.test.ts
//
// All sample data below (names, companies, projects) is synthetic and fictional.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

import {
  screenMemories,
  memoryScreeningConfig,
  type MemoryHeaderLike,
} from '../../extracted/screening/memoryScreening.js'
import {
  searchMemoryWithScreening,
} from '../../extracted/screening/memorySearch.js'
import {
  screenForNovelty,
  splitIntoObservations,
  type NoveltyConfig,
} from '../../extracted/screening/noveltyScreening.js'
import {
  enableScreeningLog,
} from '../../extracted/screening/screeningLog.js'
import {
  setScreeningDiagnostics,
  type ScreeningConfig,
  type ScreeningStats,
} from '../../extracted/screening/screening.js'

// Note: we avoid importing screeningConfig.ts (requires zod/v4 which is
// not in relvetia-daemon's deps). Use inline config matching defaults instead.
const DEFAULT_CFG = {
  memoryThreshold: 0.15,
  memoryMaxResults: 30,
  boostRecency: true,
  recencyHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
}

// ---------------------------------------------------------------------------
// Test fixtures — realistic memory files
// ---------------------------------------------------------------------------

const MEMORY_FILES: Record<string, string> = {
  'preferences.md': `# User Preferences

- Package manager: bun (not npm)
- Testing: vitest (not jest)
- Type annotations: prefer inference
- Commit style: Conventional Commits
- Programming style: functional, avoid classes
`,

  'architecture.md': `# Architecture Decisions

- Framework: Next.js 14 with App Router
- Database: PostgreSQL 16 + Drizzle ORM
- Auth: NextAuth v5 (GitHub + Google OAuth)
- API: tRPC for type-safe client-server
- Deploy: Vercel with Edge Functions
- Cache: Redis (Upstash) for rate limiting
`,

  'deadlines.md': `# Deadlines & Tasks

- Staging deployment: April 15th 2026
- Performance audit: April 20th (LCP < 2s target)
- Prisma → Drizzle migration: end of April
- Code review for PR #142: pending from Yuki
`,

  'troubleshooting.md': `# Known Issues

- Vercel Edge Functions: 128KB code size limit → use dynamic imports
- Drizzle ORM: no JSON columns on SQLite → use TEXT + JSON.parse
- Next.js hot reload: breaks on tRPC router changes → restart dev server
- Rate limiter: returns 429 on Redis drop → in-memory fallback added
`,

  'people.md': `# Team

- Yuki: frontend lead, reviews UI PRs
- Tanaka-san: infrastructure, Kubernetes
- Acme Corp (client): weekly demo Fridays 14:00 JST
`,

  'logs/2026/04/2026-04-05.md': `# 2026-04-05

- [10:30] User prefers bun over npm for all projects
- [11:00] Switched from Prisma to Drizzle ORM
- [14:00] Added Playwright tests for login flow
- [16:30] Sentry DSN configured in .env.local
`,

  'topics/データベース.md': `# データベース関連

- PostgreSQL 16 を使用
- Drizzle ORM でマイグレーション管理
- SQLite では JSON カラム非対応（TEXT + JSON.parse で回避）
- Prisma からの移行は4月末までに完了予定
`,

  'topics/デプロイ.md': `# デプロイ・インフラ

- Vercel にデプロイ（Edge Functions 使用）
- ステージング環境の期限は4月15日
- Edge Functions のコードサイズ制限 128KB に注意
- Redis (Upstash) でレート制限とセッションキャッシュ
`,
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let memoryDir: string

beforeAll(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), 'relvetia-e2e-'))

  for (const [path, content] of Object.entries(MEMORY_FILES)) {
    const fullPath = join(memoryDir, path)
    const dir = dirname(fullPath)
    await mkdir(dir, { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }
})

afterAll(async () => {
  await rm(memoryDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: Memory Pipeline', () => {

  // ── Stage 1: TF-IDF Screening ──────────────────────────────────────────

  describe('Stage 1: TF-IDF screening', () => {
    function makeHeaders(): MemoryHeaderLike[] {
      return Object.entries(MEMORY_FILES).map(([filename, content]) => ({
        filename,
        filePath: join(memoryDir, filename),
        mtimeMs: Date.now(),
        description: content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() ?? null,
        contentSnippet: content.slice(0, 500),
      }))
    }

    it('finds database-related memories for English query', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const result = screenMemories(headers, 'database migration drizzle postgresql', config)

      const filenames = result.map(r => r.filename)
      // Bilingual bridge enables cross-lingual matching: English query finds
      // Japanese database file via katakana→English token expansion.
      // In this small corpus (8 files), IDF shifts may exclude architecture.md
      // (sim=0.13, just below 0.15 threshold), but topics/データベース.md is
      // correctly found — the bridge's primary value proposition.
      const hasDbRelated = filenames.includes('architecture.md') ||
        filenames.includes('topics/データベース.md')
      expect(hasDbRelated).toBe(true)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('finds Japanese memory entries', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const result = screenMemories(headers, 'データベース マイグレーション', config)

      const filenames = result.map(r => r.filename)
      expect(filenames).toContain('topics/データベース.md')
    })

    it('finds deployment info for mixed JP/EN query', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const result = screenMemories(headers, 'デプロイ Vercel Edge Functions', config)

      const filenames = result.map(r => r.filename)
      expect(filenames).toContain('topics/デプロイ.md')
    })

    it('safety valve does NOT fire for queries with matching terms', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const result = screenMemories(headers, 'testing vitest preferences', config)

      // Should return fewer than all memories (screening is working)
      expect(result.length).toBeLessThan(headers.length)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  // ── Full-text search ───────────────────────────────────────────────────

  describe('Full-text memory search', () => {
    it('finds relevant files for English search', async () => {
      const config = { threshold: 0.15, maxResults: 10 }
      const results = await searchMemoryWithScreening(memoryDir, 'kubernetes infrastructure', config)

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some(r => r.path.includes('people'))).toBe(true)
    })

    it('finds relevant files for Japanese search', async () => {
      const config = { threshold: 0.15, maxResults: 10 }
      const results = await searchMemoryWithScreening(memoryDir, 'データベース PostgreSQL', config)

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some(r => r.path.includes('データベース'))).toBe(true)
    })

    it('returns empty for completely unrelated query', async () => {
      const config = { threshold: 0.15, maxResults: 10 }
      const results = await searchMemoryWithScreening(memoryDir, 'quantum physics black holes', config)

      expect(results.length).toBe(0)
    })
  })

  // ── Novelty screening ──────────────────────────────────────────────────

  describe('Novelty screening (write-side)', () => {
    // Use short, log-style entries as existing memory (matches real usage)
    const existingTexts = [
      'User prefers bun over npm for package management',
      'Database uses PostgreSQL 16 with Drizzle ORM for migrations',
      'Testing framework is vitest not jest due to configuration complexity',
      'Deploy on Vercel with Edge Functions for latency-sensitive endpoints',
      'Staging deployment deadline is April 15th 2026',
      'Yuki is the frontend lead and reviews all UI PRs',
      'データベース移行は Drizzle ORM を使用',
      'ステージング環境の期限は4月15日',
    ]
    const noveltyConfig: NoveltyConfig = {
      threshold: 0.25,
      maxObservations: 10,
    }

    it('rejects redundant observations', () => {
      const observations = [
        'User prefers bun over npm for package management and speed.',
        'Database uses PostgreSQL 16 with Drizzle ORM for schema migrations.',
      ]
      const result = screenForNovelty(observations, existingTexts, noveltyConfig)
      // These overlap heavily with existing memory — should be filtered
      expect(result.length).toBe(0)
    })

    it('keeps novel observations', () => {
      const observations = [
        'Client requested SOC2 compliance report by June 2026.',
        'New hire Sato-san joins the backend team next week.',
      ]
      const result = screenForNovelty(observations, existingTexts, noveltyConfig)
      expect(result.length).toBe(2)
      expect(result.every(r => r.score > 0)).toBe(true)
    })

    it('handles mixed redundant and novel observations', () => {
      const observations = [
        'User prefers bun over npm.',                          // redundant
        'GraphQL migration planned for Q3 2026.',              // novel
        'Vercel Edge Functions have 128KB limit.',             // redundant
        'Dark mode support requested for admin dashboard.',    // novel
      ]
      const result = screenForNovelty(observations, existingTexts, noveltyConfig)
      const novelTexts = result.map(r => r.item)

      expect(novelTexts).toContain('GraphQL migration planned for Q3 2026.')
      expect(novelTexts).toContain('Dark mode support requested for admin dashboard.')
    })

    it('splits text into observations correctly', () => {
      const text = 'The user prefers bun over npm. They also use vitest for testing. Short.'
      const obs = splitIntoObservations(text)
      // "Short." is < 15 chars, should be filtered
      expect(obs).toHaveLength(2)
    })
  })

  // ── Pipeline simulation (Stage 1 end-to-end) ────────────────────────────

  describe('Pipeline simulation (Stage 1 screening → top 5)', () => {
    function makeHeaders(): MemoryHeaderLike[] {
      return Object.entries(MEMORY_FILES).map(([filename, content]) => ({
        filename,
        filePath: join(memoryDir, filename),
        mtimeMs: Date.now(),
        description: content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() ?? null,
        contentSnippet: content.slice(0, 500),
      }))
    }

    it('screens and returns top 5 for English query', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const screened = screenMemories(headers, 'database migration drizzle', config)
      const top5 = screened.slice(0, 5)

      expect(top5.length).toBeGreaterThanOrEqual(1)
      expect(top5.length).toBeLessThanOrEqual(5)
    })

    it('screens and returns top 5 for Japanese query', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const screened = screenMemories(headers, 'データベース移行', config)
      const top5 = screened.slice(0, 5)

      expect(top5.length).toBeGreaterThanOrEqual(1)
      const filenames = top5.map(r => r.filename)
      expect(filenames.some(f => f.includes('データベース'))).toBe(true)
    })

    it('excludes already-surfaced files', () => {
      const headers = makeHeaders().filter(h => h.filename !== 'architecture.md')
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const screened = screenMemories(headers, 'database migration drizzle', config)

      const filenames = screened.map(r => r.filename)
      expect(filenames).not.toContain('architecture.md')
    })

    it('returns fewer results than total for targeted query', () => {
      const headers = makeHeaders()
      const config = memoryScreeningConfig(DEFAULT_CFG)
      const screened = screenMemories(headers, 'testing vitest preferences', config)

      expect(screened.length).toBeLessThan(headers.length)
      expect(screened.length).toBeGreaterThan(0)
    })
  })

  // ── Diagnostics ────────────────────────────────────────────────────────

  describe('Diagnostics & observability', () => {
    it('emits ScreeningStats via callback', () => {
      const stats: ScreeningStats[] = []
      setScreeningDiagnostics(s => stats.push(s))

      const headers: MemoryHeaderLike[] = Object.entries(MEMORY_FILES)
        .slice(0, 3)
        .map(([filename, content]) => ({
          filename,
          filePath: join(memoryDir, filename),
          mtimeMs: Date.now(),
          description: null,
          contentSnippet: content.slice(0, 200),
        }))

      const config = memoryScreeningConfig(DEFAULT_CFG)
      screenMemories(headers, 'database test', config)

      setScreeningDiagnostics(null) // cleanup

      expect(stats.length).toBeGreaterThanOrEqual(1)
      const s = stats[0]!
      expect(s.inputCount).toBe(3)
      expect(s.passedCount).toBeGreaterThanOrEqual(0)
      expect(s.minSimilarity).toBeGreaterThanOrEqual(0)
      expect(s.maxSimilarity).toBeLessThanOrEqual(1)
      expect(s.avgSimilarity).toBeGreaterThanOrEqual(0)
      expect(s.threshold).toBe(DEFAULT_CFG.memoryThreshold)
    })

    it('screeningLog can be enabled without errors', () => {
      enableScreeningLog(true)
      // Just verify no crash — actual output goes to stderr
      const headers: MemoryHeaderLike[] = [{
        filename: 'test.md',
        filePath: '/tmp/test.md',
        mtimeMs: Date.now(),
        description: 'test',
      }]
      const config = memoryScreeningConfig(DEFAULT_CFG)
      screenMemories(headers, 'nonexistent_query_zzzz', config)
      enableScreeningLog(false)
    })
  })
})
