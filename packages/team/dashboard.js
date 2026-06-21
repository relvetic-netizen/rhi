#!/usr/bin/env node
/**
 * Claude Swarm Dashboard v2 — Agent Chat Window UI
 * Each agent gets its own chat window. Users can send messages directly.
 * Usage: node dashboard.js [port]
 */

import { createServer } from 'node:http'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PORT = parseInt(process.argv[2] || '3847', 10)
const TEAMS_DIR = join(homedir(), '.claude', 'teams')
const TASKS_DIR = join(homedir(), '.claude', 'tasks')

// ── Data readers ────────────────────────────────────────────────────────────

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')) }
  catch { return null }
}

async function listTeams() {
  try {
    const entries = await readdir(TEAMS_DIR, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch { return [] }
}

async function getTeamData(teamName) {
  const config = await readJson(join(TEAMS_DIR, teamName, 'config.json'))
  if (!config) return null

  const inboxDir = join(TEAMS_DIR, teamName, 'inboxes')
  const inboxes = {}
  try {
    const files = await readdir(inboxDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      inboxes[f.replace('.json', '')] = await readJson(join(inboxDir, f)) || []
    }
  } catch {}

  const taskDir = join(TASKS_DIR, teamName)
  const tasks = []
  try {
    const files = await readdir(taskDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const t = await readJson(join(taskDir, f))
      if (t?.id) tasks.push(t)
    }
  } catch {}
  tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id))

  return { config, inboxes, tasks }
}

async function getAllData() {
  const teamNames = await listTeams()
  const teams = {}
  for (const n of teamNames) teams[n] = await getTeamData(n)
  return { teams, timestamp: new Date().toISOString() }
}

// ── Message sender ──────────────────────────────────────────────────────────

async function sendMessage(teamName, to, message) {
  const inboxPath = join(TEAMS_DIR, teamName, 'inboxes', `${to}.json`)
  let inbox = await readJson(inboxPath) || []
  inbox.push({
    from: 'user',
    text: message,
    timestamp: new Date().toISOString(),
    color: 'white',
    read: false,
  })
  await mkdir(join(TEAMS_DIR, teamName, 'inboxes'), { recursive: true })
  await writeFile(inboxPath, JSON.stringify(inbox, null, 2), 'utf-8')
}

// ── HTML ────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Swarm Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #7d8590; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
    --blue: #58a6ff; --purple: #bc8cff; --orange: #d18616;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }

  /* Header */
  .header {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 12px 20px; display: flex; align-items: center; justify-content: space-between;
  }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header h1 span { color: var(--accent); }
  .header-right { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--muted); }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: blink 2s infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }

  /* Team selector */
  .team-bar {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 8px 20px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .team-tab {
    padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    transition: all .15s;
  }
  .team-tab:hover { color: var(--text); border-color: var(--muted); }
  .team-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .team-meta { margin-left: auto; font-size: 11px; color: var(--muted); }

  /* Layout */
  .main { display: flex; height: calc(100vh - 88px); }

  /* Task sidebar */
  .sidebar {
    width: 260px; min-width: 260px; background: var(--surface);
    border-right: 1px solid var(--border); overflow-y: auto; padding: 12px;
  }
  .sidebar h3 { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 8px; }
  .task {
    padding: 8px 10px; border-radius: 6px; margin-bottom: 4px;
    background: rgba(255,255,255,.02); border-left: 3px solid var(--border);
    font-size: 12px; line-height: 1.4;
  }
  .task.completed { border-left-color: var(--green); opacity: .6; }
  .task.in_progress { border-left-color: var(--blue); }
  .task.pending { border-left-color: var(--yellow); }
  .task-title { font-weight: 500; margin-bottom: 2px; }
  .task-info { color: var(--muted); font-size: 11px; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .badge-completed { background: rgba(63,185,80,.15); color: var(--green); }
  .badge-in_progress { background: rgba(88,166,255,.15); color: var(--blue); }
  .badge-pending { background: rgba(210,153,34,.15); color: var(--yellow); }

  /* Agent windows grid */
  .agents-grid {
    flex: 1; display: grid; gap: 0; overflow: hidden;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  }

  /* Agent window */
  .agent-window {
    display: flex; flex-direction: column; border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .agent-header {
    padding: 10px 14px; background: var(--surface); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px;
  }
  .agent-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .agent-name { font-size: 14px; font-weight: 600; }
  .agent-role { font-size: 11px; color: var(--muted); }
  .agent-unread { background: var(--red); color: #fff; font-size: 10px; font-weight: 700;
    padding: 1px 6px; border-radius: 8px; margin-left: auto; }

  /* Chat area */
  .chat-area { flex: 1; overflow-y: auto; padding: 10px 14px; background: var(--bg); }
  .msg-row { margin-bottom: 8px; }
  .msg-row.from-user .msg-bubble { background: rgba(88,166,255,.12); border-left: 2px solid var(--accent); }
  .msg-row.from-system .msg-bubble { background: rgba(255,255,255,.03); border-left: 2px solid var(--muted); font-style: italic; }
  .msg-header { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .msg-sender { font-size: 12px; font-weight: 600; }
  .msg-time { font-size: 10px; color: var(--muted); }
  .msg-new { font-size: 9px; color: var(--red); font-weight: 700; }
  .msg-bubble { padding: 6px 10px; border-radius: 6px; font-size: 13px; line-height: 1.5;
    background: rgba(255,255,255,.04); border-left: 2px solid var(--border);
    white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }

  /* Input */
  .chat-input {
    display: flex; padding: 8px 10px; background: var(--surface);
    border-top: 1px solid var(--border); gap: 6px;
  }
  .chat-input input {
    flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 12px; color: var(--text); font-size: 13px; outline: none;
  }
  .chat-input input:focus { border-color: var(--accent); }
  .chat-input input::placeholder { color: var(--muted); }
  .chat-input button {
    background: var(--accent); border: none; border-radius: 6px;
    padding: 8px 16px; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .chat-input button:hover { opacity: .85; }

  .empty { display: flex; align-items: center; justify-content: center;
    height: calc(100vh - 88px); color: var(--muted); font-size: 16px; }

  @media (max-width: 900px) {
    .sidebar { display: none; }
    .agents-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="header">
  <h1><span>Swarm</span> Dashboard</h1>
  <div class="header-right"><div class="live-dot"></div>Live</div>
</div>
<div class="team-bar" id="teamBar"></div>
<div class="main" id="main"><div class="empty">No active teams</div></div>

<script>
let DATA = null;
let activeTeam = null;

const COLORS = {
  white:'#848d97', red:'#f85149', blue:'#58a6ff', green:'#3fb950',
  yellow:'#d29922', purple:'#bc8cff', cyan:'#39d2c0', orange:'#d18616', pink:'#db61a2'
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return Math.floor(diffMs/60000) + 'm ago';
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('ja-JP', {month:'numeric',day:'numeric'}) + ' ' +
         d.toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'});
}

function parseMsg(text) {
  try {
    const j = JSON.parse(text);
    if (j.type === 'task_assignment') return '[Task] ' + j.subject;
    if (j.type === 'shutdown_request') return '[Shutdown] ' + (j.reason||'');
    if (j.type === 'shutdown_approved') return '[Shutdown OK]';
    if (j.type === 'idle_notification') return '[Idle]';
    return j.message || j.text || text;
  } catch { return text; }
}

function isSystemMsg(text) {
  try {
    const j = JSON.parse(text);
    return ['idle_notification','shutdown_approved','shutdown_request'].includes(j.type);
  } catch { return false; }
}

function renderTeamBar() {
  const bar = document.getElementById('teamBar');
  const teams = Object.keys(DATA.teams).filter(n => DATA.teams[n]);
  if (teams.length === 0) { bar.innerHTML = '<span style="color:var(--muted);font-size:13px">No teams</span>'; return; }
  if (!activeTeam || !teams.includes(activeTeam)) activeTeam = teams[0];

  const td = DATA.teams[activeTeam];
  const taskCount = td?.tasks?.length || 0;
  const completedCount = td?.tasks?.filter(t=>t.status==='completed').length || 0;

  bar.innerHTML = teams.map(n =>
    '<button class="team-tab' + (n===activeTeam?' active':'') + '" onclick="switchTeam(\\''+n+'\\')">'+n+'</button>'
  ).join('') +
  '<span class="team-meta">' + (td?.config?.description||'') + ' | ' + completedCount+'/'+taskCount+' tasks done</span>';
}

function getAgentMessages(teamData, agentName) {
  // Collect messages TO this agent (from their inbox) and FROM this agent (found in other inboxes)
  const msgs = [];

  // Messages in this agent's inbox (received by this agent)
  const inbox = teamData.inboxes[agentName] || [];
  inbox.forEach(m => {
    msgs.push({ ...m, direction: 'incoming', parsed: parseMsg(m.text), isSystem: isSystemMsg(m.text) });
  });

  // Messages FROM this agent (found in other agents' inboxes)
  for (const [recipient, rInbox] of Object.entries(teamData.inboxes)) {
    if (recipient === agentName) continue;
    rInbox.forEach(m => {
      if (m.from === agentName) {
        msgs.push({ ...m, direction: 'outgoing', recipient, parsed: parseMsg(m.text), isSystem: isSystemMsg(m.text) });
      }
    });
  }

  msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return msgs;
}

function renderMain() {
  const main = document.getElementById('main');
  const td = DATA.teams[activeTeam];
  if (!td) { main.innerHTML = '<div class="empty">No active teams</div>'; return; }

  const members = td.config.members || [];
  const tasks = td.tasks.filter(t => !t.metadata?._internal);
  const colorMap = {};
  members.forEach(m => { colorMap[m.name] = m.color || 'white'; });

  // Sidebar: tasks
  const sidebar = '<div class="sidebar"><h3>Tasks (' + tasks.length + ')</h3>' +
    (tasks.length === 0 ? '<div style="color:var(--muted);font-size:12px">No tasks</div>' :
    tasks.map(t => '<div class="task '+t.status+'"><div class="task-title">#'+t.id+' '+t.subject+'</div>' +
      '<div class="task-info"><span class="badge badge-'+t.status+'">'+t.status.replace('_',' ')+'</span> '+
      (t.owner||'')+'</div></div>').join('')) + '</div>';

  // Agent windows
  const agentHtml = members.map(m => {
    const msgs = getAgentMessages(td, m.name);
    const unread = (td.inboxes[m.name]||[]).filter(x => !x.read).length;
    const color = COLORS[colorMap[m.name]] || COLORS.white;

    return '<div class="agent-window" id="win-'+m.name+'">' +
      '<div class="agent-header">' +
        '<div class="agent-dot" style="background:'+color+'"></div>' +
        '<div><div class="agent-name">'+m.name+'</div>' +
        '<div class="agent-role">'+(m.agentType||m.role||'')+'</div></div>' +
        (unread > 0 ? '<div class="agent-unread">'+unread+'</div>' : '') +
      '</div>' +
      '<div class="chat-area" id="chat-'+m.name+'">' +
        msgs.map(msg => {
          if (msg.isSystem) {
            return '<div class="msg-row from-system"><div class="msg-bubble" style="font-size:11px;opacity:.5">'+msg.parsed+'</div></div>';
          }
          const isFromUser = msg.from === 'user';
          const isIncoming = msg.direction === 'incoming';
          const arrow = isIncoming ? (msg.from + ' → ' + m.name) : (m.name + ' → ' + (msg.recipient||'?'));
          return '<div class="msg-row'+(isFromUser?' from-user':'')+'">' +
            '<div class="msg-header">' +
              '<span class="msg-sender" style="color:'+(COLORS[colorMap[msg.from]]||COLORS.white)+'">'+arrow+'</span>' +
              '<span class="msg-time">'+fmtTime(msg.timestamp)+'</span>' +
              (!msg.read && isIncoming ? '<span class="msg-new">NEW</span>' : '') +
            '</div>' +
            '<div class="msg-bubble">'+escHtml(msg.parsed)+'</div></div>';
        }).join('') +
      '</div>' +
      '<div class="chat-input">' +
        '<input type="text" id="input-'+m.name+'" placeholder="Send message to '+m.name+'..." ' +
          'onkeydown="if(event.key===\\'Enter\\')sendMsg(\\''+m.name+'\\')"/>' +
        '<button onclick="sendMsg(\\''+m.name+'\\')">Send</button>' +
      '</div></div>';
  }).join('');

  main.innerHTML = sidebar + '<div class="agents-grid">' + agentHtml + '</div>';

  // Auto-scroll chat areas to bottom
  members.forEach(m => {
    const el = document.getElementById('chat-'+m.name);
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

window.switchTeam = function(name) { activeTeam = name; renderTeamBar(); renderMain(); }

window.sendMsg = async function(agentName) {
  const input = document.getElementById('input-'+agentName);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;

  try {
    const resp = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: activeTeam, to: agentName, message: text }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    await refresh();
  } catch (e) {
    alert('Send failed: ' + e.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function refresh() {
  try {
    // Save input values before re-render
    const saved = {};
    document.querySelectorAll('.chat-input input').forEach(el => {
      if (el.value) saved[el.id] = el.value;
    });
    const focusedId = document.activeElement?.id;

    const r = await fetch('/api/data');
    DATA = await r.json();
    renderTeamBar();
    renderMain();

    // Restore input values after re-render
    for (const [id, val] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }
    if (focusedId) {
      const el = document.getElementById(focusedId);
      if (el) el.focus();
    }
  } catch {}
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(await getAllData()))
    return
  }

  if (req.url === '/api/send' && req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      const { team, to, message } = JSON.parse(Buffer.concat(chunks).toString())
      if (!team || !to || !message) throw new Error('Missing team, to, or message')
      await sendMessage(team, to, message)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end(e.message)
    }
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

server.listen(PORT, () => {
  console.log(`\n  Swarm Dashboard v2`)
  console.log(`  http://localhost:${PORT}\n`)
})
