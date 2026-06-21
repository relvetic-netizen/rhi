import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '../lockfile.js'
import { ensureDir } from '../paths.js'

const TEST_DIR = join(process.cwd(), '.test-tmp-lock')

before(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
  await ensureDir(TEST_DIR)
})
after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
  await ensureDir(TEST_DIR)
})

describe('withLock', () => {
  it('creates separate .lock file (not locking data file)', async () => {
    const dataFile = join(TEST_DIR, 'data.json')
    await writeFile(dataFile, '{}')

    await withLock(dataFile, async () => {
      // During lock, .lock file should exist
      const lockFile = `${dataFile}.lock`
      const s = await stat(lockFile)
      assert.ok(s.isFile(), '.lock file should exist during lock')
    })
  })

  it('serializes concurrent operations', async () => {
    const dataFile = join(TEST_DIR, 'counter.txt')
    await writeFile(dataFile, '0')

    // Run 20 concurrent increments
    const increments = Array.from({ length: 20 }, () =>
      withLock(dataFile, async () => {
        const val = parseInt(await readFile(dataFile, 'utf-8'), 10)
        // Simulate work
        await new Promise(r => setTimeout(r, 1))
        await writeFile(dataFile, String(val + 1))
      })
    )

    await Promise.all(increments)

    const final = parseInt(await readFile(dataFile, 'utf-8'), 10)
    assert.equal(final, 20, `Expected 20 after 20 increments, got ${final}`)
  })

  it('releases lock even when callback throws', async () => {
    const dataFile = join(TEST_DIR, 'error.txt')
    await writeFile(dataFile, 'ok')

    try {
      await withLock(dataFile, async () => {
        throw new Error('Intentional error')
      })
    } catch (e) {
      assert.equal(e.message, 'Intentional error')
    }

    // Lock should be released — second lock should succeed
    await withLock(dataFile, async () => {
      const data = await readFile(dataFile, 'utf-8')
      assert.equal(data, 'ok')
    })
  })

  it('supports custom lockfilePath option', async () => {
    const dataFile = join(TEST_DIR, 'custom.json')
    const customLock = join(TEST_DIR, 'custom.mylock')
    await writeFile(dataFile, '{}')

    await withLock(dataFile, async () => {
      const s = await stat(customLock)
      assert.ok(s.isFile(), 'Custom lock file should exist during lock')
    }, { lockfilePath: customLock })
  })

  it('returns the value from the callback', async () => {
    const dataFile = join(TEST_DIR, 'return.txt')
    await writeFile(dataFile, 'hello')

    const result = await withLock(dataFile, async () => {
      return 42
    })

    assert.equal(result, 42)
  })
})
