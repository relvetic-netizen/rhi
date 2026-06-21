import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildChildEnv } from '../src/executor.js'

describe('buildChildEnv (Axis B — daemon subprocess gate)', () => {
  // The function inherits process.env. To assert what it ADDS vs what it
  // INHERITS, we control the relevant inherited keys via save/restore.
  const saved: Record<string, string | undefined> = {}
  const controlled = ['RELVETIA_SCREENING_MEMORY', 'RELVETIA_DAEMON_CHILD', 'ECC_SKIP_OBSERVE']

  beforeEach(() => {
    for (const k of controlled) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of controlled) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('always sets RELVETIA_DAEMON_CHILD=1 so SessionStart hooks can detect daemon-spawned children', () => {
    const env = buildChildEnv(false)
    expect(env.RELVETIA_DAEMON_CHILD).toBe('1')
  })

  it('always sets ECC_SKIP_OBSERVE=1 to prevent the spawned session from recording to observer', () => {
    const env = buildChildEnv(false)
    expect(env.ECC_SKIP_OBSERVE).toBe('1')
  })

  it('inherits process.env (PATH, HOME, etc.) so the child can find the claude binary and config', () => {
    const env = buildChildEnv(false)
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('sets RELVETIA_SCREENING_MEMORY=1 only when enableScreening=true', () => {
    expect(buildChildEnv(true).RELVETIA_SCREENING_MEMORY).toBe('1')
    expect(buildChildEnv(false).RELVETIA_SCREENING_MEMORY).toBeUndefined()
  })

  it('sets RELVETIA_DAEMON_CHILD regardless of screening mode (gate must apply to all daemon children)', () => {
    expect(buildChildEnv(true).RELVETIA_DAEMON_CHILD).toBe('1')
    expect(buildChildEnv(false).RELVETIA_DAEMON_CHILD).toBe('1')
  })
})
