// Engineering Skills catalog — integrates addyosmani/agent-skills into agent prompts.
//
// Skills are VENDORED into this repo at skills/engineering/<name>/SKILL.md.
// See skills/engineering/UPSTREAM.md for provenance (commit SHA, sync procedure,
// audit checklist). Vendoring removes runtime network dependency and moves the
// trust boundary inside this repo — any change to a SKILL.md goes through
// normal PR review, not upstream branch state.
//
// This module produces a section appended to every agent's init prompt so each
// agent knows what's available and which skills fit its role.

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Absolute path to the vendored skill directory, resolved at import time.
// Agents receive this path in their prompt so they can Read the files directly
// regardless of their own cwd.
export const SKILL_VENDOR_DIR = resolve(__dirname, '..', 'skills', 'engineering')

export const SKILL_CATALOG = {
  define: [
    { name: 'idea-refine',                     desc: 'Turn vague concepts into concrete proposals' },
    { name: 'spec-driven-development',         desc: 'Write PRDs before implementation' },
  ],
  plan: [
    { name: 'planning-and-task-breakdown',     desc: 'Decompose into verifiable atomic tasks' },
  ],
  build: [
    { name: 'incremental-implementation',      desc: 'Thin vertical slices, verify each step' },
    { name: 'test-driven-development',         desc: 'Red-Green-Refactor with the test pyramid' },
    { name: 'context-engineering',             desc: 'Deliver the right context to agents' },
    { name: 'source-driven-development',       desc: 'Ground framework decisions in official docs' },
    { name: 'frontend-ui-engineering',         desc: 'Component architecture, WCAG 2.1 AA' },
    { name: 'api-and-interface-design',        desc: 'Contract-first, boundary validation' },
  ],
  verify: [
    { name: 'browser-testing-with-devtools',   desc: 'Live runtime inspection and profiling' },
    { name: 'debugging-and-error-recovery',    desc: 'Five-step triage methodology' },
  ],
  review: [
    { name: 'code-review-and-quality',         desc: 'Five-axis review, ~100-line change limit' },
    { name: 'code-simplification',             desc: "Chesterton's Fence before deleting" },
    { name: 'security-and-hardening',          desc: 'OWASP Top 10 prevention' },
    { name: 'performance-optimization',        desc: 'Measure first, Core Web Vitals targets' },
  ],
  ship: [
    { name: 'git-workflow-and-versioning',     desc: 'Trunk-based development, atomic commits' },
    { name: 'ci-cd-and-automation',            desc: 'Quality gates, shift-left testing' },
    { name: 'deprecation-and-migration',       desc: 'Code-as-liability migrations' },
    { name: 'documentation-and-adrs',          desc: 'Architecture Decision Records, API docs' },
    { name: 'shipping-and-launch',             desc: 'Pre-launch checklist, staged rollouts' },
  ],
}

// The six phases map to the plugin's phase slash commands.
export const PHASE_SLASH_COMMANDS = {
  define: '/spec',
  plan:   '/plan',
  build:  '/build',
  verify: '/test',
  review: '/review',
  ship:   '/ship',
}

// Extra skill-specific commands that exist outside the phase map.
export const EXTRA_SLASH_COMMANDS = ['/code-simplify']

// Which phases matter most for each role bucket. Coordinators care about
// planning + quality gates + shipping. Workers drill into build/verify.
const ROLE_PHASES = {
  coordinator: ['define', 'plan', 'review', 'ship'],
  researcher:  ['define', 'build', 'verify'],
  implementer: ['plan', 'build', 'verify'],
  reviewer:    ['review'],
  tester:      ['verify', 'review'],
  shipper:     ['ship', 'review'],
  generalist:  ['plan', 'build', 'verify', 'review'],
}

// Keyword buckets for inferring role→bucket. Evaluated in declaration order;
// implementer is last because its keywords (code, build) are generic and would
// swallow roles like "code-reviewer" or "build-pipeline" if evaluated first.
const ROLE_KEYWORDS = {
  reviewer:    ['review', 'critic'],
  tester:      ['test', 'qa', 'verif'],
  shipper:     ['ship', 'deploy', 'releas', 'devops', 'sre'],
  coordinator: ['coord', 'lead', 'manag', 'architect', 'pm'],
  researcher:  ['research', 'investig', 'analy', 'explor', 'audit', 'discover'],
  implementer: ['implement', 'code', 'fix', 'build', 'develop', 'engineer', 'front', 'back', 'full'],
}

export function inferRoleBucket(role) {
  const s = String(role ?? '').toLowerCase()
  if (!s) return 'generalist'
  for (const [bucket, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some(k => s.includes(k))) return bucket
  }
  return 'generalist'
}

export function recommendedSkillsForRole(role) {
  const bucket = inferRoleBucket(role)
  const phases = ROLE_PHASES[bucket] || ROLE_PHASES.generalist
  return phases.flatMap(p =>
    (SKILL_CATALOG[p] || []).map(s => ({ ...s, phase: p }))
  )
}

/** Absolute path to a vendored SKILL.md. Agents Read this file directly. */
export function skillPath(name) {
  return join(SKILL_VENDOR_DIR, name, 'SKILL.md')
}

/**
 * Build the "Engineering Skills" section appended to an agent's init prompt.
 * Keeps the footprint small: recommendations are listed in full, the remaining
 * catalog is summarized as phase: name1, name2, ...
 */
export function buildSkillsSection(role) {
  const bucket = inferRoleBucket(role)
  const recs = recommendedSkillsForRole(role)
  const allCommands = [...Object.values(PHASE_SLASH_COMMANDS), ...EXTRA_SLASH_COMMANDS]

  const lines = []
  lines.push('## Engineering Skills (on-demand)')
  lines.push('')
  lines.push('Production-grade engineering workflows (vendored from addyosmani/agent-skills,')
  lines.push('MIT). Invoke a skill BEFORE starting work in its phase — not after.')
  lines.push('')
  lines.push('How to invoke a skill:')
  lines.push(`  1. Plugin installed → use the matching slash command (${allCommands.join(', ')}).`)
  lines.push(`  2. Otherwise → Read the vendored spec: ${SKILL_VENDOR_DIR}/<skill-name>/SKILL.md`)
  lines.push('     Then follow its Process section.')
  lines.push('')
  lines.push(`Recommended for your role (bucket: ${bucket}):`)
  for (const s of recs) {
    lines.push(`- [${s.phase}] ${s.name} — ${s.desc}`)
  }
  lines.push('')
  lines.push('Full catalog (load any by name on demand):')
  for (const [phase, skills] of Object.entries(SKILL_CATALOG)) {
    const cmd = PHASE_SLASH_COMMANDS[phase]
    lines.push(`  ${phase} (${cmd}): ${skills.map(s => s.name).join(', ')}`)
  }
  return lines.join('\n')
}
