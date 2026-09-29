# Stop-SnapshotIO.ps1
# Connects to each server in the CSV and kills all running instances of
# generate_snapshot_io.sh, then removes the working directory.
#
# Usage:
#   .\Stop-SnapshotIO.ps1 -CsvPath "servers.csv"
#
# With a custom script name (if you renamed it):
#   .\Stop-SnapshotIO.ps1 -CsvPath "servers.csv" -ScriptName "my_io_script.sh"
#
# Requires: OpenSSH client in PATH, passwordless SSH configured for sshuser
#
# CSV format:
#   Server,Username,Port
#   192.168.1.10,sshuser,22

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath,

    [string]$ScriptName    = "generate_snapshot_io.sh",
    [string]$WorkingDir    = "~/snapshot_io_test",
    [string]$LogFile       = "~/snapshot_io_test.log",
    [int]$MaxParallelJobs  = 20
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
# 1. Find all PIDs matching the script name
# 2. Kill the entire process group for each (catches child workers too)
# 3. Remove the working directory and log file
# 4. Report what was done
$killCommand = @"
SCRIPT='$ScriptName'
WORKDIR='$WorkingDir'
LOGFILE='$LogFile'

PIDS=`$(pgrep -f "`$SCRIPT" 2>/dev/null || true)

if [ -z "`$PIDS" ]; then
    echo "[INFO] No running instances of `$SCRIPT found"
else
    echo "[INFO] Found PIDs: `$PIDS"
    for PID in `$PIDS; do
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
        echo "[WARN] Some processes still running after SIGTERM, sending SIGKILL..."
        pkill -9 -f "`$SCRIPT" 2>/dev/null || true
    fi
fi

if [ -d "`$WORKDIR" ]; then
    rm -rf "`$WORKDIR" && echo "[INFO] Removed working directory `$WORKDIR" || echo "[WARN] Could not remove `$WORKDIR"
else
    echo "[INFO] Working directory `$WORKDIR does not exist (already clean)"
fi

if [ -f "`$LOGFILE" ]; then
    rm -f "`$LOGFILE" && echo "[INFO] Removed log file `$LOGFILE" || true
fi

echo "[DONE] Cleanup complete on `$(hostname)"
"@

# Strip Windows CR characters
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
$jobs     = @{}
$results  = @()
$start    = Get-Date

Write-Host "`nStopping '$ScriptName' on $($servers.Count) server(s)..." -ForegroundColor Cyan

foreach ($row in $servers) {
    $server   = $row.Server.Trim()
    $username = $row.Username.Trim()
    $port     = if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) { $row.Port.Trim() } else { "22" }

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
            Output   = $output -join "`n"
            ExitCode = $LASTEXITCODE
        }
    } -ArgumentList "ssh", $sshArgs, $killCommand, $server

    $jobs[$job.Name] = [PSCustomObject]@{
        Job       = $job
        Server    = $server
        StartTime = Get-Date
    }
}

# ── Collect results ───────────────────────────────────────────────────────────
$completed = @{}

while ($jobs.Count -gt $completed.Count) {
    foreach ($jobName in $jobs.Keys) {
        if ($completed.ContainsKey($jobName)) { continue }

        $meta = $jobs[$jobName]
        $job  = $meta.Job

        if ($job.State -in @("Completed", "Failed", "Stopped")) {
            $result   = Receive-Job -Job $job
            Remove-Job -Job $job

            $status = if ($result.ExitCode -eq 0) { "OK" } else { "FAILED" }
            $color  = if ($result.ExitCode -eq 0) { "Green" } else { "Red" }

            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$($meta.Server)] $status" -ForegroundColor $color
            if ($result.Output) {
                $result.Output -split "`n" | Where-Object { $_ -match "\[INFO\]|\[DONE\]|\[WARN\]" } |
                    ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }

            $results += [PSCustomObject]@{
                Server    = $meta.Server
                Status    = $status
                ExitCode  = $result.ExitCode
                Output    = $result.Output
            }

            $completed[$jobName] = $true
        }
    }

    if ($jobs.Count -gt $completed.Count) { Start-Sleep -Milliseconds 500 }
}

# ── Summary ───────────────────────────────────────────────────────────────────
$elapsed      = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
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
