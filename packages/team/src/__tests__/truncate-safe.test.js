import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { truncateSafe } from '../index.js'

describe('truncateSafe', () => {
  it('returns safe sentinel for null / undefined and passes through non-string as-is', () => {
    assert.equal(truncateSafe(null, 100), '')
    assert.equal(truncateSafe(undefined, 100), '')
    assert.equal(truncateSafe(123, 100), 123)
    const o = {}
    assert.equal(truncateSafe(o, 100), o)
  })

  it('returns empty string unchanged', () => {
    assert.equal(truncateSafe('', 100), '')
  })

  it('returns the original when under budget', () => {
    assert.equal(truncateSafe('hello', 100), 'hello')
    assert.equal(truncateSafe('日本語', 100), '日本語')
  })

  it('returns "" when marker alone exceeds maxBytes', () => {
    assert.equal(truncateSafe('abcdefghij', 3), '')
  })

  it('truncates ASCII at byte budget and keeps the marker', () => {
    const out = truncateSafe('abcdefghijklmnopqrstuvwxyz', 20)
    assert.ok(Buffer.byteLength(out, 'utf8') <= 20, `out bytes: ${Buffer.byteLength(out, 'utf8')}`)
    assert.ok(out.endsWith('…[truncated]'), `out: ${out}`)
  })

  it('respects byte budget for CJK input (3-byte UTF-8)', () => {
    const cjk = '日本語のテキストが長く続きます。'.repeat(20)
    const out = truncateSafe(cjk, 80)
    assert.ok(Buffer.byteLength(out, 'utf8') <= 80, `out bytes: ${Buffer.byteLength(out, 'utf8')}`)
    assert.ok(out.endsWith('…[truncated]'))
  })

  it('respects byte budget for mixed ASCII + CJK', () => {
    const mix = ('ascii fragment ' + '日本語の説明 ').repeat(50)
    const out = truncateSafe(mix, 200)
    assert.ok(Buffer.byteLength(out, 'utf8') <= 200, `out bytes: ${Buffer.byteLength(out, 'utf8')}`)
    assert.ok(out.endsWith('…[truncated]'))
  })

  it('never splits a ZWJ family emoji grapheme', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const text = 'prefix ' + family.repeat(50)
    const maxBytes = 50
    const out = truncateSafe(text, maxBytes)
    const familyBytes = Buffer.byteLength(family, 'utf8')
    assert.ok(Buffer.byteLength(out, 'utf8') <= maxBytes)
    const body = out.slice(0, out.length - '…[truncated]'.length)
    let i = 7
    while (i + familyBytes <= Buffer.byteLength(body, 'utf8')) {
      const slice = body.slice(0, i)
      const sliceBytes = Buffer.byteLength(slice, 'utf8')
      if (sliceBytes > 7 && (sliceBytes - 7) % familyBytes === 0) {
        i += 1
        continue
      }
      i += 1
    }
    assert.ok(!out.includes('‍…'), 'should not end at a ZWJ joiner')
  })

  it('prefers a newline cut near the budget', () => {
    const text = 'A'.repeat(40) + '\nB'.repeat(40) + '\nC'.repeat(40)
    const out = truncateSafe(text, 100)
    const body = out.slice(0, out.length - '…[truncated]'.length)
    assert.ok(body.endsWith('\n'), `body should end at a newline near the cap, got: ${JSON.stringify(body.slice(-20))}`)
  })

  it('supports a custom marker', () => {
    const out = truncateSafe('abcdefghij', 7, '...')
    assert.ok(Buffer.byteLength(out, 'utf8') <= 7)
    assert.ok(out.endsWith('...'))
  })
})
