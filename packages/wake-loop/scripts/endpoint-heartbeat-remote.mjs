// endpoint-heartbeat-remote.mjs (generic, G1 初稿)
// Runs ON the host PC (the one that hosts teams/<team>/peers/). Refreshes heartbeat_at + state
// on the shared wire endpoint, stamped with the HOST clock (= dispatcher's clock).
// Invoked by the worker registrar over SSH:  node THIS <endpointPath> <ownerToken> <state>
// Exit codes: 0 refreshed, 2 file-missing (registrar will re-place), 3 token-refused.
import fs from 'fs';

const FILE = process.argv[2];
const ownerToken = process.argv[3] || '';
const state = process.argv[4] || 'active';

if (!FILE) { console.log('USAGE: node endpoint-heartbeat-remote.mjs <endpointPath> <ownerToken> <state>'); process.exit(64); }
if (!fs.existsSync(FILE)) { console.log('MISSING ' + FILE); process.exit(2); }

const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// layer-1: only the owner_token holder may mutate a live endpoint.
if (obj.owner_token && ownerToken && obj.owner_token !== ownerToken) {
  console.log('REFUSE owner_token mismatch');
  process.exit(3);
}

obj.state = state;
obj.heartbeat_at = new Date().toISOString(); // host clock = dispatcher's clock
if (!obj.started_at) obj.started_at = obj.heartbeat_at;

const tmp = FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
fs.renameSync(tmp, FILE); // atomic replace
console.log('REFRESH state=' + obj.state + ' heartbeat=' + obj.heartbeat_at);
