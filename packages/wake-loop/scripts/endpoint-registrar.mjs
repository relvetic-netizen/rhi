// endpoint-registrar.mjs (generic, G1 初稿)
// Runs ON the worker PC (the one whose orchestrator should be woken by teammate mail).
// Keeps the shared peer endpoint  teams/<team>/peers/<agent>.json  (on the host PC) live by
// refreshing heartbeat_at every refreshMs, with a liveness check tied to the local orchestrator.
//
// Two-file split (why): the registrar runs here (worker), but the actual mutation of the wire
// endpoint happens via a thin helper ON the host, so heartbeat_at is stamped with the host's
// clock = the dispatcher's clock. This avoids clock skew between worker and host. The registrar
// is the worker-side loop + SSH driver; the host-side helper does the atomic write.
//
// Config: env WAKE_STACK_CONFIG (or ~/.claude/relvetia/wake-stack.worker.json). camelCase, human-authored.
// Wire  : teams/<team>/peers/<agent>.json on the host. snake_case, dispatcher-read. The publish
//         layer below maps camelCase config -> snake_case wire.
//
// owner_token: canonical file is the anchor (single source of truth). Generated once, then
//   inherited across restarts so a PM2/supervisor relaunch keeps the same first-writer identity
//   (regenerating every boot would self-lockout: the registrar would see its own live endpoint
//   as a foreign owner and stand down on exit 3).
//
// Exit-code contract (host helper): 0 refreshed / 2 endpoint-missing (registrar self-heals) /
//   3 token-refused (foreign owner holds the slot -> stand down, do not clobber).
//
// v1 scope: 2-PC (remote peer) only. A local / host-co-located peer (endpoint.sshTarget: null,
//   dispatcher local-route) is *schema-allowed* but not yet implemented here (the loop is
//   SSH/scp-only and requires remote.toHost) -> next stage.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const HOME = os.homedir();

// --- config: env -> file -> default ---------------------------------------
const CONFIG_PATH = process.env.WAKE_STACK_CONFIG || path.join(HOME, '.claude/relvetia/wake-stack.worker.json');
const fileCfg = (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
})();

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(HOME, p.slice(1).replace(/^[\\/]/, '')) : p;
}
// read a config value by dotted path, with an env override and a default.
function cfg(dotted, envKey, dflt) {
  if (envKey && process.env[envKey] != null) return process.env[envKey];
  let v = fileCfg;
  for (const k of dotted.split('.')) v = (v == null ? undefined : v[k]);
  return v == null ? dflt : v;
}

const AGENT = cfg('agent', 'WAKE_AGENT', null);
const ORCH_SESSION_ID = cfg('orchSessionId', 'WAKE_ORCH_SESSION_ID', null);
const REFRESH_MS = Number(cfg('registrar.refreshMs', 'WAKE_REFRESH_MS', 30_000));
const LIVENESS_MODE = cfg('liveness.mode', 'WAKE_LIVENESS_MODE', 'pid');
const ORCH_REGISTRY = expandHome(cfg('liveness.orchRegistry', null, null));
const CANONICAL = expandHome(cfg('canonical', 'WAKE_CANONICAL', null));

const TO_HOST = cfg('remote.toHost', 'WAKE_TO_HOST', null);          // worker -> host (push heartbeat)
const REMOTE_NODE = cfg('remote.nodePath', null, 'node');
const LOCAL_HELPER = expandHome(cfg('remote.localHelper', null, path.join(HOME, '.claude/relvetia/wake-loop-oss/endpoint-heartbeat-remote.mjs')));
const REMOTE_HELPER = cfg('remote.helperDest', null, null);
const REMOTE_DEST = cfg('remote.endpointDest', null, null);          // host wire endpoint path

const EP = fileCfg.endpoint || {};                                  // self-description we publish
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];

for (const [k, v] of Object.entries({ AGENT, ORCH_SESSION_ID, CANONICAL, TO_HOST, REMOTE_HELPER, REMOTE_DEST })) {
  if (v == null) { console.error(`config error: ${k} is required (check ${CONFIG_PATH})`); process.exit(1); }
}
// endpoint critical fields: these get published to the wire and a missing one silently corrupts
// dispatcher routing (e.g. an absent ssh_target makes JSON.stringify drop the key, and the
// dispatcher reads `ssh_target == null` as a *local* peer -> would local-route a remote peer).
for (const [k, v] of Object.entries({ 'endpoint.team': EP.team, 'endpoint.relvetiaDir': EP.relvetiaDir })) {
  if (v == null) { console.error(`config error: ${k} is required (check ${CONFIG_PATH})`); process.exit(1); }
}
// ssh_target: an explicit null is valid (local / host-co-located peer); only an *absent* key
// (a forgotten field) is the footgun, so validate key presence, not value.
if (!('sshTarget' in EP)) {
  console.error(`config error: endpoint.sshTarget is required (use null for a local/host-co-located peer). check ${CONFIG_PATH}`);
  process.exit(1);
}
// wake_on_inbox must be a real boolean: the string "true" would pass through `?? true` and then
// fail the dispatcher's strict `=== true` gate -> the peer silently never wakes. Fail loud at boot.
if (EP.wakeOnInbox !== undefined && typeof EP.wakeOnInbox !== 'boolean') {
  console.error(`config error: endpoint.wakeOnInbox must be a boolean, got ${typeof EP.wakeOnInbox} ${JSON.stringify(EP.wakeOnInbox)} (a string "true" silently fails the dispatcher's === true gate). check ${CONFIG_PATH}`);
  process.exit(1);
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// --- canonical anchors: owner_token + started_at --------------------------
// Both are inherited across restarts (generated/stamped once on first boot, then persisted in
// canonical). owner_token: a fresh one every boot would self-lockout (see header). started_at:
// inheriting keeps the original registration time stable across PM2/supervisor relaunches.
function loadCanonicalAnchors() {
  let canon = {};
  try { canon = JSON.parse(fs.readFileSync(CANONICAL, 'utf8')); } catch {}
  const now = new Date().toISOString();
  return {
    ownerToken: canon.owner_token || crypto.randomBytes(16).toString('hex'),
    startedAt: canon.started_at || now,
  };
}

// --- liveness probe (pluggable; pid is default, http/mtime are opt-in) -----
function livenessState() {
  if (LIVENESS_MODE !== 'pid') {
    throw new Error(`liveness.mode '${LIVENESS_MODE}' not implemented in this build (only 'pid')`);
  }
  try {
    const reg = JSON.parse(fs.readFileSync(ORCH_REGISTRY, 'utf8'));
    if (!reg.owner_pid) return 'closed';
    process.kill(reg.owner_pid, 0); // throws ESRCH if dead
    return 'active';
  } catch {
    return 'closed';
  }
}

// --- publish layer: camelCase config -> snake_case wire endpoint -----------
function buildWireEndpoint(ownerToken, startedAt, state) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    team: EP.team,
    agent: AGENT,                       // top-level
    session_id: null,                   // runtime / layer-2 binding: no runtime source wired in v1
    host: EP.host,
    ssh_target: EP.sshTarget,           // host -> worker (dispatcher injects here)
    relvetia_dir: EP.relvetiaDir,
    orch_session_id: ORCH_SESSION_ID,   // top-level, injected
    inject_dir: EP.injectDir,
    wake_on_inbox: EP.wakeOnInbox ?? true,
    pid: process.pid,
    state,
    started_at: startedAt,              // inherited from canonical across restarts
    heartbeat_at: now,                  // placeholder; host helper restamps with host clock
    owner_token: ownerToken,
    capabilities: EP.capabilities ?? ['claude-code', 'orchestrator'],
  };
}

// write the canonical (= local wire master), atomic.
function writeCanonical(obj) {
  const tmp = CANONICAL + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CANONICAL);
}

function ssh(args) {
  return execFileSync('ssh', [...SSH_OPTS, TO_HOST, ...args], {
    encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function scp(localPath, remotePath) {
  return execFileSync('scp', [...SSH_OPTS, localPath, `${TO_HOST}:${remotePath}`], {
    encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// push the canonical spec into place if the endpoint vanished on the host.
function rePlaceEndpoint() {
  scp(CANONICAL, REMOTE_DEST);
  log('SELF-HEAL re-placed endpoint from canonical');
}

function tick(ownerToken) {
  const state = livenessState();
  try {
    let out;
    try {
      out = ssh([REMOTE_NODE, REMOTE_HELPER, REMOTE_DEST, ownerToken, state]);
    } catch (e) {
      const code = e.status;
      if (code === 2) {            // endpoint missing -> self-heal then retry once
        rePlaceEndpoint();
        out = ssh([REMOTE_NODE, REMOTE_HELPER, REMOTE_DEST, ownerToken, state]);
      } else if (code === 3) {     // foreign owner holds the slot -> stand down, do not fight
        log('ALERT owner_token refused by host (foreign owner holds the slot) -> standing down this tick');
        return;
      } else {
        throw e;
      }
    }
    log('heartbeat ok: ' + String(out).trim());
  } catch (e) {
    log('ERROR heartbeat tick failed: ' + (e.message || e));
  }
}

// --- boot -----------------------------------------------------------------
const { ownerToken, startedAt } = loadCanonicalAnchors();
writeCanonical(buildWireEndpoint(ownerToken, startedAt, livenessState())); // persist anchors + publish-ready master

try {
  scp(LOCAL_HELPER, REMOTE_HELPER);
  log('deployed remote helper -> ' + REMOTE_HELPER);
} catch (e) {
  log('WARN could not deploy remote helper (will rely on existing copy): ' + (e.message || e));
}
// NB: no unconditional endpoint place on boot. tick() self-heals a *missing* endpoint via the
// helper's exit-2 path; a slot held by a foreign owner returns exit-3 -> we stand down, never clobber.

log(`registrar up: agent=${AGENT} refreshing ${REMOTE_DEST} every ${REFRESH_MS / 1000}s (owner_token=${ownerToken.slice(0, 8)}…, liveness=${LIVENESS_MODE})`);
tick(ownerToken);
setInterval(() => tick(ownerToken), REFRESH_MS);
