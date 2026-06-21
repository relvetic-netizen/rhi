// Benchmark scenarios — test cases for Relvetia vs Vanilla comparison.
//
// Each scenario defines a query, memory corpus, and expected outcomes.
// Reuses MEMORY_ENTRIES from seedConverter.ts for consistency.

import type { BenchmarkScenario } from './benchmarkTypes.js'

// ---------------------------------------------------------------------------
// Shared memory corpus (36 entries from seedConverter.ts)
// ---------------------------------------------------------------------------

const MEMORY_ENTRIES = [
  // Architecture decisions (0-6)
  'Project uses Next.js 14 with App Router and Server Components for the main web application',
  'Database is PostgreSQL 16 with Drizzle ORM. Migrations managed via drizzle-kit push',
  'Authentication handled by NextAuth v5 with GitHub and Google OAuth providers',
  'API routes use tRPC for type-safe client-server communication',
  'Deployed on Vercel with Edge Functions for latency-sensitive endpoints',
  'Redis (Upstash) for rate limiting and session caching',
  'Monorepo managed by Turborepo with packages/ui, packages/db, apps/web',
  // User preferences (7-12)
  'User prefers bun over npm for package management',
  'Use vitest not jest for testing. User dislikes jest configuration complexity',
  'Type annotations are optional — user prefers inference over explicit typing',
  'User wants Japanese comments in code when working on Japanese projects',
  'Commit messages should follow Conventional Commits format',
  'User prefers functional programming style — avoid classes where possible',
  // Deadlines (13-16)
  'Staging deployment deadline: April 15th 2026',
  'Performance audit scheduled for April 20th — target LCP under 2 seconds',
  'Code review for PR #142 pending from teammate Yuki',
  'Migration from Prisma to Drizzle ORM should be completed by end of April',
  // Troubleshooting (17-20)
  'Known issue: Vercel Edge Functions have 128KB code size limit — use dynamic imports',
  'Drizzle ORM does not support JSON columns on SQLite — use TEXT with JSON.parse',
  'Next.js hot reload breaks when modifying tRPC router files — restart dev server',
  'Rate limiter returns 429 when Redis connection drops — added fallback to in-memory store',
  // External (21-24)
  'Design system Figma: https://figma.com/file/abc123 — last updated March 2026',
  'CI/CD pipeline runs on GitHub Actions — see .github/workflows/ci.yml',
  'Sentry DSN configured in .env.local for error tracking',
  'Linear project board: https://linear.app/team/project-phoenix',
  // People (25-27)
  'Yuki is the frontend lead — reviews all UI PRs',
  'Tanaka-san manages the infrastructure and Kubernetes cluster',
  'Client (Acme Corp) prefers weekly demo calls on Fridays at 14:00 JST',
  // Recent (28-31)
  'User corrected: use sonnet not haiku for distillation tasks',
  'Switched from pnpm to bun after workspace resolution issues',
  'Added Zod validation to all API input schemas after security audit',
  'Playwright tests added for critical user flows — login, checkout, settings',
  // Japanese (32-35)
  'データベース移行は Drizzle ORM を使用、Prisma からの移行を進行中',
  'フロントエンドのコンポーネント設計は Atomic Design パターンを採用',
  'デプロイは Vercel 経由、ステージング環境の期限は4月15日',
  'テストは vitest を使用、jest は設定が複雑なので避ける方針',
]

// ---------------------------------------------------------------------------
// Noise entries (unrelated to the project)
// ---------------------------------------------------------------------------

const NOISE_ENTRIES = [
  'The capital of France is Paris, known for the Eiffel Tower',
  'Python 3.12 introduced new syntax for type parameter declarations',
  'Photosynthesis converts carbon dioxide and water into glucose and oxygen',
  'The Great Wall of China stretches over 13,000 miles',
  'Machine learning models require large datasets for training',
  'The Pythagorean theorem states a² + b² = c² for right triangles',
  'Kubernetes orchestrates containerized applications across clusters',
  'Shakespeare wrote 37 plays including Hamlet and Macbeth',
  'The speed of light in vacuum is approximately 299,792,458 meters per second',
  'Bitcoin uses blockchain technology for decentralized transactions',
  'Mount Everest is 8,849 meters above sea level',
  'React hooks were introduced in version 16.8',
  'The human body contains approximately 206 bones',
  'Rust programming language guarantees memory safety without garbage collection',
  'The Amazon rainforest produces about 20% of the worlds oxygen',
  'GraphQL provides a query language for APIs and runtime for fulfilling queries',
  'Water boils at 100 degrees Celsius at standard atmospheric pressure',
  'Docker containers share the host OS kernel unlike virtual machines',
  'The Milky Way galaxy contains an estimated 100-400 billion stars',
  'Redis supports data structures such as strings hashes lists sets and sorted sets',
]

// ---------------------------------------------------------------------------
// Outdated entries (contradicted by current MEMORY_ENTRIES)
// ---------------------------------------------------------------------------

const OUTDATED_ENTRIES = [
  'ORM is Prisma — all database queries go through Prisma Client',          // contradicts index 1 (Drizzle)
  'Package manager is npm — do not use yarn or pnpm',                        // contradicts index 7 (bun)
  'Testing framework is Jest with custom configuration',                     // contradicts index 8 (vitest)
  'Deployment target is AWS Lambda with API Gateway',                        // contradicts index 4 (Vercel)
]

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

function buildCrossSessionRecall(): BenchmarkScenario[] {
  return [
    {
      id: 'bench_recall_001', category: 'cross-session-recall',
      query: 'what database and ORM are we using',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [1, 16],
      description: 'Recall DB + ORM decision from prior session',
    },
    {
      id: 'bench_recall_002', category: 'cross-session-recall',
      query: 'package manager preference',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [7, 29],
      description: 'Recall bun preference from prior session',
    },
    {
      id: 'bench_recall_003', category: 'cross-session-recall',
      query: 'deployment and hosting setup',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [4, 17],
      description: 'Recall Vercel deployment from prior session',
    },
    {
      id: 'bench_recall_004', category: 'cross-session-recall',
      query: 'authentication system',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [2],
      description: 'Recall NextAuth decision',
    },
    {
      id: 'bench_recall_005', category: 'cross-session-recall',
      query: 'upcoming deadlines and schedule',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [13, 14, 16],
      description: 'Recall project deadlines',
    },
  ]
}

function buildPreferenceAdherence(): BenchmarkScenario[] {
  return [
    {
      id: 'bench_pref_001', category: 'preference-adherence',
      query: 'how should I set up tests',
      memoryEntries: MEMORY_ENTRIES,
      preferenceIndices: [8],
      description: 'Should surface vitest preference',
    },
    {
      id: 'bench_pref_002', category: 'preference-adherence',
      query: 'install dependencies for the project',
      memoryEntries: MEMORY_ENTRIES,
      preferenceIndices: [7],
      description: 'Should surface bun preference',
    },
    {
      id: 'bench_pref_003', category: 'preference-adherence',
      query: 'writing code style and patterns',
      memoryEntries: MEMORY_ENTRIES,
      preferenceIndices: [12],
      description: 'Should surface functional programming preference',
    },
    {
      id: 'bench_pref_004', category: 'preference-adherence',
      query: 'commit message format',
      memoryEntries: MEMORY_ENTRIES,
      preferenceIndices: [11],
      description: 'Should surface Conventional Commits preference',
    },
  ]
}

function buildContextEfficiency(): BenchmarkScenario[] {
  return [
    {
      id: 'bench_eff_001', category: 'context-token-efficiency',
      query: 'database migration drizzle',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [1, 16],
      description: 'Efficiency: DB migration query (2 relevant out of 36)',
    },
    {
      id: 'bench_eff_002', category: 'context-token-efficiency',
      query: 'testing framework vitest',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [8, 35],
      description: 'Efficiency: testing query (2 relevant out of 36)',
    },
    {
      id: 'bench_eff_003', category: 'context-token-efficiency',
      query: 'authentication login oauth',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [2],
      description: 'Efficiency: auth query (1 relevant out of 36)',
    },
    {
      id: 'bench_eff_004', category: 'context-token-efficiency',
      query: 'CI pipeline github actions',
      memoryEntries: MEMORY_ENTRIES,
      expectedMatchIndices: [22],
      description: 'Efficiency: CI query (1 relevant out of 36)',
    },
  ]
}

function buildTaskAccuracy(): BenchmarkScenario[] {
  // Append outdated entries to corpus so correct and outdated coexist
  const corpus = [...MEMORY_ENTRIES, ...OUTDATED_ENTRIES]
  return [
    {
      id: 'bench_acc_001', category: 'task-accuracy-prior',
      query: 'which ORM should I use for database queries',
      memoryEntries: corpus,
      correctIndices: [1, 16, 32],   // Drizzle entries
      outdatedIndices: [36],          // "ORM is Prisma" (outdated)
      description: 'Should prefer Drizzle (current) over Prisma (outdated)',
    },
    {
      id: 'bench_acc_002', category: 'task-accuracy-prior',
      query: 'package manager to install dependencies',
      memoryEntries: corpus,
      correctIndices: [7, 29],        // bun entries
      outdatedIndices: [37],          // "npm" (outdated)
      description: 'Should prefer bun (current) over npm (outdated)',
    },
    {
      id: 'bench_acc_003', category: 'task-accuracy-prior',
      query: 'testing framework for unit tests',
      memoryEntries: corpus,
      correctIndices: [8, 35],        // vitest entries
      outdatedIndices: [38],          // "Jest" (outdated)
      description: 'Should prefer vitest (current) over Jest (outdated)',
    },
    {
      id: 'bench_acc_004', category: 'task-accuracy-prior',
      query: 'deployment target and hosting platform',
      memoryEntries: corpus,
      correctIndices: [4, 34],        // Vercel entries
      outdatedIndices: [39],          // "AWS Lambda" (outdated)
      description: 'Should prefer Vercel (current) over AWS (outdated)',
    },
  ]
}

function buildNoiseRejection(): BenchmarkScenario[] {
  // Mix relevant entries with noise at different ratios
  const relevant = [1, 7, 8, 4, 13]  // DB, bun, vitest, Vercel, deadline
  const relevantEntries = relevant.map((i: number) => MEMORY_ENTRIES[i]!)

  const makeCorpus = (noiseCount: number) => {
    const corpus = [...relevantEntries, ...NOISE_ENTRIES.slice(0, noiseCount)]
    const noiseIndices = Array.from({ length: noiseCount }, (_: unknown, i: number) => relevantEntries.length + i)
    return { corpus, noiseIndices, expectedMatchIndices: relevant.map((_: number, i: number) => i) }
  }

  const r20 = makeCorpus(20)
  const r15 = makeCorpus(15)
  const r10 = makeCorpus(10)

  return [
    {
      id: 'bench_noise_001', category: 'noise-rejection',
      query: 'project technical stack and setup',
      memoryEntries: r20.corpus,
      expectedMatchIndices: r20.expectedMatchIndices,
      noiseIndices: r20.noiseIndices,
      description: 'Noise rejection: 5 relevant + 20 noise (80% noise)',
    },
    {
      id: 'bench_noise_002', category: 'noise-rejection',
      query: 'user preferences and tools',
      memoryEntries: r15.corpus,
      expectedMatchIndices: r15.expectedMatchIndices,
      noiseIndices: r15.noiseIndices,
      description: 'Noise rejection: 5 relevant + 15 noise (75% noise)',
    },
    {
      id: 'bench_noise_003', category: 'noise-rejection',
      query: 'deployment deadlines',
      memoryEntries: r10.corpus,
      expectedMatchIndices: r10.expectedMatchIndices,
      noiseIndices: r10.noiseIndices,
      description: 'Noise rejection: 5 relevant + 10 noise (67% noise)',
    },
  ]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildBenchmarkScenarios(): BenchmarkScenario[] {
  return [
    ...buildCrossSessionRecall(),
    ...buildPreferenceAdherence(),
    ...buildContextEfficiency(),
    ...buildTaskAccuracy(),
    ...buildNoiseRejection(),
  ]
}
