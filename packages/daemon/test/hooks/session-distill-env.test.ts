/**
 * session-distill-env.test.ts — regression test for the env-pipeline trap
 * in relvetia-harness/hooks/relvetia-session-distill-bg.sh line 181.
 *
 * Pre-fix shape (the trap):
 *     VAR=1 VAR=2 echo "$PROMPT" | claude --model ... -p
 *   The leading VAR= prefixes apply to `echo` only — `claude` (the
 *   right-hand consumer of the pipe) inherits the parent env with no
 *   override, so the Axis B / screening gates silently no-op.
 *
 * Post-fix shape (this test asserts the env actually reaches `claude`):
 *     echo "$PROMPT" | env VAR=1 VAR=2 claude --model ... -p
 *
 * The test mocks `claude` with a script that records its received env,
 * runs the post-fix pipeline through bash, and asserts the gate envs
 * arrived at the mock. CI runs on ubuntu-latest where bash is the
 * default shell; the test is skipped on platforms without bash on PATH
 * to keep local Windows runs from failing in environments that do not
 * have git-bash installed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'fs/promises'
import { tmpdir, platform } from 'os'
import { join } from 'path'
import { spawnSync, execFileSync } from 'child_process'

function hasBash(): boolean {
  try {
    const r = spawnSync('bash', ['-c', 'echo ok'], { stdio: 'pipe' })
    return r.status === 0 && r.stdout.toString().trim() === 'ok'
  } catch {
    return false
  }
}

// The hook is a POSIX bash script, so this regression test only meaningfully
// runs in environments where bash treats the spawn paths the same way the
// hook does. On Windows the Node tmpdir is a `C:\…` path that MSYS bash
// won't accept in `PATH` without cygpath translation — skip locally; CI
// runs on ubuntu where everything is POSIX and the test is the gate.
const BASH_AVAILABLE = hasBash()
const SHOULD_RUN = BASH_AVAILABLE && platform() !== 'win32'
const runIfBash = SHOULD_RUN ? describe : describe.skip

runIfBash('relvetia-session-distill-bg.sh env pipeline (post-fix)', () => {
  let root: string
  let mockBinDir: string
  let envCapturePath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'distill-env-'))
    mockBinDir = join(root, 'bin')
    await mkdir(mockBinDir, { recursive: true })
    envCapturePath = join(root, 'env-capture.txt')

    // Mock `claude`: emit RELVETIA_* env vars to a capture file and exit 0.
    // The mock also drains stdin so the upstream `echo` write succeeds.
    const mock = `#!/usr/bin/env bash
cat > /dev/null
{
  echo "RELVETIA_SCREENING_MEMORY=$RELVETIA_SCREENING_MEMORY"
  echo "RELVETIA_DAEMON_CHILD=$RELVETIA_DAEMON_CHILD"
} > "${envCapturePath.replace(/\\/g, '/')}"
echo "mock-claude-ok"
`
    const mockPath = join(mockBinDir, 'claude')
    await writeFile(mockPath, mock)
    await chmod(mockPath, 0o755)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('env-prefix on right of pipe propagates RELVETIA_* to `claude`', async () => {
    // Replicates the post-fix line shape exactly — env-prefix on the
    // consumer side of the pipe.
    const cmd = `PATH="${mockBinDir.replace(/\\/g, '/')}:$PATH" \
      bash -c 'echo "hello" | env RELVETIA_SCREENING_MEMORY=1 RELVETIA_DAEMON_CHILD=1 claude --model dummy -p'`
    const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' })
    expect(out.trim()).toBe('mock-claude-ok')

    const captured = await readFile(envCapturePath, 'utf8')
    expect(captured).toContain('RELVETIA_SCREENING_MEMORY=1')
    expect(captured).toContain('RELVETIA_DAEMON_CHILD=1')
  })

  it('pre-fix shape (env on LEFT of pipe) demonstrates the trap — vars never reach `claude`', async () => {
    // Sanity check that documents *why* the post-fix exists. With the
    // env on the echo side of the pipe, the consumer sees empty env.
    const cmd = `PATH="${mockBinDir.replace(/\\/g, '/')}:$PATH" \
      bash -c 'RELVETIA_SCREENING_MEMORY=1 RELVETIA_DAEMON_CHILD=1 echo "hello" | claude --model dummy -p'`
    execFileSync('bash', ['-c', cmd], { encoding: 'utf8' })
    const captured = await readFile(envCapturePath, 'utf8')
    // The mock echoes "RELVETIA_FOO=$RELVETIA_FOO"; with the bug, the
    // variable is unset, so the value is the empty string.
    expect(captured).toContain('RELVETIA_SCREENING_MEMORY=\n')
    expect(captured).toContain('RELVETIA_DAEMON_CHILD=\n')
  })
})
