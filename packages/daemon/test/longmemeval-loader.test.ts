import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadLongMemEvalSuite,
  oracleEntryToEvalCase,
} from '../../extracted/evals/longMemEvalLoader.js'

const SAMPLE_ENTRY = {
  question_id: 'gpt4_abc',
  question_type: 'temporal-reasoning',
  question: 'What issue did I have with my car?',
  answer: 'GPS malfunction',
  haystack_sessions: [
    [
      { role: 'user', content: 'The GPS on my car stopped working', has_answer: true },
      { role: 'assistant', content: 'Here are some troubleshooting tips...' },
    ],
    [
      { role: 'user', content: 'Unrelated message about weather' },
    ],
  ],
}

describe('oracleEntryToEvalCase', () => {
  it('converts an oracle entry into search-recall case', () => {
    const c = oracleEntryToEvalCase(SAMPLE_ENTRY, '2026-04-22T00:00:00Z', 500)
    expect(c.id).toBe('lme_gpt4_abc')
    expect(c.category).toBe('search-recall')
    expect(c.query).toBe(SAMPLE_ENTRY.question)
    expect(c.memoryEntries.length).toBe(3)
    expect(c.expectedMatchIndices).toEqual([0])
    expect(c.tags).toContain('longmemeval')
    expect(c.tags).toContain('temporal-reasoning')
  })

  it('truncates long messages', () => {
    const long = {
      ...SAMPLE_ENTRY,
      haystack_sessions: [[
        { role: 'user', content: 'x'.repeat(1000), has_answer: true },
      ]],
    }
    const c = oracleEntryToEvalCase(long, '2026-04-22T00:00:00Z', 100)
    expect(c.memoryEntries[0]!.length).toBeLessThanOrEqual(107) // 100 + "[user] " + "…"
  })
})

describe('loadLongMemEvalSuite', () => {
  let tmpFile: string

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lme-'))
    tmpFile = join(dir, 'oracle.json')
  })

  afterEach(async () => {
    await rm(tmpFile, { force: true }).catch(() => {})
  })

  it('loads a multi-entry oracle', async () => {
    const data = [SAMPLE_ENTRY, { ...SAMPLE_ENTRY, question_id: 'gpt4_def' }]
    await writeFile(tmpFile, JSON.stringify(data))
    const suite = await loadLongMemEvalSuite(tmpFile)
    expect(suite.cases.length).toBe(2)
    expect(suite.cases[0]!.id).toBe('lme_gpt4_abc')
    expect(suite.cases[1]!.id).toBe('lme_gpt4_def')
  })

  it('respects maxEntries option', async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      ...SAMPLE_ENTRY,
      question_id: `gpt4_${i}`,
    }))
    await writeFile(tmpFile, JSON.stringify(data))
    const suite = await loadLongMemEvalSuite(tmpFile, { maxEntries: 3 })
    expect(suite.cases.length).toBe(3)
  })

  it('filters by questionTypes', async () => {
    const data = [
      { ...SAMPLE_ENTRY, question_type: 'temporal-reasoning' },
      { ...SAMPLE_ENTRY, question_id: 'x', question_type: 'knowledge-update' },
    ]
    await writeFile(tmpFile, JSON.stringify(data))
    const suite = await loadLongMemEvalSuite(tmpFile, {
      questionTypes: ['knowledge-update'],
    })
    expect(suite.cases.length).toBe(1)
    expect(suite.cases[0]!.tags).toContain('knowledge-update')
  })

  it('skips entries with no ground-truth messages', async () => {
    const noAnswer = {
      ...SAMPLE_ENTRY,
      question_id: 'no_answer',
      haystack_sessions: [[
        { role: 'user', content: 'just a message' },
      ]],
    }
    await writeFile(tmpFile, JSON.stringify([noAnswer, SAMPLE_ENTRY]))
    const suite = await loadLongMemEvalSuite(tmpFile)
    expect(suite.cases.length).toBe(1)
    expect(suite.cases[0]!.id).toBe('lme_gpt4_abc')
  })

  it('skips malformed entries without throwing', async () => {
    const data = [
      { not: 'valid oracle entry' },
      SAMPLE_ENTRY,
    ]
    await writeFile(tmpFile, JSON.stringify(data))
    const suite = await loadLongMemEvalSuite(tmpFile)
    expect(suite.cases.length).toBe(1)
  })

  it('throws when input is not an array', async () => {
    await writeFile(tmpFile, JSON.stringify({ not: 'array' }))
    await expect(loadLongMemEvalSuite(tmpFile)).rejects.toThrow(/not an array/)
  })
})
