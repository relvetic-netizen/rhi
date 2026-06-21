// Threshold tuning benchmark for screening.
//
// Generates realistic memory entries across multiple topics, then tests
// screening at various thresholds to find the optimal balance between:
//   - Precision: irrelevant items are rejected (not passed through)
//   - Recall: relevant items are kept (not rejected)
//   - Safety valve rate: how often ALL items get rejected (fallback)
//
// Usage: npx vitest run test/benchmark-threshold.ts
//
// All sample data below (names, companies, projects) is synthetic and fictional.

import { describe, it } from 'vitest'
import {
  screenItems,
  sharpnessFromThreshold,
  trimAndSquare,
  cosineSimilarity,
  tfidfVector,
  buildIdfMap,
  recencyFactor,
  type ScreeningConfig,
  type ScoredItem,
} from '../../extracted/screening/screening.js'
import {
  screenForNovelty,
  type NoveltyConfig,
} from '../../extracted/screening/noveltyScreening.js'

/**
 * Unclamped version of screenItems for benchmark exploration.
 * Allows r < 2 to test thresholds below 0.5.
 */
function screenItemsUnclamped<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  threshold: number,
  maxResults: number,
): ScoredItem<T>[] {
  if (items.length === 0 || query.trim().length === 0) return []

  const r = threshold >= 1 ? Infinity : Math.max(1 / (1 - threshold), 1.01)

  const allTexts = items.map(getText)
  allTexts.push(query)
  const idfMap = buildIdfMap(allTexts)

  const queryVec = tfidfVector(query, idfMap)
  if (queryVec.size === 0) return []

  const scored: ScoredItem<T>[] = []
  for (const item of items) {
    const itemVec = tfidfVector(getText(item), idfMap)
    const sim = cosineSimilarity(queryVec, itemVec)
    const score = trimAndSquare(sim, r)
    if (score > 0) {
      scored.push({ item, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, maxResults)
}

// ---------------------------------------------------------------------------
// Realistic memory corpus — simulates ~/.claude/memory after weeks of use
// ---------------------------------------------------------------------------

const MEMORY_ENTRIES = [
  // Architecture decisions
  'Project uses Next.js 14 with App Router and Server Components for the main web application',
  'Database is PostgreSQL 16 with Drizzle ORM. Migrations managed via drizzle-kit push',
  'Authentication handled by NextAuth v5 with GitHub and Google OAuth providers',
  'API routes use tRPC for type-safe client-server communication',
  'Deployed on Vercel with Edge Functions for latency-sensitive endpoints',
  'Redis (Upstash) for rate limiting and session caching',
  'Monorepo managed by Turborepo with packages/ui, packages/db, apps/web',

  // User preferences
  'User prefers bun over npm for package management',
  'Use vitest not jest for testing. User dislikes jest configuration complexity',
  'Type annotations are optional — user prefers inference over explicit typing',
  'User wants Japanese comments in code when working on Japanese projects',
  'Commit messages should follow Conventional Commits format',
  'User prefers functional programming style — avoid classes where possible',

  // Deadlines and tasks
  'Staging deployment deadline: April 15th 2026',
  'Performance audit scheduled for April 20th — target LCP under 2 seconds',
  'Code review for PR #142 pending from teammate Yuki',
  'Migration from Prisma to Drizzle ORM should be completed by end of April',

  // Troubleshooting notes
  'Known issue: Vercel Edge Functions have 128KB code size limit — use dynamic imports',
  'Drizzle ORM does not support JSON columns on SQLite — use TEXT with JSON.parse',
  'Next.js hot reload breaks when modifying tRPC router files — restart dev server',
  'Rate limiter returns 429 when Redis connection drops — added fallback to in-memory store',

  // External references
  'Design system Figma: https://figma.com/file/abc123 — last updated March 2026',
  'CI/CD pipeline runs on GitHub Actions — see .github/workflows/ci.yml',
  'Sentry DSN configured in .env.local for error tracking',
  'Linear project board: https://linear.app/team/project-phoenix',

  // People and context
  'Yuki is the frontend lead — reviews all UI PRs',
  'Tanaka-san manages the infrastructure and Kubernetes cluster',
  'Client (Acme Corp) prefers weekly demo calls on Fridays at 14:00 JST',

  // Recent observations (shorter, log-style)
  'User corrected: use sonnet not haiku for distillation tasks',
  'Switched from pnpm to bun after workspace resolution issues',
  'Added Zod validation to all API input schemas after security audit',
  'Playwright tests added for critical user flows — login, checkout, settings',

  // Japanese entries
  'データベース移行は Drizzle ORM を使用、Prisma からの移行を進行中',
  'フロントエンドのコンポーネント設計は Atomic Design パターンを採用',
  'デプロイは Vercel 経由、ステージング環境の期限は4月15日',
  'テストは vitest を使用、jest は設定が複雑なので避ける方針',
]

// ---------------------------------------------------------------------------
// Test queries — mix of relevant and semantic-gap queries
// ---------------------------------------------------------------------------

type TestQuery = {
  query: string
  /** Memory indices that SHOULD match (ground truth). */
  expectedMatches: number[]
  /** Description of what this query tests. */
  description: string
}

const TEST_QUERIES: TestQuery[] = [
  {
    query: 'database migration drizzle',
    expectedMatches: [1, 16, 19],
    description: 'Direct keyword match — DB migration',
  },
  {
    query: 'testing framework vitest',
    expectedMatches: [8, 30],
    description: 'Direct keyword match — testing preference',
  },
  {
    query: 'deployment vercel edge',
    expectedMatches: [4, 18],
    description: 'Direct keyword match — deployment infra',
  },
  {
    query: 'authentication login oauth',
    expectedMatches: [2],
    description: 'Direct keyword match — auth',
  },
  {
    query: 'package manager bun npm',
    expectedMatches: [7, 29],
    description: 'Direct keyword match — package manager',
  },
  {
    query: 'performance optimization speed',
    expectedMatches: [14],
    description: 'Partial overlap — performance audit',
  },
  {
    query: 'CI pipeline github actions workflow',
    expectedMatches: [22],
    description: 'Direct keyword match — CI/CD',
  },
  {
    query: 'who reviews frontend PRs',
    expectedMatches: [25],
    description: 'Semantic gap — "who" vs person name',
  },
  {
    query: 'project deadline schedule',
    expectedMatches: [13, 14, 16],
    description: 'Partial overlap — deadlines',
  },
  {
    query: 'error monitoring logging',
    expectedMatches: [23],
    description: 'Semantic gap — "error monitoring" vs Sentry',
  },
  {
    query: 'type safety validation schema',
    expectedMatches: [3, 30],
    description: 'Partial overlap — tRPC + Zod',
  },
  {
    query: 'kubernetes infrastructure cluster',
    expectedMatches: [26],
    description: 'Direct keyword match — infra person',
  },
  {
    query: 'データベース移行 Drizzle',
    expectedMatches: [32],
    description: 'Japanese + English — DB migration',
  },
  {
    query: 'フロントエンド コンポーネント 設計',
    expectedMatches: [33],
    description: 'Japanese — frontend component design',
  },
  {
    query: 'テスト vitest フレームワーク',
    expectedMatches: [8, 35],
    description: 'Mixed JP/EN — testing framework',
  },
  {
    query: 'デプロイ ステージング 期限',
    expectedMatches: [34],
    description: 'Japanese — deployment deadline',
  },
]

// ---------------------------------------------------------------------------
// Novelty test cases
// ---------------------------------------------------------------------------

type NoveltyTestCase = {
  observation: string
  /** true = should be kept (novel), false = should be rejected (redundant) */
  expectedNovel: boolean
  description: string
}

const NOVELTY_TESTS: NoveltyTestCase[] = [
  {
    observation: 'The user prefers bun over npm for package management.',
    expectedNovel: false,
    description: 'Redundant — exact match in memory',
  },
  {
    observation: 'User switched from pnpm to bun due to workspace issues.',
    expectedNovel: false,
    description: 'Redundant — already recorded as observation',
  },
  {
    observation: 'Database backup strategy: daily pg_dump to S3 with 30-day retention.',
    expectedNovel: true,
    description: 'Novel — backup strategy not in memory',
  },
  {
    observation: 'User wants dark mode support in the admin dashboard.',
    expectedNovel: true,
    description: 'Novel — new feature request',
  },
  {
    observation: 'Vitest is the preferred testing framework instead of jest.',
    expectedNovel: false,
    description: 'Redundant — already in preferences',
  },
  {
    observation: 'Client requested SOC2 compliance report by June.',
    expectedNovel: true,
    description: 'Novel — new deadline/requirement',
  },
  {
    observation: 'Next.js App Router used for the web application.',
    expectedNovel: false,
    description: 'Redundant — architecture already recorded',
  },
  {
    observation: 'Redis cluster migration planned for May — moving from Upstash to self-hosted.',
    expectedNovel: true,
    description: 'Novel — infrastructure change plan',
  },
]

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

const THRESHOLDS_READ = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.55, 0.60, 0.667]
const THRESHOLDS_NOVELTY = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]

function runReadBenchmark() {
  console.log('=' .repeat(80))
  console.log('READ-SIDE SCREENING BENCHMARK (memory pre-filter)')
  console.log('=' .repeat(80))
  console.log(`Corpus: ${MEMORY_ENTRIES.length} memory entries, ${TEST_QUERIES.length} test queries\n`)

  const results: Array<{
    threshold: number
    r: number
    avgPrecision: number
    avgRecall: number
    safetyValveRate: number
    avgPassRate: number
  }> = []

  for (const threshold of THRESHOLDS_READ) {
    const r = threshold >= 1 ? Infinity : Math.max(1 / (1 - threshold), 1.01)

    let totalPrecision = 0
    let totalRecall = 0
    let safetyValveCount = 0
    let totalPassRate = 0

    for (const tq of TEST_QUERIES) {
      const scored = screenItemsUnclamped(
        MEMORY_ENTRIES,
        (x: string) => x,
        tq.query,
        threshold,
        50,
      )

      const passedIndices = new Set(
        scored.map(s => MEMORY_ENTRIES.indexOf(s.item)),
      )

      // Safety valve: all rejected → screening falls back to returning ALL items.
      // Therefore recall = 100% (every expected match is included) and
      // precision = expectedMatches / totalItems.
      if (scored.length === 0) {
        safetyValveCount++
        totalPassRate += 1
        totalRecall += 1
        totalPrecision += tq.expectedMatches.length / MEMORY_ENTRIES.length
        continue
      }

      totalPassRate += scored.length / MEMORY_ENTRIES.length

      // Recall: what fraction of expected matches were found?
      const foundExpected = tq.expectedMatches.filter(i => passedIndices.has(i)).length
      const recall = tq.expectedMatches.length > 0
        ? foundExpected / tq.expectedMatches.length
        : 1

      // Precision: what fraction of passed items are expected matches?
      const truePositives = tq.expectedMatches.filter(i => passedIndices.has(i)).length
      const precision = scored.length > 0
        ? truePositives / scored.length
        : 0

      totalPrecision += precision
      totalRecall += recall
    }

    const n = TEST_QUERIES.length
    results.push({
      threshold,
      r,
      avgPrecision: totalPrecision / n,
      avgRecall: totalRecall / n,
      safetyValveRate: safetyValveCount / n,
      avgPassRate: totalPassRate / n,
    })
  }

  // Print results table
  console.log(
    'threshold |   r  | precision | recall | safety_valve | pass_rate',
  )
  console.log('-'.repeat(70))
  for (const r of results) {
    console.log(
      `  ${r.threshold.toFixed(3)}   | ${r.r.toFixed(1).padStart(4)} | ` +
      `  ${(r.avgPrecision * 100).toFixed(1).padStart(5)}%  | ${(r.avgRecall * 100).toFixed(1).padStart(5)}% | ` +
      `   ${(r.safetyValveRate * 100).toFixed(1).padStart(5)}%    | ${(r.avgPassRate * 100).toFixed(1).padStart(5)}%`,
    )
  }
  console.log()

  // Recommend
  const best = results.reduce((a, b) => {
    // F1-like score weighted by safety valve penalty
    const f1a = 2 * a.avgPrecision * a.avgRecall / (a.avgPrecision + a.avgRecall || 1)
    const f1b = 2 * b.avgPrecision * b.avgRecall / (b.avgPrecision + b.avgRecall || 1)
    const scoreA = f1a * (1 - a.safetyValveRate)
    const scoreB = f1b * (1 - b.safetyValveRate)
    return scoreA >= scoreB ? a : b
  })
  console.log(`RECOMMENDED read threshold: ${best.threshold} (r=${best.r.toFixed(1)})`)
  console.log(`  F1-adjusted: precision=${(best.avgPrecision*100).toFixed(1)}%, recall=${(best.avgRecall*100).toFixed(1)}%, safety_valve=${(best.safetyValveRate*100).toFixed(1)}%`)
  console.log()

  return best.threshold
}

function runNoveltyBenchmark() {
  console.log('=' .repeat(80))
  console.log('WRITE-SIDE NOVELTY SCREENING BENCHMARK')
  console.log('=' .repeat(80))
  console.log(`Corpus: ${MEMORY_ENTRIES.length} memory entries, ${NOVELTY_TESTS.length} test observations\n`)

  const results: Array<{
    threshold: number
    r: number
    accuracy: number
    trueNovelRate: number
    falseNovelRate: number
    trueRedundantRate: number
    falseRedundantRate: number
  }> = []

  for (const threshold of THRESHOLDS_NOVELTY) {
    const config: NoveltyConfig = { threshold, maxObservations: 50 }

    const observations = NOVELTY_TESTS.map(t => t.observation)
    const scored = screenForNovelty(observations, MEMORY_ENTRIES, config)
    const novelSet = new Set(scored.map(s => s.item))

    let trueNovel = 0     // correctly kept novel
    let falseNovel = 0    // incorrectly kept redundant
    let trueRedundant = 0 // correctly rejected redundant
    let falseRedundant = 0 // incorrectly rejected novel

    for (const tc of NOVELTY_TESTS) {
      const isNovel = novelSet.has(tc.observation)
      if (tc.expectedNovel && isNovel) trueNovel++
      else if (!tc.expectedNovel && isNovel) falseNovel++
      else if (!tc.expectedNovel && !isNovel) trueRedundant++
      else if (tc.expectedNovel && !isNovel) falseRedundant++
    }

    const total = NOVELTY_TESTS.length
    results.push({
      threshold,
      r: Math.max(1 / threshold, 2),
      accuracy: (trueNovel + trueRedundant) / total,
      trueNovelRate: trueNovel / total,
      falseNovelRate: falseNovel / total,
      trueRedundantRate: trueRedundant / total,
      falseRedundantRate: falseRedundant / total,
    })
  }

  console.log(
    'threshold |   r  | accuracy | true_novel | false_novel | true_redundant | false_redundant',
  )
  console.log('-'.repeat(95))
  for (const r of results) {
    console.log(
      `  ${r.threshold.toFixed(2)}    | ${r.r.toFixed(1).padStart(4)} | ` +
      ` ${(r.accuracy * 100).toFixed(1).padStart(5)}%  | ` +
      `  ${(r.trueNovelRate * 100).toFixed(1).padStart(5)}%   | ` +
      `  ${(r.falseNovelRate * 100).toFixed(1).padStart(5)}%    | ` +
      `    ${(r.trueRedundantRate * 100).toFixed(1).padStart(5)}%      | ` +
      `     ${(r.falseRedundantRate * 100).toFixed(1).padStart(5)}%`,
    )
  }
  console.log()

  const best = results.reduce((a, b) => a.accuracy >= b.accuracy ? a : b)
  console.log(`RECOMMENDED novelty threshold: ${best.threshold} (r=${best.r.toFixed(1)})`)
  console.log(`  Accuracy: ${(best.accuracy * 100).toFixed(1)}%`)
  console.log()

  return best.threshold
}

function runSimilarityDistribution() {
  console.log('=' .repeat(80))
  console.log('RAW COSINE SIMILARITY DISTRIBUTION')
  console.log('=' .repeat(80))
  console.log()

  // Build IDF from full corpus
  const allTexts = [...MEMORY_ENTRIES]
  const queries = TEST_QUERIES.map(q => q.query)
  const idfMap = buildIdfMap([...allTexts, ...queries])

  const allSims: number[] = []
  const matchSims: number[] = []
  const nonMatchSims: number[] = []

  for (const tq of TEST_QUERIES) {
    const queryVec = tfidfVector(tq.query, idfMap)
    for (let i = 0; i < MEMORY_ENTRIES.length; i++) {
      const itemVec = tfidfVector(MEMORY_ENTRIES[i]!, idfMap)
      const sim = cosineSimilarity(queryVec, itemVec)
      allSims.push(sim)
      if (tq.expectedMatches.includes(i)) {
        matchSims.push(sim)
      } else {
        nonMatchSims.push(sim)
      }
    }
  }

  const stats = (arr: number[]) => {
    if (arr.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0 }
    const sorted = [...arr].sort((a, b) => a - b)
    return {
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      avg: arr.reduce((a, b) => a + b, 0) / arr.length,
      p50: sorted[Math.floor(sorted.length * 0.5)]!,
      p90: sorted[Math.floor(sorted.length * 0.9)]!,
    }
  }

  const all = stats(allSims)
  const match = stats(matchSims)
  const nonMatch = stats(nonMatchSims)

  console.log('             |   min   |   max   |   avg   |   p50   |   p90')
  console.log('-'.repeat(70))
  console.log(`All pairs    | ${all.min.toFixed(3).padStart(6)} | ${all.max.toFixed(3).padStart(6)} | ${all.avg.toFixed(3).padStart(6)} | ${all.p50.toFixed(3).padStart(6)} | ${all.p90.toFixed(3).padStart(6)}`)
  console.log(`Matches      | ${match.min.toFixed(3).padStart(6)} | ${match.max.toFixed(3).padStart(6)} | ${match.avg.toFixed(3).padStart(6)} | ${match.p50.toFixed(3).padStart(6)} | ${match.p90.toFixed(3).padStart(6)}`)
  console.log(`Non-matches  | ${nonMatch.min.toFixed(3).padStart(6)} | ${nonMatch.max.toFixed(3).padStart(6)} | ${nonMatch.avg.toFixed(3).padStart(6)} | ${nonMatch.p50.toFixed(3).padStart(6)} | ${nonMatch.p90.toFixed(3).padStart(6)}`)
  console.log()

  // Key insight: ideal threshold sits between match-min and non-match-max
  console.log(`KEY INSIGHT: Ideal threshold should be between:`)
  console.log(`  Non-match p90 = ${nonMatch.p90.toFixed(3)} (reject most irrelevant)`)
  console.log(`  Match min     = ${match.min.toFixed(3)} (keep all relevant)`)
  console.log()
}

// ---------------------------------------------------------------------------
// Main — wrapped in vitest describe for runner compatibility
// ---------------------------------------------------------------------------

describe('threshold benchmark', () => {
  it('runs full benchmark', () => {
    console.log()
    runSimilarityDistribution()
    const bestRead = runReadBenchmark()
    const bestNovelty = runNoveltyBenchmark()

    console.log('=' .repeat(80))
    console.log('SUMMARY')
    console.log('=' .repeat(80))
    console.log(`  Current read threshold:    0.667  →  Recommended: ${bestRead}`)
    console.log(`  Current novelty threshold: 0.4    →  Recommended: ${bestNovelty}`)
    console.log()
  })
})
