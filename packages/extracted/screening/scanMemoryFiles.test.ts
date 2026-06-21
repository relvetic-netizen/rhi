// Tests for scanMemoryFiles helpers — focused on memory-kind-framework Phase 2a
// `hasMetaInventoryFrontmatter` exclusion.
//
// Run via `pnpm test` (vitest). Self-contained synthetic fixtures only —
// no production memory mutation.

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { hasMetaInventoryFrontmatter } from './scanMemoryFiles.js'

test('hasMetaInventoryFrontmatter: detects meta-inventory frontmatter', () => {
  const content = `---
memory_kind: meta-inventory
purpose: phase3-compaction-plan
created: 2026-05-29
---
<!-- sources: ... -->

# preferences.md inventory
`
  assert.equal(hasMetaInventoryFrontmatter(content), true)
})

test('hasMetaInventoryFrontmatter: returns false for legacy topic file (no frontmatter)', () => {
  const content = `# Topic Title

## Section
body line.
`
  assert.equal(hasMetaInventoryFrontmatter(content), false)
})

test('hasMetaInventoryFrontmatter: returns false for episodic kind (not meta-inventory)', () => {
  const content = `---
memory_kind: episodic
cap_policy: rotate-monthly
soft_cap: 500
hard_cap: 800
---

# Growth Log
`
  assert.equal(hasMetaInventoryFrontmatter(content), false)
})

test('hasMetaInventoryFrontmatter: returns false for task-ledger kind', () => {
  const content = `---
memory_kind: task-ledger
cap_policy: archive-on-complete
state: active
---

# Task: foo
`
  assert.equal(hasMetaInventoryFrontmatter(content), false)
})

test('hasMetaInventoryFrontmatter: handles CRLF line endings', () => {
  const content = `---\r\nmemory_kind: meta-inventory\r\npurpose: test\r\n---\r\n`
  assert.equal(hasMetaInventoryFrontmatter(content), true)
})

test('hasMetaInventoryFrontmatter: returns false when closing --- missing in first 20 lines', () => {
  const content = `---\nmemory_kind: meta-inventory\nbody line without closing dashes`
  assert.equal(hasMetaInventoryFrontmatter(content), false)
})

test('hasMetaInventoryFrontmatter: returns false for HTML comment only (no frontmatter)', () => {
  const content = `<!-- sources: foo -->
# Title
body
`
  assert.equal(hasMetaInventoryFrontmatter(content), false)
})

test('hasMetaInventoryFrontmatter: matches inside multi-key frontmatter (not first key)', () => {
  const content = `---
purpose: inventory
memory_kind: meta-inventory
created: 2026-05-29
---
content
`
  assert.equal(hasMetaInventoryFrontmatter(content), true)
})

test('hasMetaInventoryFrontmatter: rejects partial match (memory_kind: meta-inventory-similar)', () => {
  const content = `---\nmemory_kind: meta-inventory-similar\n---\n`
  assert.equal(hasMetaInventoryFrontmatter(content), false)
})

test('hasMetaInventoryFrontmatter: respects leading whitespace style (memory_kind:   meta-inventory)', () => {
  const content = `---\nmemory_kind:    meta-inventory\n---\n`
  assert.equal(hasMetaInventoryFrontmatter(content), true)
})
