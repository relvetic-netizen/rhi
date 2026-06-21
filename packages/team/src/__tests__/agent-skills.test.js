import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SKILL_CATALOG,
  PHASE_SLASH_COMMANDS,
  EXTRA_SLASH_COMMANDS,
  SKILL_VENDOR_DIR,
  inferRoleBucket,
  recommendedSkillsForRole,
  skillPath,
  buildSkillsSection,
} from '../agent-skills.js'

describe('SKILL_CATALOG', () => {
  it('covers all six phases', () => {
    assert.deepEqual(
      Object.keys(SKILL_CATALOG).sort(),
      ['build', 'define', 'plan', 'review', 'ship', 'verify']
    )
  })

  it('contains the 20 upstream skills', () => {
    const all = Object.values(SKILL_CATALOG).flat()
    assert.equal(all.length, 20)
    // Spot-check representative skills from each phase.
    const names = all.map(s => s.name)
    for (const expected of [
      'spec-driven-development',
      'planning-and-task-breakdown',
      'test-driven-development',
      'debugging-and-error-recovery',
      'security-and-hardening',
      'shipping-and-launch',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`)
    }
  })

  it('phase slash commands map 1:1 to catalog phases', () => {
    assert.deepEqual(
      Object.keys(PHASE_SLASH_COMMANDS).sort(),
      Object.keys(SKILL_CATALOG).sort()
    )
  })
})

describe('vendored skill files', () => {
  it('every catalog skill has a SKILL.md file on disk', () => {
    for (const skills of Object.values(SKILL_CATALOG)) {
      for (const s of skills) {
        const p = skillPath(s.name)
        assert.ok(existsSync(p), `vendored file missing: ${p}`)
      }
    }
  })

  it('every vendored SKILL.md has non-trivial content', () => {
    for (const skills of Object.values(SKILL_CATALOG)) {
      for (const s of skills) {
        const body = readFileSync(skillPath(s.name), 'utf-8')
        // Upstream files all have frontmatter + multi-section content; 500 bytes
        // is a floor that catches truncation / empty files but isn't brittle.
        assert.ok(body.length > 500, `${s.name} too small (${body.length} bytes)`)
        assert.ok(body.startsWith('---'), `${s.name} missing frontmatter`)
      }
    }
  })

  it('LICENSE and UPSTREAM.md exist alongside the skills', () => {
    assert.ok(existsSync(join(SKILL_VENDOR_DIR, 'LICENSE')), 'LICENSE missing')
    assert.ok(existsSync(join(SKILL_VENDOR_DIR, 'UPSTREAM.md')), 'UPSTREAM.md missing')
  })
})

describe('inferRoleBucket', () => {
  it('maps common role strings to buckets', () => {
    assert.equal(inferRoleBucket('researcher'), 'researcher')
    assert.equal(inferRoleBucket('Code investigation'), 'researcher')
    assert.equal(inferRoleBucket('implementer'), 'implementer')
    assert.equal(inferRoleBucket('frontend engineer'), 'implementer')
    assert.equal(inferRoleBucket('code-reviewer'), 'reviewer')
    assert.equal(inferRoleBucket('QA'), 'tester')
    assert.equal(inferRoleBucket('coordinator'), 'coordinator')
    assert.equal(inferRoleBucket('team-lead'), 'coordinator')
    assert.equal(inferRoleBucket('SRE / deploy'), 'shipper')
  })

  it('falls back to generalist on unknown / empty / null / undefined role', () => {
    assert.equal(inferRoleBucket(''), 'generalist')
    assert.equal(inferRoleBucket(undefined), 'generalist')
    assert.equal(inferRoleBucket(null), 'generalist')
    assert.equal(inferRoleBucket('space-wizard'), 'generalist')
  })

  it('keyword precedence: specific buckets win over implementer (load-bearing)', () => {
    // Each input contains BOTH an implementer-bucket keyword (code/build/engineer)
    // AND a more-specific bucket keyword. The more-specific bucket must win.
    assert.equal(inferRoleBucket('code-reviewer'),          'reviewer')   // code + review
    assert.equal(inferRoleBucket('build-pipeline-reviewer'),'reviewer')   // build + review
    assert.equal(inferRoleBucket('test-architect'),         'tester')     // test + architect
    assert.equal(inferRoleBucket('release-engineer'),       'shipper')    // releas + engineer
    assert.equal(inferRoleBucket('deploy-coder'),           'shipper')    // deploy + code
  })
})

describe('recommendedSkillsForRole', () => {
  it('returns only skills from the role bucket phases', () => {
    const recs = recommendedSkillsForRole('reviewer')
    // reviewer bucket → only review phase
    assert.ok(recs.length > 0)
    for (const s of recs) assert.equal(s.phase, 'review')
  })

  it('implementer bucket spans plan + build + verify', () => {
    const recs = recommendedSkillsForRole('implementer')
    const phases = new Set(recs.map(s => s.phase))
    assert.deepEqual([...phases].sort(), ['build', 'plan', 'verify'])
  })

  it('every recommended skill has name, desc, phase', () => {
    for (const s of recommendedSkillsForRole('researcher')) {
      assert.ok(s.name && s.desc && s.phase, `malformed: ${JSON.stringify(s)}`)
    }
  })
})

describe('skillPath', () => {
  it('builds an absolute path inside the vendor dir', () => {
    const p = skillPath('test-driven-development')
    assert.equal(p, join(SKILL_VENDOR_DIR, 'test-driven-development', 'SKILL.md'))
    assert.ok(p.startsWith(SKILL_VENDOR_DIR))
  })
})

describe('buildSkillsSection', () => {
  it('includes role bucket, slash commands, full catalog', () => {
    const out = buildSkillsSection('implementer')
    assert.ok(out.includes('Engineering Skills'))
    assert.ok(out.includes('bucket: implementer'))
    // All six slash commands appear.
    for (const cmd of Object.values(PHASE_SLASH_COMMANDS)) {
      assert.ok(out.includes(cmd), `missing command ${cmd}`)
    }
    // Full catalog line per phase.
    for (const phase of Object.keys(SKILL_CATALOG)) {
      assert.ok(out.includes(`${phase} (`), `missing phase line for ${phase}`)
    }
    // Mentions the vendored path (not a WebFetch URL) so agents Read locally.
    assert.ok(out.includes(SKILL_VENDOR_DIR))
    assert.ok(!out.includes('WebFetch'), 'should point at local Read, not WebFetch')
    assert.ok(!out.includes('raw.githubusercontent.com'), 'should not leak upstream URL')
  })

  it('differs across role buckets (role-aware shortlist)', () => {
    const coord = buildSkillsSection('team-lead')
    const rev = buildSkillsSection('reviewer')
    assert.ok(coord.includes('bucket: coordinator'))
    assert.ok(rev.includes('bucket: reviewer'))
    assert.notEqual(coord, rev)
  })

  it('handles empty role without throwing', () => {
    const out = buildSkillsSection('')
    assert.ok(out.includes('bucket: generalist'))
  })

  it('every recommended skill for the role appears in the output', () => {
    // Guards against a regression where the recommended block renders empty
    // but substring assertions (e.g. "Engineering Skills") keep tests green.
    for (const role of ['team-lead', 'researcher', 'implementer', 'reviewer', 'tester', 'shipper']) {
      const section = buildSkillsSection(role)
      for (const s of recommendedSkillsForRole(role)) {
        assert.ok(
          section.includes(`[${s.phase}] ${s.name}`),
          `buildSkillsSection('${role}') missing recommended skill line for ${s.name}`
        )
      }
    }
  })

  it('includes the /code-simplify extra slash command alongside phase commands', () => {
    const out = buildSkillsSection('implementer')
    for (const extra of EXTRA_SLASH_COMMANDS) {
      assert.ok(out.includes(extra), `missing extra slash command ${extra}`)
    }
  })
})
