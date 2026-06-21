// Workspace SoT guard for ecosystem.config.cjs.
//
// relvetia-setup.sh:630 copies this file over the cc-config deployed copy
// (~/.claude/scripts/relvetia/ecosystem.config.cjs). The two must stay byte-
// for-byte aligned: any entry missing here gets dropped from the deployed
// copy on the next post-merge hook run.
//
// Background: a 3-entry workspace SoT (PR #79) silently dropped the
// inbox-watcher + relvetia-injection-test entries from the deployed copy.
// Detection only happened post-merge via cc-config-side
// scripts/relvetia/__tests__/ecosystem.test.mjs. This test mirrors that
// guard at the SoT side so regressions fail before deploy, not after.

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ECOSYSTEM_PATH = path.resolve(here, '..', 'ecosystem.config.cjs')
const require_ = createRequire(import.meta.url)

interface PM2App {
  name: string
  script: string
  cwd: string
  env: Record<string, string>
  autorestart: boolean
}

function loadConfig(): { apps: PM2App[] } {
  delete require_.cache[require_.resolve(ECOSYSTEM_PATH)]
  return require_(ECOSYSTEM_PATH)
}

describe('ecosystem.config.cjs (workspace SoT, 5-entry contract)', () => {
  it('loads as a CommonJS module without error', () => {
    expect(() => loadConfig()).not.toThrow()
  })

  it('exports an `apps` array with >=4 daemons', () => {
    const cfg = loadConfig()
    expect(Array.isArray(cfg.apps)).toBe(true)
    expect(cfg.apps.length).toBeGreaterThanOrEqual(4)
  })

  it('declares all four required apps (cp-deliver invariant)', () => {
    const cfg = loadConfig()
    const names = cfg.apps.map((a) => a.name).sort()
    for (const required of [
      'inbox-watcher',
      'relvetia-daemon',
      'relvetia-daemon-private',
      'relvetia-injection-test',
    ]) {
      expect(names).toContain(required)
    }
  })

  it('every app has script, cwd, env, autorestart (boolean)', () => {
    const cfg = loadConfig()
    for (const app of cfg.apps) {
      expect(typeof app.name).toBe('string')
      expect(typeof app.script).toBe('string')
      expect(typeof app.cwd).toBe('string')
      expect(typeof app.env).toBe('object')
      expect(typeof app.autorestart).toBe('boolean')
    }
  })

  it('production apps keep autorestart=true', () => {
    const cfg = loadConfig()
    for (const name of ['relvetia-daemon', 'inbox-watcher', 'relvetia-daemon-private']) {
      const app = cfg.apps.find((a) => a.name === name)
      expect(app, `${name} missing`).toBeDefined()
      expect(app!.autorestart).toBe(true)
    }
  })

  it('relvetia-injection-test stays manual-only (autorestart=false, isolated ledger)', () => {
    const cfg = loadConfig()
    const app = cfg.apps.find((a) => a.name === 'relvetia-injection-test')
    expect(app).toBeDefined()
    expect(app!.autorestart).toBe(false)
    expect(app!.env.RELVETIA_LEDGER_PATH).toMatch(/ledger-injection-test\.json$/)
    expect(app!.env.RELVETIA_TEAM_NAMESPACE).toBe('team-injection-test')
    expect(app!.env.LEDGER_W2_WRITER_ENABLED).toBe('true')
    expect(app!.env.NODE_ENV).toBe('development')
  })

  it('inbox-watcher keeps RELVETIA_INBOX_INJECT_RELAY=1 (multi-turn loop contract)', () => {
    const cfg = loadConfig()
    const app = cfg.apps.find((a) => a.name === 'inbox-watcher')
    expect(app!.env.RELVETIA_INBOX_INJECT_RELAY).toBe('1')
  })

  it('inbox-watcher keeps Windows polling defaults (commit 680d51f contract)', () => {
    const cfg = loadConfig()
    const app = cfg.apps.find((a) => a.name === 'inbox-watcher')
    expect(app!.env.RELVETIA_CHOKIDAR_USE_POLLING).toBe('1')
    expect(app!.env.RELVETIA_CHOKIDAR_POLL_INTERVAL_MS).toBe('750')
    expect(app!.env.RELVETIA_INBOX_RESCAN_INTERVAL_MS).toBe('30000')
  })

  it('relvetia-daemon-private has RELVETIA_DAEMON_TASKS=private-distill (task filter)', () => {
    const cfg = loadConfig()
    const app = cfg.apps.find((a) => a.name === 'relvetia-daemon-private')
    expect(app!.env.RELVETIA_DAEMON_TASKS).toBe('private-distill')
  })

  it('PATH is non-empty for all apps (claude CLI resolution survives ecosystem reload)', () => {
    const cfg = loadConfig()
    for (const app of cfg.apps) {
      expect(typeof app.env.PATH).toBe('string')
      expect(app.env.PATH.length).toBeGreaterThan(0)
    }
  })
})
