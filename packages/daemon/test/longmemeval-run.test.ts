import { describe, it, expect } from 'vitest'
import {
  runQuestion,
  score,
  emptyRate,
  type LmeEntry,
  type QuestionResult,
} from '../../extracted/evals/longMemEvalRun.js'

const ENTRY: LmeEntry = {
  question_id: 'q1',
  question_type: 'single-session-user',
  question: 'What color is my bicycle?',
  question_date: '2023/05/30 (Tue) 10:00',
  haystack_dates: ['2023/05/01 (Mon) 09:00', '2023/05/29 (Mon) 20:15'],
  haystack_session_ids: ['noise', 'gold'],
  haystack_sessions: [
    [{ role: 'user', content: 'I baked sourdough bread with rye flour today.' }],
    [
      { role: 'user', content: 'My new bicycle is a bright red color.', has_answer: true },
      { role: 'assistant', content: 'Red bicycles are very visible on the road.' },
    ],
  ],
}

function result(rank: number | null, count = 1): QuestionResult {
  return {
    questionId: 'x',
    questionType: 't',
    abstention: false,
    rank: { real: rank, qdate: rank },
    resultCount: { real: count, qdate: count },
    archiveCount: { real: 0, qdate: 0 },
    chance: { r5: 0, r10: 0 },
  }
}

describe('longMemEvalRun', () => {
  it('finds the gold session through the real search pipeline in both clock conditions', async () => {
    const r = await runQuestion(ENTRY)
    expect(r.rank.real).toBe(1)
    expect(r.rank.qdate).toBe(1)
    expect(r.abstention).toBe(false)
  })

  it('aggregates Recall@k, MRR and empty-result rate', () => {
    const rows = [result(1), result(3), result(7), result(null, 0)]
    expect(score(rows, 'real')).toEqual({ n: 4, r5: 0.5, r10: 0.75, mrr: (1 + 1 / 3 + 1 / 7) / 4 })
    expect(emptyRate(rows, 'qdate')).toBe(0.25)
  })
})
