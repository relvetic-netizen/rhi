import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { capSessionItems, SESSION_RETURN_BUDGET_BYTES } from '../index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'large-session.jsonl')

async function loadFixture() {
  const raw = await readFile(FIXTURE, 'utf-8')
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('byte-measurement: team_get_session 80KB → ≤24KB', () => {
  it('reports before/after byte reduction with cap enabled vs disabled', async () => {
    const items = await loadFixture()

    const before = capSessionItems(items, { capDisabled: true })
    const after = capSessionItems(items, { capDisabled: false })

    const beforeBytes = before.afterBytes
    const afterBytes = after.afterBytes
    const reductionPct = Math.round(((beforeBytes - afterBytes) / beforeBytes) * 100)

    const report = { before_bytes: beforeBytes, after_bytes: afterBytes, reduction_pct: reductionPct, budget_bytes: SESSION_RETURN_BUDGET_BYTES, items_total: items.length, items_kept: after.keptCount, items_omitted: after.omittedCount }
    console.log('BYTE_MEASUREMENT_REPORT ' + JSON.stringify(report))

    assert.ok(beforeBytes > 80_000, `before should exceed 80KB, was ${beforeBytes}`)
    assert.ok(afterBytes <= SESSION_RETURN_BUDGET_BYTES, `after should fit budget, was ${afterBytes}`)
    assert.ok(reductionPct >= 70, `reduction should be ≥70%, was ${reductionPct}%`)
    assert.equal(after.truncated, true)
    assert.ok(after.text.startsWith('[NOTICE:'), 'capped output must start with the leading NOTICE line')
  })

  it('honors RELVETIA_CAP_DISABLE=1 env (bypasses cap)', async () => {
    const items = await loadFixture()
    const prior = process.env.RELVETIA_CAP_DISABLE
    process.env.RELVETIA_CAP_DISABLE = '1'
    try {
      const bypassed = capSessionItems(items)
      assert.equal(bypassed.truncated, false)
      assert.equal(bypassed.omittedCount, 0)
      assert.ok(bypassed.afterBytes > 80_000, 'bypassed should keep full bytes')
    } finally {
      if (prior === undefined) delete process.env.RELVETIA_CAP_DISABLE
      else process.env.RELVETIA_CAP_DISABLE = prior
    }
  })
})
