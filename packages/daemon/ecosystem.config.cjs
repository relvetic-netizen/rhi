const { homedir } = require('os')
const { join } = require('path')
const { readdirSync, existsSync } = require('fs')

const home = homedir()
// Layout roots are env-overridable so a clone can relocate the whole tree
// without editing this manifest. Defaults mirror the canonical ~/.claude layout.
const relvetiaDir = process.env.RELVETIA_DIR ?? join(home, '.claude', 'relvetia')
const memoryDir = process.env.RELVETIA_MEMORY_DIR ?? join(home, '.claude', 'memory')
const scriptsDir = process.env.RELVETIA_SCRIPTS_DIR ?? join(home, '.claude', 'scripts', 'relvetia')
// Optional 2nd daemon entry for the private memory zone's distillation.
// A separate RELVETIA_DIR gives it its own scheduler.lock +
// scheduled_tasks.json. It reuses the same dist/ bundle and bootstrap
// STATIC_PERMANENT_TASKS, filtered down to private-distill via the
// RELVETIA_DAEMON_TASKS env.
const relvetiaPrivateDir = process.env.RELVETIA_PRIVATE_DIR ?? join(home, '.claude', 'relvetia-private')
const privateMemoryDir = process.env.RELVETIA_PRIVATE_MEMORY_DIR ?? join(memoryDir, 'private')

// Ensure claude CLI is on PATH for PM2-spawned processes
function getClaudeParentDir() {
  const fnmBase = join(home, '.fnm', 'node-versions')
  if (existsSync(fnmBase)) {
    const versions = readdirSync(fnmBase).sort().reverse()
    for (const v of versions) {
      const dir = join(fnmBase, v, 'installation')
      if (existsSync(join(dir, 'claude')) || existsSync(join(dir, 'claude.cmd'))) {
        return dir
      }
    }
  }
  return null
}

const claudeDir = getClaudeParentDir()
const tsxBinDir = join(relvetiaDir, 'node_modules', '.bin')
const pathDelim = require('path').delimiter
const extraPath = [claudeDir, tsxBinDir, process.env.PATH || ''].filter(Boolean).join(pathDelim)

const inboxWatcherScript = join(scriptsDir, 'inbox-watcher.mjs')
const inboxWatcherCwd = scriptsDir

// W2-S1 S1-F fixture daemon (injection-harness).
const fixtureDaemonScript = join(scriptsDir, 'fixture-daemon.mjs')
const fixtureDaemonCwd = scriptsDir
const injectionLedgerPath = join(relvetiaDir, 'ledger-injection-test.json')

module.exports = {
  apps: [{
    name: 'relvetia-daemon',
    script: join(relvetiaDir, 'dist', 'relvetia-daemon', 'src', 'index.js'),
    cwd: relvetiaDir,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    min_uptime: 10000,
    env: {
      RELVETIA_DIR: relvetiaDir,
      RELVETIA_MEMORY_DIR: memoryDir,
      RELVETIA_MODEL: 'claude-opus-4-8[1m]',
      RELVETIA_MAX_TURNS: '80',
      // Tier-specific budgets (env 化 5/1) — fallback chain via RELVETIA_MAX_TURNS
      // HEAVY (dream / hier mode): keeps 80-turn working baseline (PR #14 hier 実績値)
      RELVETIA_HEAVY_MAX_TURNS: '80',
      RELVETIA_HEAVY_TIMEOUT_MS: '1500000',
      // LIGHT (rec / verify / session-distill): 40 turns / 10min (commit 700eb78 稼働中)
      RELVETIA_LIGHT_MAX_TURNS: '40',
      RELVETIA_LIGHT_TIMEOUT_MS: '600000',
      NODE_ENV: 'production',
      PATH: extraPath,
      // Phase 1.5/2 (5/3): emit screening:bm25_screening / log_line_screening
      // / search_completed events to stderr for scale=5.0 妥当性 + log-line
      // layer 観測。screeningLog.ts が import 時に env を evaluate して
      // _enabled=true で auto-enable する (PM2 main + spawned children 両方
      // の経路で同じ env を参照)。setup.sh が ecosystem.config.cjs を copy +
      // pm2 delete+start で env reload する仕組みなので、本ファイルの edit
      // が source-of-truth。
      RELVETIA_SCREENING_SEARCH: '1',
      // Walker family dry-run gate. Set to '1' until private gives live ack
      // (planned 5/7 wake). buildWalkerEnv() in walker-executor.ts inherits
      // process.env, so this propagates to spawned x-walker / discord-walker.
      // See proposals/2026-04-28-migration-ack.md §2.
      WALKER_DRY_RUN: '1',
    },
  },
  {
    // Inbox-watcher daemon — was previously started ad-hoc via `pm2 start
    // inbox-watcher.mjs --name inbox-watcher` and persisted in ~/.pm2/dump.pm2
    // without RELVETIA_INBOX_INJECT_RELAY. Promoted to ecosystem source-of-truth
    // 2026-05-08 to wire today's multi-turn orchestration loop end-to-end.
    name: 'inbox-watcher',
    script: inboxWatcherScript,
    cwd: inboxWatcherCwd,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    min_uptime: 10000,
    env: {
      RELVETIA_DIR: relvetiaDir,
      RELVETIA_MEMORY_DIR: memoryDir,
      NODE_ENV: 'production',
      PATH: extraPath,
      // Multi-turn orchestration loop (commit e7ca648 / 2026-05-08): when an
      // unread inbox message carries an `orchestrator_session_id` field, the
      // daemon looks up the orchestrator registry and posts a relayed prompt
      // via the wrapper inject mailbox so the orchestrator session advances
      // its next turn end-to-end (closes the loop the 5/7 phase1-orch test
      // failed to close — orchestrator could not actively observe worker ACKs).
      RELVETIA_INBOX_INJECT_RELAY: '1',
      // Source gating (Missing #4 / commit 60dd13b) stays opt-in until the
      // expected-request dispatch table is populated by orchestrator-side
      // production code. Enable per-team only after dogfood proves the
      // dispatched_to + run_id flow end-to-end.
      // RELVETIA_INBOX_INJECT_REQUIRE_EXPECTED: '1',
      // Windows polling (commit 680d51f / 2026-05-08): chokidar 'add' events
      // on newly-created inbox files are unreliable on win32. Polling defaults
      // to true on win32 already; explicit here so the env stays auditable
      // via `pm2 env <id>`. The 30s periodic rescan is a safety net that
      // re-scans every watched inbox even when chokidar misses an event.
      RELVETIA_CHOKIDAR_USE_POLLING: '1',
      RELVETIA_CHOKIDAR_POLL_INTERVAL_MS: '750',
      RELVETIA_INBOX_RESCAN_INTERVAL_MS: '30000',
    },
  },
  {
    // W2-S1 S1-F: dev-only fixture daemon for injection harness (W2-DONT-6 enforce).
    // production daemon (relvetia-daemon / inbox-watcher) とは PID 別 / ledger file
    // 別 / team namespace 別で完全分離。`pm2 start ecosystem.config.cjs --only
    // relvetia-injection-test` で manual 起動、production と独立で起動・停止可。
    name: 'relvetia-injection-test',
    script: fixtureDaemonScript,
    cwd: fixtureDaemonCwd,
    watch: false,
    autorestart: false,         // dev-only、auto restart せず
    max_restarts: 0,
    env: {
      RELVETIA_DIR: relvetiaDir,
      RELVETIA_LEDGER_PATH: injectionLedgerPath,
      RELVETIA_TEAM_NAMESPACE: 'team-injection-test',
      LEDGER_W2_WRITER_ENABLED: 'true',
      NODE_ENV: 'development',
      PATH: extraPath,
    },
  },
  {
    // Private memory zone distillation daemon (optional).
    // Shares the same dist/index.js as relvetia-daemon — task selection is via
    // RELVETIA_DAEMON_TASKS env. Separate RELVETIA_DIR gives a separate
    // scheduler.lock + scheduled_tasks.json so the two daemons never race.
    // RELVETIA_MEMORY_DIR points at the private memory zone so child distill
    // processes (claude --print) write to private/topics, private/MEMORY.md,
    // etc. — gated by sensitive-file-gate.sh Phase 5 (daemon-child allow).
    name: 'relvetia-daemon-private',
    script: join(relvetiaDir, 'dist', 'relvetia-daemon', 'src', 'index.js'),
    cwd: relvetiaPrivateDir,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    min_uptime: 10000,
    env: {
      RELVETIA_DIR: relvetiaPrivateDir,
      RELVETIA_MEMORY_DIR: privateMemoryDir,
      RELVETIA_DAEMON_TASKS: 'private-distill',
      RELVETIA_MODEL: 'claude-opus-4-8[1m]',
      RELVETIA_MAX_TURNS: '80',
      RELVETIA_HEAVY_MAX_TURNS: '80',
      RELVETIA_HEAVY_TIMEOUT_MS: '1500000',
      RELVETIA_LIGHT_MAX_TURNS: '40',
      RELVETIA_LIGHT_TIMEOUT_MS: '600000',
      NODE_ENV: 'production',
      PATH: extraPath,
      RELVETIA_SCREENING_SEARCH: '1',
      WALKER_DRY_RUN: '1',
    },
  }],
}
