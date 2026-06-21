# Schedule Runner — Common wrapper for all RHI scheduled tasks
# Provides: logging, execution timing, Discord error notification
#
# Usage: powershell -ExecutionPolicy Bypass -File schedule-runner.ps1 -TaskName "MorningBrief" -ScheduleFile "...\morning-brief.md" [-Model "haiku"] [-EnsureChrome]

param(
    [Parameter(Mandatory=$true)]
    [string]$TaskName,

    [Parameter(Mandatory=$true)]
    [string]$ScheduleFile,

    [string]$Model = "haiku",

    [switch]$EnsureChrome,

    [string]$WebhookUrl = $env:DISCORD_WEBHOOK_ERROR_URL
)

$ErrorActionPreference = "Continue"
$BotDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $BotDir "logs"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "schedule-$TaskName-$Timestamp.log"

# Ensure logs directory exists
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Start
$StartTime = Get-Date
"[START] $TaskName at $StartTime" | Tee-Object -FilePath $LogFile
"[MODEL] $Model" | Add-Content $LogFile
"[SCHEDULE] $ScheduleFile" | Add-Content $LogFile

# Ensure Chrome CDP if needed
if ($EnsureChrome) {
    "[CHROME] Ensuring rhi Chrome is running..." | Add-Content $LogFile
    & cmd.exe /c "call `"$BotDir\scripts\ensure-rhi-chrome.bat`"" 2>&1 | Add-Content $LogFile
}

# Run Claude CLI
try {
    $Output = type $ScheduleFile | claude -p --dangerously-skip-permissions --output-format text --model $Model 2>&1
    $ExitCode = $LASTEXITCODE
} catch {
    $Output = "PowerShell exception: $_"
    $ExitCode = 99
}

$EndTime = Get-Date
$Duration = [math]::Round(($EndTime - $StartTime).TotalSeconds, 1)

# Log output
"[OUTPUT]" | Add-Content $LogFile
$Output | Add-Content $LogFile
"[EXITCODE] $ExitCode" | Add-Content $LogFile
"[DURATION] ${Duration}s" | Add-Content $LogFile
"[END] $EndTime" | Add-Content $LogFile

# Console summary
if ($ExitCode -eq 0) {
    Write-Host "[OK] $TaskName completed in ${Duration}s"
} else {
    Write-Host "[FAIL] $TaskName failed (exit $ExitCode) after ${Duration}s"
}

# Discord notification on failure
if ($ExitCode -ne 0 -and $WebhookUrl) {
    $ErrorPreview = ($Output | Out-String).Substring(0, [Math]::Min(500, ($Output | Out-String).Length))
    $Body = @{
        content = "⚠️ **Schedule task failed**: ``$TaskName``\nExit code: $ExitCode | Duration: ${Duration}s\n``````\n$ErrorPreview\n``````"
    } | ConvertTo-Json -Depth 2
    try {
        Invoke-RestMethod -Uri $WebhookUrl -Method Post -Body $Body -ContentType "application/json" -TimeoutSec 10
    } catch {
        "[WEBHOOK_ERROR] Failed to send Discord notification: $_" | Add-Content $LogFile
    }
}

# Log rotation — keep last 30 days
Get-ChildItem -Path $LogDir -Filter "schedule-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force

exit $ExitCode
