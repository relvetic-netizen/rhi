@echo off
:: RHI Discord Bot - Start All Services
:: Usage: Double-click or run from terminal

echo [RHI] Starting Discord Bot services...

:: Kill existing bot process if running (avoid duplicate Gateway login)
for /f "tokens=2" %%i in ('tasklist /v /fi "IMAGENAME eq node.exe" /fo CSV 2^>nul ^| findstr /i "rhi-discord-bot\\dist\\index.js"') do (
    echo [RHI] Killing existing bot process PID %%~i
    taskkill /PID %%~i /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start Discord Bot (Gateway + slash commands + message handling)
echo [RHI] Starting Discord Bot (Gateway)...
start "" /min node "%~dp0dist\index.js"

:: MCP standalone is auto-started by Claude Code (registered in ~/.claude.json)
:: No need to start it here

echo.
echo [RHI] Done. Discord Bot is running in background.
echo   - Bot (Gateway): node dist/index.js
echo   - MCP Standalone: auto-started by Claude Code
echo   - Scheduled Tasks: managed by Windows Task Scheduler
echo.
echo You can close this window.
pause
