// Seed converter — transforms existing test fixtures into EvalCase format.
//
// Sources:
//   - benchmark-threshold.test.ts: MEMORY_ENTRIES (36), TEST_QUERIES (16), NOVELTY_TESTS (8)
//
// These fixtures are battle-tested and represent the ground truth for the
// screening pipeline. Converting them to EvalCases ensures the eval framework
// starts with high-quality, verified data.

import type { EvalCase, EvalSuite, EvalCategory } from './evalTypes.js'

// ---------------------------------------------------------------------------
// Memory corpus (from benchmark-threshold.test.ts)
// ---------------------------------------------------------------------------

const MEMORY_ENTRIES = [
  // Architecture decisions (indices 0-6)
  'Project uses Next.js 14 with App Router and Server Components for the main web application',
  'Database is PostgreSQL 16 with Drizzle ORM. Migrations managed via drizzle-kit push',
  'Authentication handled by NextAuth v5 with GitHub and Google OAuth providers',
  'API routes use tRPC for type-safe client-server communication',
  'Deployed on Vercel with Edge Functions for latency-sensitive endpoints',
  'Redis (Upstash) for rate limiting and session caching',
  'Monorepo managed by Turborepo with packages/ui, packages/db, apps/web',

  // User preferences (indices 7-12)
  'User prefers bun over npm for package management',
  'Use vitest not jest for testing. User dislikes jest configuration complexity',
  'Type annotations are optional — user prefers inference over explicit typing',
  'User wants Japanese comments in code when working on Japanese projects',
  'Commit messages should follow Conventional Commits format',
  'User prefers functional programming style — avoid classes where possible',

  // Deadlines and tasks (indices 13-16)
  'Staging deployment deadline: April 15th 2026',
  'Performance audit scheduled for April 20th — target LCP under 2 seconds',
  'Code review for PR #142 pending from teammate Yuki',
  'Migration from Prisma to Drizzle ORM should be completed by end of April',

  // Troubleshooting notes (indices 17-20)
  'Known issue: Vercel Edge Functions have 128KB code size limit — use dynamic imports',
  'Drizzle ORM does not support JSON columns on SQLite — use TEXT with JSON.parse',
  'Next.js hot reload breaks when modifying tRPC router files — restart dev server',
  'Rate limiter returns 429 when Redis connection drops — added fallback to in-memory store',

  // External references (indices 21-24)
  'Design system Figma: https://figma.com/file/abc123 — last updated March 2026',
  'CI/CD pipeline runs on GitHub Actions — see .github/workflows/ci.yml',
  'Sentry DSN configured in .env.local for error tracking',
  'Linear project board: https://linear.app/team/project-phoenix',

  // People and context (indices 25-27)
  'Yuki is the frontend lead — reviews all UI PRs',
  'Tanaka-san manages the infrastructure and Kubernetes cluster',
  'Client (Acme Corp) prefers weekly demo calls on Fridays at 14:00 JST',

  // Recent observations (indices 28-31)
  'User corrected: use sonnet not haiku for distillation tasks',
  'Switched from pnpm to bun after workspace resolution issues',
  'Added Zod validation to all API input schemas after security audit',
  'Playwright tests added for critical user flows — login, checkout, settings',

  // Japanese entries (indices 32-35)
  'データベース移行は Drizzle ORM を使用、Prisma からの移行を進行中',
  'フロントエンドのコンポーネント設計は Atomic Design パターンを採用',
  'デプロイは Vercel 経由、ステージング環境の期限は4月15日',
  'テストは vitest を使用、jest は設定が複雑なので避ける方針',
]

// ---------------------------------------------------------------------------
// Search eval cases from TEST_QUERIES
// ---------------------------------------------------------------------------

type SeedQuery = {
  query: string
  expectedMatches: number[]
  description: string
  category: EvalCategory
  tags?: string[]
}

const SEARCH_QUERIES: SeedQuery[] = [
  { query: 'database migration drizzle', expectedMatches: [1, 16, 19], description: 'Direct keyword match — DB migration', category: 'search-recall', tags: ['keyword', 'english'] },
  { query: 'testing framework vitest', expectedMatches: [8, 35], description: 'Direct keyword match — testing preference', category: 'search-recall', tags: ['keyword', 'english'] },
  { query: 'deployment vercel edge', expectedMatches: [4, 18], description: 'Direct keyword match — deployment infra', category: 'search-recall', tags: ['keyword', 'english'] },
  { query: 'authentication login oauth', expectedMatches: [2], description: 'Direct keyword match — auth', category: 'search-recall', tags: ['keyword', 'english'] },
  { query: 'package manager bun npm', expectedMatches: [7, 29], description: 'Direct keyword match — package manager', category: 'search-recall', tags: ['keyword', 'english'] },
  { query: 'performance optimization speed', expectedMatches: [14], description: 'Partial overlap — performance audit', category: 'search-recall', tags: ['semantic-gap', 'english'] },
  { query: 'CI pipeline github actions workflow', expectedMatches: [22], description: 'Direct keyword match — CI/CD', category: 'search-recall', tags: ['keyword', 'english'] },
  { query: 'who reviews frontend PRs', expectedMatches: [25], description: 'Semantic gap — "who" vs person name', category: 'search-recall', tags: ['semantic-gap', 'english'] },
  { query: 'project deadline schedule', expectedMatches: [13, 14, 16], description: 'Partial overlap — deadlines', category: 'search-recall', tags: ['semantic-gap', 'english'] },
  { query: 'error monitoring logging', expectedMatches: [23], description: 'Semantic gap — "error monitoring" vs Sentry', category: 'search-recall', tags: ['semantic-gap', 'english'] },
  { query: 'type safety validation schema', expectedMatches: [3, 30], description: 'Partial overlap — tRPC + Zod', category: 'search-recall', tags: ['semantic-gap', 'english'] },
  { query: 'kubernetes infrastructure cluster', expectedMatches: [26], description: 'Direct keyword match — infra person', category: 'search-recall', tags: ['keyword', 'english'] },
  // Cross-lingual queries
  { query: 'データベース移行 Drizzle', expectedMatches: [32], description: 'Japanese + English — DB migration', category: 'cross-lingual', tags: ['japanese', 'bilingual'] },
  { query: 'フロントエンド コンポーネント 設計', expectedMatches: [33], description: 'Japanese — frontend component design', category: 'cross-lingual', tags: ['japanese'] },
  { query: 'テスト vitest フレームワーク', expectedMatches: [8, 35], description: 'Mixed JP/EN — testing framework', category: 'cross-lingual', tags: ['japanese', 'bilingual'] },
  { query: 'デプロイ ステージング 期限', expectedMatches: [34], description: 'Japanese — deployment deadline', category: 'cross-lingual', tags: ['japanese'] },
]

// ---------------------------------------------------------------------------
// Precision eval cases (reuse search queries to verify no junk results)
// ---------------------------------------------------------------------------

const PRECISION_QUERIES: SeedQuery[] = [
  { query: 'database migration drizzle', expectedMatches: [1, 16, 19, 32], description: 'Precision check — DB migration should not return unrelated', category: 'search-precision', tags: ['precision', 'english'] },
  { query: 'authentication login oauth', expectedMatches: [2], description: 'Precision check — auth should not return DB/deploy entries', category: 'search-precision', tags: ['precision', 'english'] },
  { query: 'testing framework vitest', expectedMatches: [8, 35], description: 'Precision check — testing should be focused', category: 'search-precision', tags: ['precision', 'english'] },
]

// ---------------------------------------------------------------------------
// Novelty eval cases from NOVELTY_TESTS
// ---------------------------------------------------------------------------

type SeedNovelty = {
  observation: string
  expectedNovel: boolean
  description: string
}

const NOVELTY_CASES: SeedNovelty[] = [
  { observation: 'The user prefers bun over npm for package management.', expectedNovel: false, description: 'Redundant — exact match in memory' },
  { observation: 'User switched from pnpm to bun due to workspace issues.', expectedNovel: false, description: 'Redundant — already recorded as observation' },
  { observation: 'Database backup strategy: daily pg_dump to S3 with 30-day retention.', expectedNovel: true, description: 'Novel — backup strategy not in memory' },
  { observation: 'User wants dark mode support in the admin dashboard.', expectedNovel: true, description: 'Novel — new feature request' },
  { observation: 'Vitest is the preferred testing framework instead of jest.', expectedNovel: false, description: 'Redundant — already in preferences' },
  { observation: 'Client requested SOC2 compliance report by June.', expectedNovel: true, description: 'Novel — new deadline/requirement' },
  { observation: 'Next.js App Router used for the web application.', expectedNovel: false, description: 'Redundant — architecture already recorded' },
  { observation: 'Redis cluster migration planned for May — moving from Upstash to self-hosted.', expectedNovel: true, description: 'Novel — infrastructure change plan' },
]

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

const CREATED_AT = '2026-04-11'

export function convertSearchToEvalCases(): EvalCase[] {
  return SEARCH_QUERIES.map((q, i) => ({
    id: `seed_search_${String(i + 1).padStart(3, '0')}`,
    category: q.category,
    query: q.query,
    memoryEntries: MEMORY_ENTRIES,
    expectedMatchIndices: q.expectedMatches,
    description: q.description,
    source: 'benchmark' as const,
    tags: q.tags,
    createdAt: CREATED_AT,
  }))
}

export function convertPrecisionToEvalCases(): EvalCase[] {
  return PRECISION_QUERIES.map((q, i) => ({
    id: `seed_precision_${String(i + 1).padStart(3, '0')}`,
    category: q.category,
    query: q.query,
    memoryEntries: MEMORY_ENTRIES,
    expectedMatchIndices: q.expectedMatches,
    description: q.description,
    source: 'benchmark' as const,
    tags: q.tags,
    createdAt: CREATED_AT,
  }))
}

export function convertNoveltyToEvalCases(): EvalCase[] {
  return NOVELTY_CASES.map((n, i) => ({
    id: `seed_novelty_${String(i + 1).padStart(3, '0')}`,
    category: (n.expectedNovel ? 'novelty-accept' : 'novelty-reject') as EvalCategory,
    query: n.observation,
    memoryEntries: MEMORY_ENTRIES,
    expectedNovel: n.expectedNovel,
    description: n.description,
    source: 'benchmark' as const,
    tags: ['novelty'],
    createdAt: CREATED_AT,
  }))
}

/** Generate the full seed eval suite from all test fixtures. */
export function seedEvalSuite(): EvalSuite {
  const cases = [
    ...convertSearchToEvalCases(),
    ...convertPrecisionToEvalCases(),
    ...convertNoveltyToEvalCases(),
  ]

  return { version: 1, cases }
}
