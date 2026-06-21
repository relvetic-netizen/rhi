import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  verifyDistillation: vi.fn(),
  remediateMissingEntries: vi.fn(),
  logVerificationResults: vi.fn(),
  // Phase C — index-shape verifier. Default to all-PASS so existing tests
  // that only care about the hit-rate verdict keep their original semantics.
  verifyIndexShape: vi.fn().mockResolvedValue({
    axes: [
      { axis: 'hier-id-rate', passed: true, message: 'no numeric ids', offenderCount: 0, samples: [] },
      { axis: 'mojibake-regex', passed: true, message: 'no mojibake', offenderCount: 0, samples: [] },
      { axis: 'array-drift', passed: true, message: 'canonical Record', offenderCount: 0, samples: [] },
    ],
    passed: true,
  }),
}))

vi.mock('../../extracted/memory/distillVerifier.js', () => mocks)

import { verifyRunner } from '../src/verify-runner.js'

describe('native verifyRunner', () => {
  afterEach(() => {
    delete process.env.RELVETIA_VERIFY_SCOPE
    delete process.env.RELVETIA_VERIFY_FORCE_FAIL
    delete process.env.RELVETIA_MAX_VERIFY_ENTRIES
    vi.clearAllMocks()
    // Restore default all-PASS shape mock after each test; some cases below
    // override it to assert the index-shape failure path.
    mocks.verifyIndexShape.mockResolvedValue({
      axes: [
        { axis: 'hier-id-rate', passed: true, message: 'no numeric ids', offenderCount: 0, samples: [] },
        { axis: 'mojibake-regex', passed: true, message: 'no mojibake', offenderCount: 0, samples: [] },
        { axis: 'array-drift', passed: true, message: 'canonical Record', offenderCount: 0, samples: [] },
      ],
      passed: true,
    })
  })

  it('returns success=true when verifyDistillation passes', async () => {
    mocks.verifyDistillation.mockResolvedValue({
      passed: true,
      hitRate: 1,
      totalEntries: 5,
      foundEntries: 5,
      missingEntries: [],
    })

    const result = await verifyRunner({ memoryDir: '/tmp/memory', scope: 'all' })

    expect(result.success).toBe(true)
    expect(result.summary).toContain('found=5/5')
    expect(result.summary).toContain('indexShape=PASS')
    expect(result.missingCount).toBe(0)
    expect(mocks.verifyDistillation).toHaveBeenCalledWith('/tmp/memory', 'all')
    expect(mocks.remediateMissingEntries).not.toHaveBeenCalled()
    expect(mocks.logVerificationResults).toHaveBeenCalledOnce()
    expect(mocks.verifyIndexShape).toHaveBeenCalledWith('/tmp/memory')
    expect(result.indexShapePassed).toBe(true)
  })

  it('returns success=false when verifyDistillation reports failed verification', async () => {
    mocks.verifyDistillation.mockResolvedValue({
      passed: false,
      hitRate: 0.5,
      totalEntries: 4,
      foundEntries: 2,
      missingEntries: [
        { entry: { id: 'missing-1' }, queriesTried: [], suggestedConcepts: ['alpha'] },
        { entry: { id: 'missing-2' }, queriesTried: [], suggestedConcepts: ['beta'] },
      ],
    })
    mocks.remediateMissingEntries.mockResolvedValue(2)

    const result = await verifyRunner({ memoryDir: '/tmp/memory', scope: 'today' })

    expect(result.success).toBe(false)
    expect(result.summary).toContain('missing=2')
    expect(result.missingIds).toEqual(['missing-1', 'missing-2'])
    expect(result.remediatedEntries).toBe(2)
    expect(mocks.remediateMissingEntries).toHaveBeenCalledOnce()
    expect(mocks.logVerificationResults).toHaveBeenCalledOnce()
  })

  it('returns success=false when any index-shape axis FAILS (Phase C contract)', async () => {
    mocks.verifyDistillation.mockResolvedValue({
      passed: true,
      hitRate: 1,
      totalEntries: 5,
      foundEntries: 5,
      missingEntries: [],
    })
    mocks.verifyIndexShape.mockResolvedValueOnce({
      axes: [
        { axis: 'hier-id-rate', passed: true, message: 'ok', offenderCount: 0, samples: [] },
        { axis: 'mojibake-regex', passed: false, message: '2 files mojibake', offenderCount: 2, samples: ['a.md', 'b.md'] },
        { axis: 'array-drift', passed: true, message: 'ok', offenderCount: 0, samples: [] },
      ],
      passed: false,
    })

    const result = await verifyRunner({ memoryDir: '/tmp/memory', scope: 'all' })

    expect(result.success).toBe(false)
    expect(result.summary).toContain('indexShape=FAIL(mojibake-regex)')
    expect(result.indexShapePassed).toBe(false)
    expect(result.indexShapeAxes?.find(a => a.axis === 'mojibake-regex')?.passed).toBe(false)
  })

  it('returns success=false when verifyDistillation throws without propagating', async () => {
    mocks.verifyDistillation.mockRejectedValue(new Error('index read failed'))

    const result = await verifyRunner({ memoryDir: '/tmp/memory', scope: 'all' })

    expect(result.success).toBe(false)
    expect(result.summary).toContain('index read failed')
    expect(result.error).toBe('index read failed')
    expect(mocks.remediateMissingEntries).not.toHaveBeenCalled()
    expect(mocks.logVerificationResults).not.toHaveBeenCalled()
  })
})
