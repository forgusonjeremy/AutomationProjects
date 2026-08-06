# Stop-DatastoreLatency.ps1
# Connects to each server in the CSV and kills all running instances of
# generate_datastore_latency.sh and its wrapper, then removes working files.
#
# Usage:
#   .\Stop-DatastoreLatency.ps1 -CsvPath "servers.csv"
#
# Requires: OpenSSH client in PATH, passwordless SSH configured for sshuser
#
# CSV format:
#   Server,Username,Port
#   192.168.1.10,sshuser,22

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath,

    [string]$ScriptName   = "generate_datastore_latency.sh",
    [string]$WorkingDir   = "~/latency_test",
    [string]$LogFile      = "~/latency_test.log",
    [int]$MaxParallelJobs = 20
)

# ── Validate ──────────────────────────────────────────────────────────────────
if (-not (Test-Path $CsvPath)) {
    Write-Error "CSV file not found: $CsvPath"
    exit 1
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Error "ssh not found in PATH."
    exit 1
}

$servers = Import-Csv -Path $CsvPath
if ($servers.Count -eq 0) {
    Write-Error "CSV is empty."
    exit 1
}

# ── Remote kill command ───────────────────────────────────────────────────────
# Kills by process group so all child workers (fio, dd, metadata thrasher) are
# caught too. Always removes the working directory and state files regardless
# of whether any processes were found.
$killCommand = @"
SCRIPT='$ScriptName'
WORKDIR='$WorkingDir'
LOGFILE='$LogFile'

echo "[INFO] Checking for running instances of `$SCRIPT on `$(hostname)..."

PIDS=`$(pgrep -f "`$SCRIPT" 2>/dev/null || true)
WRAPPER_PIDS=`$(pgrep -f "latency_io_wrapper" 2>/dev/null || true)
ALL_PIDS="`$PIDS `$WRAPPER_PIDS"

if [ -z "`$(echo `$ALL_PIDS | tr -d ' ')" ]; then
    echo "[INFO] No running instances found"
else
    echo "[INFO] Found PIDs: `$ALL_PIDS"
    for PID in `$ALL_PIDS; do
        [ -z "`$PID" ] && continue
        PGID=`$(ps -o pgid= -p "`$PID" 2>/dev/null | tr -d ' ' || true)
        if [ -n "`$PGID" ] && [ "`$PGID" != "0" ]; then
            kill -- -"`$PGID" 2>/dev/null && echo "[INFO] Killed process group `$PGID (PID `$PID)" || true
        else
            kill "`$PID" 2>/dev/null && echo "[INFO] Killed PID `$PID" || true
        fi
    done
    sleep 2
    REMAINING=`$(pgrep -f "`$SCRIPT" 2>/dev/null || true)
    if [ -n "`$REMAINING" ]; then
        echo "[WARN] Processes still running after SIGTERM — sending SIGKILL..."
        pkill -9 -f "`$SCRIPT" 2>/dev/null || true
        pkill -9 -f "latency_io_wrapper" 2>/dev/null || true
    fi
fi

# Always clean up working directory and state files regardless of process state
if [ -d "`$WORKDIR" ]; then
    rm -rf "`$WORKDIR" && echo "[INFO] Removed working directory `$WORKDIR" || echo "[WARN] Could not remove `$WORKDIR"
else
    echo "[INFO] Working directory `$WORKDIR not present (already clean)"
fi

for f in "`$LOGFILE" "`${HOME}/.latency_io.pid" "`${HOME}/.latency_io.done" "`${HOME}/.latency_io.out" "`${HOME}/.latency_io_wrapper.sh" "`${HOME}/.latency_io_nohup.out" "`${HOME}/.latency_io_launcher.pid"; do
    [ -f "`$f" ] && rm -f "`$f" && echo "[INFO] Removed `$f" || true
done

echo "[DONE] Cleanup complete on `$(hostname)"
"@

$killCommand = $killCommand -replace "`r", ""

# ── Helper: build SSH args ────────────────────────────────────────────────────
function Get-SshArgs {
    param($username, $server, $port)
    return @(
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-p", $port,
        "${username}@${server}"
    )
}

# ── Launch parallel kill jobs ─────────────────────────────────────────────────
$launchJobs = @{}
$serverMeta = @{}
$results    = @()
$startTime  = Get-Date

Write-Host "`nStopping '$ScriptName' on $($servers.Count) server(s)..." -ForegroundColor Cyan

foreach ($row in $servers) {
    $server   = $row.Server.Trim()
    $username = $row.Username.Trim()
    $port     = if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) { $row.Port.Trim() } else { "22" }
    $srvKey   = $server

    while ((Get-Job -State Running).Count -ge $MaxParallelJobs) {
        Start-Sleep -Milliseconds 500
    }

    $sshArgs = Get-SshArgs -username $username -server $server -port $port

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Connecting to $server..." -ForegroundColor Yellow

    $job = Start-Job -ScriptBlock {
        param($sshExe, $sshArgList, $cmd, $srv)
        $output = $cmd | & $sshExe @sshArgList "bash -s" 2>&1
        return [PSCustomObject]@{
            Server   = $srv
            Output   = ($output -join "`n")
            ExitCode = $LASTEXITCODE
        }
    } -ArgumentList "ssh", $sshArgs, $killCommand, $server

    $launchJobs[$job.Name] = $srvKey
    $serverMeta[$srvKey] = [PSCustomObject]@{
        Server    = $server
        Username  = $username
        Port      = $port
        StartTime = Get-Date
    }
}

# ── Wait for all jobs to complete ─────────────────────────────────────────────
Write-Host "`nWaiting for all connections to return..." -ForegroundColor Cyan
while (Get-Job -State Running) { Start-Sleep -Seconds 1 }

foreach ($jobName in $launchJobs.Keys) {
    $srvKey = $launchJobs[$jobName]
    $job    = Get-Job -Name $jobName -ErrorAction SilentlyContinue
    if (-not $job) { continue }

    $result   = Receive-Job -Job $job
    Remove-Job -Job $job
    $meta     = $serverMeta[$srvKey]

    $status = if ($result.ExitCode -eq 0) { "OK" }     else { "FAILED" }
    $color  = if ($result.ExitCode -eq 0) { "Green" }  else { "Red" }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] $status" -ForegroundColor $color
    if ($result.Output) {
        $result.Output -split "`n" | Where-Object { $_ -match "\[INFO\]|\[DONE\]|\[WARN\]" } |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }

    $results += [PSCustomObject]@{
        Server   = $srvKey
        Username = $meta.Username
        Port     = $meta.Port
        Status   = $status
        ExitCode = $result.ExitCode
        Output   = $result.Output
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────
$elapsed      = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
$successCount = ($results | Where-Object { $_.Status -eq "OK"     }).Count
$failCount    = ($results | Where-Object { $_.Status -eq "FAILED" }).Count

Write-Host "`n===== Stop Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded : $successCount" -ForegroundColor Green
Write-Host "  Failed    : $failCount"    -ForegroundColor Red
Write-Host "  Elapsed   : ${elapsed}s"

if ($failCount -gt 0) {
    Write-Host "`n===== Failed Servers =====" -ForegroundColor Red
    $results | Where-Object { $_.Status -eq "FAILED" } | ForEach-Object {
        Write-Host "`n[$($_.Server)]" -ForegroundColor Red
        Write-Host $_.Output
    }
    exit 1
}

exit 0
