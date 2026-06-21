@echo off
REM Windows Task Scheduler wrapper for private heartbeat.
REM Invokes git-bash with heartbeat.sh in login mode (for PATH setup).
"C:\Program Files\Git\bin\bash.exe" -l -c "~/.claude/relvetia/private/heartbeat.sh"
