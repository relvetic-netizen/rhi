@echo off
REM Ensure Chrome is running with rhi profile on CDP port 9222.
REM If already running, do nothing. If not, start it.

set DEBUG_PORT=9222
set PROFILE_PATH=%USERPROFILE%\.agent-browser\profiles\rhi
set BROWSERS_DIR=%USERPROFILE%\.agent-browser\browsers

REM Check if port 9222 is already listening
netstat -ano 2>nul | findstr ":%DEBUG_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo [ensure-rhi-chrome] Chrome already running on port %DEBUG_PORT%.
    exit /b 0
)

REM Find the latest agent-browser bundled Chrome
set CHROME_PATH=
for /f "delims=" %%d in ('dir /b /ad /o-n "%BROWSERS_DIR%\chrome-*" 2^>nul') do (
    if not defined CHROME_PATH set "CHROME_PATH=%BROWSERS_DIR%\%%d\chrome.exe"
)

REM Fallback to system Chrome if bundled not found
if not defined CHROME_PATH set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"

REM Remove stale lockfile if exists
if exist "%PROFILE_PATH%\lockfile" del /f "%PROFILE_PATH%\lockfile" 2>nul

echo [ensure-rhi-chrome] Starting Chrome on port %DEBUG_PORT% using %CHROME_PATH%...
start "RHI Chrome" /min "%CHROME_PATH%" --remote-debugging-port=%DEBUG_PORT% --user-data-dir="%PROFILE_PATH%" --disable-blink-features=AutomationControlled --no-first-run --no-default-browser-check

REM Wait 5 seconds for Chrome to start (ping-based, avoids timeout command conflict)
ping -n 6 127.0.0.1 >nul 2>&1

REM Verify Chrome started
netstat -ano 2>nul | findstr ":%DEBUG_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo [ensure-rhi-chrome] Chrome started successfully on port %DEBUG_PORT%.
) else (
    echo [ensure-rhi-chrome] WARNING: Chrome may not have started. Port %DEBUG_PORT% not listening.
)
