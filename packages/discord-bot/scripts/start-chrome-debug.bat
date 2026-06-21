@echo off
REM Start Chrome with remote debugging port for agent-browser
REM This allows agent-browser --auto-connect to share logged-in sessions

set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
set DEBUG_PORT=9222
set USER_DATA="%LOCALAPPDATA%\Google\Chrome\User Data"

REM Check if Chrome is already running with debug port
netstat -ano 2>nul | findstr ":%DEBUG_PORT% " >nul 2>&1
if %errorlevel%==0 (
    echo Chrome is already running with debug port %DEBUG_PORT%.
    exit /b 0
)

REM Check if Chrome is running without debug port
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | findstr "chrome.exe" >nul 2>&1
if %errorlevel%==0 (
    echo Closing existing Chrome...
    taskkill /IM chrome.exe /F >nul 2>&1
    timeout /t 3 /nobreak >nul
)

echo Starting Chrome with remote debugging on port %DEBUG_PORT%...
start "" %CHROME_PATH% --remote-debugging-port=%DEBUG_PORT% --user-data-dir=%USER_DATA%
echo Chrome started with debugging enabled.
