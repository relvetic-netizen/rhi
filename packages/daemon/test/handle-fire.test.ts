import { describe, it, expect } from 'vitest'
import { classifyFireOutcome, isWalkerTaskId } from '../src/handle-fire.js'

describe('classifyFireOutcome (Axis A — handleFire failure recognition)', () => {
  describe('non-zero exit', () => {
    it('classifies any non-zero exit as failure regardless of task id', () => {
      expect(classifyFireOutcome('relvetia-dream', 1, 'hier')).toEqual({ kind: 'failure', exitCode: 1 })
      expect(classifyFireOutcome('relvetia-verify', 2, 'hier')).toEqual({ kind: 'failure', exitCode: 2 })
      expect(classifyFireOutcome('user-task', 137, 'hier')).toEqual({ kind: 'failure', exitCode: 137 })
    })

    it('preserves the original exit code for diagnostic logging', () => {
      const out = classifyFireOutcome('relvetia-dream', 42, 'hier')
      expect(out).toEqual({ kind: 'failure', exitCode: 42 })
    })
  })

  describe('zero exit — distill family', () => {
    it('relvetia-dream in hier mode stamps both .last-distill and .last-hiergen.json + git sync', () => {
      expect(classifyFireOutcome('relvetia-dream', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: true,
        stampHiergen: true,
        gitSync: true,
      })
    })

    it('relvetia-dream in rec mode stamps .last-distill only (no hiergen) + git sync', () => {
      expect(classifyFireOutcome('relvetia-dream', 0, 'rec')).toEqual({
        kind: 'success',
        stampDistill: true,
        stampHiergen: false,
        gitSync: true,
      })
    })

    it('private-distill success stamps local .last-distill without git sync', () => {
      expect(classifyFireOutcome('private-distill', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: true,
        stampHiergen: false,
        gitSync: false,
      })
    })

    it('relvetia-verify success: no distill stamps, but git sync runs', () => {
      expect(classifyFireOutcome('relvetia-verify', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: false,
        stampHiergen: false,
        gitSync: true,
      })
    })

    it('relvetia-optimize success: no distill stamps, but git sync runs', () => {
      expect(classifyFireOutcome('relvetia-optimize', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: false,
        stampHiergen: false,
        gitSync: true,
      })
    })
  })

  describe('zero exit — non-distill task', () => {
    it('user task on success: no stamps and no git sync (memory not affected)', () => {
      expect(classifyFireOutcome('my-cron-task', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: false,
        stampHiergen: false,
        gitSync: false,
      })
    })
  })

  describe('zero exit — walker family (private-walker-*)', () => {
    it('private-walker-x is log-only: no stamps, no git sync', () => {
      expect(classifyFireOutcome('private-walker-x', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: false,
        stampHiergen: false,
        gitSync: false,
      })
    })

    it('private-walker-discord is log-only: no stamps, no git sync', () => {
      expect(classifyFireOutcome('private-walker-discord', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: false,
        stampHiergen: false,
        gitSync: false,
      })
    })

    it('walker task with HH:MM suffix (e.g. private-walker-x-09-00) also log-only', () => {
      expect(classifyFireOutcome('private-walker-x-09-00', 0, 'hier')).toEqual({
        kind: 'success',
        stampDistill: false,
        stampHiergen: false,
        gitSync: false,
      })
    })

    it('walker non-zero exit still classifies as failure (本人 + 6 分 timeout で抑える)', () => {
      expect(classifyFireOutcome('private-walker-x', 1, 'hier')).toEqual({
        kind: 'failure',
        exitCode: 1,
      })
    })
  })
})

describe('isWalkerTaskId', () => {
  it('identifies walker family ids', () => {
    expect(isWalkerTaskId('private-walker-x')).toBe(true)
    expect(isWalkerTaskId('private-walker-discord')).toBe(true)
    expect(isWalkerTaskId('private-walker-x-09-00')).toBe(true)
  })

  it('rejects non-walker ids', () => {
    expect(isWalkerTaskId('relvetia-dream')).toBe(false)
    expect(isWalkerTaskId('private-wake')).toBe(false)
    expect(isWalkerTaskId('walker-x')).toBe(false)
    expect(isWalkerTaskId('')).toBe(false)
  })
})
