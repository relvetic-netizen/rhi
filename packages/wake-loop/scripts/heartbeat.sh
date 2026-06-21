#!/bin/bash
# Persona heartbeat — cheap pre-check, spawns claude only when conditions met.
# Invoked every 5 min by Windows Task Scheduler (private-heartbeat).
#
# Logic:
#   1. Load state/private.json
#   2. Check current wall clock against active-hours windows
#   3. If asleep window → exit
#   4. If burst window AND within burst_until → spawn claude
#   5. If now >= next_wake_at → spawn claude
#   6. else → exit
#
# Spawning claude = `claude -p --dangerously-skip-permissions --model opus`
# with wake.md as prompt and state injected.
#
# All decisions (what to do, when to wake next) are made by claude inside
# the wake prompt. Shell only gates invocation to save LLM calls.

set -eu

PRIVATE_DIR="$HOME/.claude/relvetia/private"

# CWD を private ディレクトリにする — ここに CLAUDE.md を置いてあるので
# claude -p 起動時の auto-discovery で private 専用ブートローダーが読まれる。
# (Task Scheduler のデフォルト CWD C:\Windows\System32 を回避する意味もある)
cd "$PRIVATE_DIR"
STATE="$PRIVATE_DIR/state/private.json"
PROMPT="$PRIVATE_DIR/prompts/wake.md"
LOG_DIR="$PRIVATE_DIR/logs"
LOG_FILE="$LOG_DIR/heartbeat.log"

mkdir -p "$LOG_DIR"

ts() { date -Iseconds; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# ---- Active hours (local time, e.g. JST) ----
# active: 07:00-10:00 light, 17:00-01:00 main
# asleep: 10:00-17:00 (lunch), 01:00-07:00 (night)
HOUR=$(date +%H)
HOUR_NUM=$((10#$HOUR))  # force base-10

is_awake_hour() {
  # 7-9 OR 17-23 OR 0 (midnight hour)
  if [ "$HOUR_NUM" -ge 7 ] && [ "$HOUR_NUM" -lt 10 ]; then return 0; fi
  if [ "$HOUR_NUM" -ge 17 ] && [ "$HOUR_NUM" -le 23 ]; then return 0; fi
  if [ "$HOUR_NUM" -eq 0 ]; then return 0; fi
  return 1
}

if ! is_awake_hour; then
  log "asleep hour=$HOUR_NUM — skip"
  exit 0
fi

# ---- State check ----
if [ ! -f "$STATE" ]; then
  log "state missing — bootstrap needed, skip"
  exit 0
fi

# Guard against 0-byte / corrupted state: a truncated write can empty the state
# file, which makes JSON.parse crash silently under `set -eu` and skips wakes.
if [ ! -s "$STATE" ]; then
  log "state EMPTY (0 byte) — manual recovery needed, skip"
  exit 0
fi

NOW_EPOCH=$(date +%s)

# burst_until / next_wake_at を JSON から取得 (MSYSパス→Windowsパス変換)
STATE_WIN=$(cygpath -w "$STATE")
read_state() {
  # $1 = key
  # JSON.parse が失敗しても crash させず空文字を返す (corrupted state でも heartbeat 自体は生かす)
  node -e "const fs=require('fs');let s={};try{s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch(e){process.stderr.write('state parse error: '+e.message)};process.stdout.write(String(s[process.argv[2]]==null?'':s[process.argv[2]]))" "$STATE_WIN" "$1" 2>>"$LOG_FILE"
}
BURST_UNTIL=$(read_state burst_until)
NEXT_WAKE=$(read_state next_wake_at)
MODE=$(read_state mode)
[ -z "$MODE" ] && MODE="idle"

to_epoch() {
  # ISO8601 → epoch seconds (Windows/GNU date両対応)
  [ -z "$1" ] && { echo 0; return; }
  date -d "$1" +%s 2>/dev/null || echo 0
}

SHOULD_WAKE=0
REASON=""

if [ "$MODE" = "burst" ] && [ -n "$BURST_UNTIL" ]; then
  BU_EPOCH=$(to_epoch "$BURST_UNTIL")
  if [ "$NOW_EPOCH" -lt "$BU_EPOCH" ]; then
    SHOULD_WAKE=1
    REASON="burst (until=$BURST_UNTIL)"
  fi
fi

if [ "$SHOULD_WAKE" -eq 0 ] && [ -n "$NEXT_WAKE" ]; then
  NW_EPOCH=$(to_epoch "$NEXT_WAKE")
  if [ "$NW_EPOCH" -gt 0 ] && [ "$NOW_EPOCH" -ge "$NW_EPOCH" ]; then
    SHOULD_WAKE=1
    REASON="scheduled (next_wake=$NEXT_WAKE)"
  fi
fi

if [ "$SHOULD_WAKE" -eq 0 ]; then
  log "skip mode=$MODE next=$NEXT_WAKE burst_until=$BURST_UNTIL"
  exit 0
fi

# Guard: if next_wake_at matches the previous scheduled WAKE, the wake session
# failed to advance the state (rate limit, failed write, or the model forgot to
# update it). Re-spawning under the same condition is pointless, so skip. As
# long as the state advances, neither idle nor burst mode re-fires — this
# prevents a tight re-spawn loop when the API is rejecting requests.
LAST_WAKE_NEXT=$(grep "WAKE reason=scheduled" "$LOG_FILE" | tail -1 | sed -E 's/.*next_wake=([^)]+)\).*/\1/')
if [ -n "$LAST_WAKE_NEXT" ] && [ "$LAST_WAKE_NEXT" = "$NEXT_WAKE" ]; then
  log "guard: state.next_wake_at unchanged since last WAKE ($NEXT_WAKE) — skip"
  exit 0
fi

log "WAKE reason=$REASON mode=$MODE"

# ---- Spawn claude ----
# Pass state path via env so prompt can read it deterministically.
export PRIVATE_STATE_PATH="$STATE"
export PRIVATE_DIR

# Use --print so output goes to stdout (captured to log).
# Non-interactive, opus, permissions bypassed (relvetia-browser CLI / Bash etc.)
CLAUDE_LOG="$LOG_DIR/wake-$(date +%Y%m%d-%H%M%S).log"
{
  cat "$PROMPT"
  echo
  echo "---"
  echo "現在のstate (JSON):"
  cat "$STATE"
  echo
  echo "---"
  echo "起動理由: $REASON"
  echo "現在時刻 (JST): $(date -Iseconds)"
} | claude -p \
  --dangerously-skip-permissions \
  --permission-mode bypassPermissions \
  --add-dir "$HOME" \
  --add-dir "$HOME/.claude" \
  --add-dir "$HOME/.claude/memory" \
  --add-dir "$HOME/.claude/memory/private" \
  --add-dir "$HOME/.claude/relvetia/private" \
  --add-dir "$HOME/workspace" \
  --add-dir "/tmp" \
  --model opus \
  > "$CLAUDE_LOG" 2>&1 &

PID=$!
disown || true
log "spawned claude PID=$PID log=$CLAUDE_LOG"
exit 0
