# bulk_generate_DatastoreLatency.ps1
# Connects to each server in the CSV and launches generate_datastore_latency.sh
# under nohup so it survives the SSH session. Polls for completion from the
# main thread — no per-job sleep loops so it scales to any number of VMs.
#
# Usage:
#   .\bulk_generate_DatastoreLatency.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_datastore_latency.sh"
#
# Custom duration and workers:
#   .\bulk_generate_DatastoreLatency.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_datastore_latency.sh" `
#       -DurationSeconds 1200 -Workers 16
#
# With aggressive mode and higher I/O depth:
#   .\bulk_generate_DatastoreLatency.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_datastore_latency.sh" `
#       -DurationSeconds 600 -Workers 16 -IoDepth 64 -Aggressive
#
# Full example:
#   .\bulk_generate_DatastoreLatency.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_datastore_latency.sh" `
#       -DurationSeconds 600 -Workers 16 -IoDepth 64 -Aggressive `
#       -MaxParallelJobs 25 -JobTimeoutMinutes 30
#
# Requires: OpenSSH client in PATH, passwordless SSH configured for sshuser
#
# CSV format:
#   Server,Username,Port
#   192.168.1.10,sshuser,22

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath,                   # Path to CSV file with server list

    [Parameter(Mandatory=$true)]
    [string]$ScriptRemotePath,          # Full remote path to generate_datastore_latency.sh

    [int]$DurationSeconds  = 600,       # How long to run the latency script (--duration)
    [int]$Workers          = 8,         # Parallel I/O workers on each VM (--workers)
    [int]$IoDepth          = 32,        # fio queue depth per worker (--iodepth)
    [string]$Mode          = "auto",    # fio | dd | auto (--mode)
    [switch]$Aggressive,                # Enable fsync-loop writers (--aggressive)

    [int]$MaxParallelJobs  = 20,        # Max concurrent SSH launch jobs
    [int]$JobTimeoutMinutes = 30,       # Kill any server still running beyond this
    [int]$MaxRetries        = 3         # Retry failed launches before giving up
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

$requiredCols = @("Server", "Username")
$csvCols = $servers[0].PSObject.Properties.Name
foreach ($col in $requiredCols) {
    if ($col -notin $csvCols) {
        Write-Error "CSV missing required column: '$col'"
        exit 1
    }
}

# ── Build script argument string ──────────────────────────────────────────────
$scriptArgs  = "--duration $DurationSeconds --workers $Workers --iodepth $IoDepth --mode $Mode"
if ($Aggressive) { $scriptArgs += " --aggressive" }


# ── Resilience: SSH retry helper ─────────────────────────────────────────────
# Retries any SSH command up to $MaxRetries times with exponential backoff.
# Handles transient failures from network latency, packet drops, and
# temporary disconnects without failing the entire run.
function Invoke-SshWithRetry {
    param(
        [string[]]$SshArgs,
        [string]$Command,
        [int]$MaxRetries   = 3,
        [int]$RetryDelayMs = 5000,   # Initial delay — doubles on each retry
        [string]$InputData = $null   # Optional stdin to pipe
    )

    $attempt  = 0
    $lastExit = -1
    $output   = ""

    while ($attempt -lt $MaxRetries) {
        $attempt++
        try {
            if ($InputData) {
                $output   = $InputData | & ssh @SshArgs $Command 2>&1
            } else {
                $output   = & ssh @SshArgs $Command 2>&1
            }
            $lastExit = $LASTEXITCODE
            if ($lastExit -eq 0) { break }
        } catch {
            $lastExit = -1
            $output   = $_.Exception.Message
        }

        if ($attempt -lt $MaxRetries) {
            $delay = $RetryDelayMs * [math]::Pow(2, $attempt - 1)
            Write-Host "    [RETRY] Attempt $attempt failed (exit $lastExit) — retrying in $([math]::Round($delay/1000,1))s..." -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds $delay
        }
    }

    return [PSCustomObject]@{
        Output   = ($output -join "`n")
        ExitCode = $lastExit
        Attempts = $attempt
    }
}

# ── Helper: Build SSH args ────────────────────────────────────────────────────
function Get-SshArgs {
    param($username, $server, $port)
    return @(
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=30",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=4",
        "-p", $port,
        "${username}@${server}"
    )
}

# ── Wrapper script written to the remote host ─────────────────────────────────
# Runs the latency script under nohup and writes a done file on completion
# so the main thread can poll for it without keeping SSH open.
$wrapperScript = @"
#!/bin/bash
PIDFILE=`${HOME}/.latency_io.pid
DONEFILE=`${HOME}/.latency_io.done
OUTFILE=`${HOME}/.latency_io.out

rm -f "`$DONEFILE"
chmod +x '$ScriptRemotePath'

START=`$(date +%s)
'$ScriptRemotePath' $scriptArgs > "`$OUTFILE" 2>&1 &
SCRIPT_PID=`$!
echo `$SCRIPT_PID > "`$PIDFILE"
echo "[INFO] Script started with PID `$SCRIPT_PID"

wait `$SCRIPT_PID
EXIT_CODE=`$?
END=`$(date +%s)
ELAPSED=`$(( END - START ))
echo "[INFO] Script exited with code `$EXIT_CODE after `${ELAPSED}s"

rm -f "`$PIDFILE"
echo `$EXIT_CODE > "`$DONEFILE"
echo "[DONE] Latency script complete on `$(hostname)"
"@

$wrapperScript = $wrapperScript -replace "`r", ""

$remoteCommand = @"
cat > `${HOME}/.latency_io_wrapper.sh << 'WRAPPER'
$($wrapperScript)
WRAPPER
chmod +x `${HOME}/.latency_io_wrapper.sh
rm -f `${HOME}/.latency_io.done
nohup `${HOME}/.latency_io_wrapper.sh > `${HOME}/.latency_io_nohup.out 2>&1 &
echo `$! > `${HOME}/.latency_io_launcher.pid
echo "[LAUNCHED] nohup PID `$!"
"@

$remoteCommand = $remoteCommand -replace "`r", ""

# ── Phase 1: Launch all servers via short-lived parallel SSH jobs ─────────────
# Jobs only do the nohup launch and return immediately — no polling inside jobs.

$serverMeta = @{}
$launchJobs = @{}
$results    = @()
$startTime  = Get-Date

Write-Host "`nLaunching datastore latency script on $($servers.Count) server(s)" -ForegroundColor Cyan
Write-Host "Duration   : ${DurationSeconds}s" -ForegroundColor Cyan
Write-Host "Workers    : $Workers per VM" -ForegroundColor Cyan
Write-Host "I/O depth  : $IoDepth (fio)" -ForegroundColor Cyan
Write-Host "Mode       : $Mode" -ForegroundColor Cyan
Write-Host "Aggressive : $($Aggressive.IsPresent)" -ForegroundColor Cyan
Write-Host "Max jobs   : $MaxParallelJobs`n" -ForegroundColor Cyan

foreach ($row in $servers) {
    $server   = $row.Server.Trim()
    $username = $row.Username.Trim()
    $port     = if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) { $row.Port.Trim() } else { "22" }
    $srvKey   = $server

    while ((Get-Job -State Running).Count -ge $MaxParallelJobs) {
        Start-Sleep -Seconds 1
    }

    $sshArgs = Get-SshArgs -username $username -server $server -port $port

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Launching on $server..." -ForegroundColor Yellow

    $job = Start-Job -ScriptBlock {
        param($sshExe, $sshArgList, $launchCmd, $srv, $maxRetries)
        $attempt  = 0
        $lastExit = -1
        $output   = ""
        while ($attempt -lt $maxRetries) {
            $attempt++
            $output   = $launchCmd | & $sshExe @sshArgList "bash -s" 2>&1
            $lastExit = $LASTEXITCODE
            if ($lastExit -eq 0) { break }
            if ($attempt -lt $maxRetries) {
                $delay = 5000 * [math]::Pow(2, $attempt - 1)
                Start-Sleep -Milliseconds $delay
            }
        }
        return [PSCustomObject]@{
            Server   = $srv
            Output   = ($output -join "`n")
            ExitCode = $lastExit
            Attempts = $attempt
        }
    } -ArgumentList "ssh", $sshArgs, $remoteCommand, $server, $MaxRetries

    $launchJobs[$job.Name] = $srvKey
    $serverMeta[$srvKey] = [PSCustomObject]@{
        Server    = $server
        Username  = $username
        Port      = $port
        SshArgs   = $sshArgs
        StartTime = Get-Date
        Launched  = $false
        Done      = $false
        ExitCode  = -1
        Output    = ""
    }
}

# Wait for all launch jobs to finish
Write-Host "`nWaiting for all launch SSH connections to return..." -ForegroundColor Cyan
while (Get-Job -State Running) { Start-Sleep -Seconds 1 }

foreach ($jobName in $launchJobs.Keys) {
    $srvKey = $launchJobs[$jobName]
    $job    = Get-Job -Name $jobName -ErrorAction SilentlyContinue
    if (-not $job) { continue }

    $result = Receive-Job -Job $job
    Remove-Job -Job $job

    $meta = $serverMeta[$srvKey]
    $meta.Output   = $result.Output
    $meta.Launched = ($result.ExitCode -eq 0)

    if ($result.ExitCode -eq 0) {
        $attemptStr = if ($result.Attempts -gt 1) { " (after $($result.Attempts) attempts)" } else { "" }
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] Launched OK${attemptStr}" -ForegroundColor Green
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] Launch FAILED after $($result.Attempts) attempt(s) (exit $($result.ExitCode))" -ForegroundColor Red
        $meta.Done     = $true
        $meta.ExitCode = $result.ExitCode
    }
}

# ── Phase 2: Poll all servers from the main thread ────────────────────────────

$pollInterval = 30
$timeoutSec   = $JobTimeoutMinutes * 60
$pendingCount = ($serverMeta.Values | Where-Object { -not $_.Done }).Count

Write-Host "`nAll launches complete. Polling $pendingCount server(s) every ${pollInterval}s...`n" -ForegroundColor Cyan

while ($pendingCount -gt 0) {
    Start-Sleep -Seconds $pollInterval

    foreach ($srvKey in $serverMeta.Keys) {
        $meta = $serverMeta[$srvKey]
        if ($meta.Done -or -not $meta.Launched) { continue }

        $elapsed     = [int]((Get-Date) - $meta.StartTime).TotalSeconds
        $elapsedMins = [math]::Round($elapsed / 60, 1)

        # Timeout check
        if ($elapsed -gt $timeoutSec) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] TIMEOUT after ${elapsedMins} min — killing remote process" -ForegroundColor Magenta
            & ssh @($meta.SshArgs) "pkill -f latency_io_wrapper; pkill -f generate_datastore_latency" 2>&1 | Out-Null
            $meta.Done     = $true
            $meta.ExitCode = -1
            $meta.Output  += "`n[TIMEOUT] Exceeded ${JobTimeoutMinutes} min limit"
            $pendingCount--
            continue
        }

        # Poll for done file — retry on transient network failures
        $pollResult = Invoke-SshWithRetry -SshArgs $meta.SshArgs `
            -Command 'bash -c "cat ~/.latency_io.done 2>/dev/null || echo RUNNING"' `
            -MaxRetries 3 -RetryDelayMs 3000
        $pollText = $pollResult.Output.Trim()

        # If SSH itself failed treat as still running — don't mark done on a network glitch
        if ($pollResult.ExitCode -ne 0 -and $pollText -eq "") {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] Poll SSH failed — will retry next cycle" -ForegroundColor DarkYellow
            continue
        }

        if ($pollText -ne "RUNNING" -and $pollText -ne "") {
            try { $meta.ExitCode = [int]$pollText } catch { $meta.ExitCode = 1 }
            $logResult = Invoke-SshWithRetry -SshArgs $meta.SshArgs `
                -Command 'bash -c "cat ~/.latency_io.out 2>/dev/null | tail -20"' `
                -MaxRetries 3 -RetryDelayMs 3000
            $remoteLog = $logResult.Output
            $meta.Output  += "`n" + $remoteLog
            $meta.Done     = $true
            $pendingCount--

            $status = if ($meta.ExitCode -eq 0) { "SUCCESS" } else { "FAILED" }
            $color  = if ($meta.ExitCode -eq 0) { "Green" }   else { "Red" }
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] $status after ${elapsedMins} min" -ForegroundColor $color
        } else {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] Still running — ${elapsedMins} min elapsed" -ForegroundColor DarkCyan
        }
    }

    $pendingCount = ($serverMeta.Values | Where-Object { -not $_.Done }).Count
}

# ── Collect results ───────────────────────────────────────────────────────────
foreach ($srvKey in $serverMeta.Keys) {
    $meta   = $serverMeta[$srvKey]
    $status = switch ($meta.ExitCode) {
        0       { "SUCCESS" }
        -1      { "TIMEOUT" }
        default { "FAILED"  }
    }
    $duration = [math]::Round(((Get-Date) - $meta.StartTime).TotalMinutes, 1)

    $results += [PSCustomObject]@{
        Server       = $meta.Server
        Username     = $meta.Username
        Port         = $meta.Port
        Status       = $status
        ExitCode     = $meta.ExitCode
        DurationMin  = $duration
        ScriptOutput = $meta.Output
        StartTime    = $meta.StartTime.ToString("yyyy-MM-dd HH:mm:ss")
        EndTime      = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────
$totalDuration = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
$successCount  = ($results | Where-Object { $_.Status -eq "SUCCESS" }).Count
$failCount     = ($results | Where-Object { $_.Status -eq "FAILED"  }).Count
$timeoutCount  = ($results | Where-Object { $_.Status -eq "TIMEOUT" }).Count

Write-Host "`n===== Run Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded : $successCount" -ForegroundColor Green
Write-Host "  Failed    : $failCount"    -ForegroundColor Red
Write-Host "  Timed out : $timeoutCount" -ForegroundColor Magenta
Write-Host "  Total VMs : $($servers.Count)"
Write-Host "  Elapsed   : ${totalDuration} min"

$logPath = "latency_results_$(Get-Date -Format 'yyyyMMdd_HHmmss').csv"
$results | Select-Object Server, Username, Port, Status, ExitCode, DurationMin, StartTime, EndTime |
    Export-Csv -Path $logPath -NoTypeInformation
Write-Host "`nDetailed results saved to: $logPath`n" -ForegroundColor Cyan

$failures = $results | Where-Object { $_.Status -in @("FAILED", "TIMEOUT") }
if ($failures) {
    Write-Host "===== Failed Server Output =====" -ForegroundColor Red
    foreach ($f in $failures) {
        Write-Host "`n[$($f.Server)]" -ForegroundColor Red
        Write-Host $f.ScriptOutput
    }
}

if (($failCount + $timeoutCount) -gt 0) { exit 1 } else { exit 0 }
