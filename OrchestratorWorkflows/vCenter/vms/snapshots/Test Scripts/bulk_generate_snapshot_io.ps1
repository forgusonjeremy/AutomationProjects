# Invoke-SnapshotIO.ps1
# Usage: .\Invoke-SnapshotIO.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/home/sshuser/generate_snapshot_io.sh"
#
# Basic — 15 min minimum (default), script at a fixed path
#   .\Invoke-SnapshotIO.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/home/sshuser/generate_snapshot_io.sh"
#
# Custom minimum runtime (e.g. 30 minutes)
#   .\Invoke-SnapshotIO.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/home/sshuser/generate_snapshot_io.sh" -MinimumRuntimeMinutes 30
#
# With higher parallelism
#   .\Invoke-SnapshotIO.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/home/sshuser/generate_snapshot_io.sh" -MaxParallelJobs 20
#
# With a custom job timeout (default is 45 min — set higher than MinimumRuntimeMinutes)
#   .\Invoke-SnapshotIO.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_snapshot_io.sh" -JobTimeoutMinutes 60
#
# Requires: OpenSSH client installed and in PATH, passwordless SSH configured for sshuser on all target servers
#
# CSV format:
#   Server,Username,RemotePath,Port
#   192.168.1.10,sshuser,/home/sshuser/,22

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath,                  # Path to CSV file with server list

    [Parameter(Mandatory=$true)]
    [string]$ScriptRemotePath,         # Full remote path to the snapshot IO script

    [int]$MinimumRuntimeMinutes = 15,  # Minimum runtime in minutes (default 15)

    [int]$MaxParallelJobs = 10,        # Max concurrent SSH sessions

    [int]$JobTimeoutMinutes = 45,      # Kill any job still running beyond this (default 45 min)

    [switch]$StopOnError               # Stop launching new jobs if one fails
)

# --- Validate inputs ---
if (-not (Test-Path $CsvPath)) {
    Write-Error "CSV file not found: $CsvPath"
    exit 1
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Error "ssh not found. Install OpenSSH or add it to PATH."
    exit 1
}

# --- Load and validate CSV ---
$servers = Import-Csv -Path $CsvPath

if ($servers.Count -eq 0) {
    Write-Error "CSV file is empty or has no valid rows."
    exit 1
}

$requiredCols = @("Server", "Username")
$csvCols = $servers[0].PSObject.Properties.Name
foreach ($col in $requiredCols) {
    if ($col -notin $csvCols) {
        Write-Error "CSV is missing required column: '$col'. Required: $($requiredCols -join ', ')"
        exit 1
    }
}

# --- Helper: Build SSH args ---
function Get-SshArgs {
    param($username, $server, $port)

    $args = @(
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-p", $port
    )
    $args += "${username}@${server}"
    return $args
}

# --- Minimum runtime enforcement ---
$minimumRuntimeSeconds = $MinimumRuntimeMinutes * 60

# Remote command strategy:
#   Rather than piping a script to bash -s (which dies when SSH stdin closes),
#   we write a wrapper script to the remote host and launch it under nohup so
#   it survives SSH session termination. A PID file lets us poll for completion
#   without keeping the SSH connection open.
#
# Bash variables use backtick escaping so PowerShell does not expand them.
# $minimumRuntimeSeconds and $ScriptRemotePath are intentionally left unescaped
# so PowerShell substitutes their values before the string is sent.
$wrapperScript = @"
#!/bin/bash
PIDFILE=`${HOME}/.snapshot_io.pid
DONEFILE=`${HOME}/.snapshot_io.done
OUTFILE=`${HOME}/.snapshot_io.out

rm -f "`$DONEFILE"
chmod +x '$ScriptRemotePath'

START=`$(date +%s)
'$ScriptRemotePath' > "`$OUTFILE" 2>&1 &
SCRIPT_PID=`$!
echo `$SCRIPT_PID > "`$PIDFILE"
echo "[INFO] Script started with PID `$SCRIPT_PID"

wait `$SCRIPT_PID
EXIT_CODE=`$?
END=`$(date +%s)
ELAPSED=`$(( END - START ))
echo "[INFO] Script exited with code `$EXIT_CODE after `${ELAPSED}s"

if [ `$ELAPSED -lt $minimumRuntimeSeconds ]; then
    REMAINING=`$(( $minimumRuntimeSeconds - ELAPSED ))
    echo "[INFO] Runtime below minimum. Holding for `${REMAINING}s more..."
    sleep `$REMAINING
fi

TOTAL=`$(( `$(date +%s) - START ))
echo "[DONE] Total enforced runtime: `${TOTAL}s / exit code: `$EXIT_CODE"
rm -f "`$PIDFILE"
echo `$EXIT_CODE > "`$DONEFILE"
"@

$wrapperScript = $wrapperScript -replace "`r", ""

# Launch command: write the wrapper to the remote host and run it detached
# under nohup so it is fully independent of the SSH session lifetime.
$remoteCommand = @"
cat > `${HOME}/.snapshot_io_wrapper.sh << 'WRAPPER'
$($wrapperScript)
WRAPPER
chmod +x `${HOME}/.snapshot_io_wrapper.sh
rm -f `${HOME}/.snapshot_io.done
nohup `${HOME}/.snapshot_io_wrapper.sh > `${HOME}/.snapshot_io_nohup.out 2>&1 &
echo `$! > `${HOME}/.snapshot_io_launcher.pid
echo "[LAUNCHED] nohup PID `$!"
"@

$remoteCommand = $remoteCommand -replace "`r", ""

# --- Launch jobs in parallel ---
$jobs      = @{}
$results   = @()
$startTime = Get-Date

Write-Host "`nLaunching snapshot IO script on $($servers.Count) server(s)" -ForegroundColor Cyan
Write-Host "Minimum runtime enforced: ${MinimumRuntimeMinutes} minutes ($minimumRuntimeSeconds seconds)" -ForegroundColor Cyan
Write-Host "Max parallel jobs: $MaxParallelJobs`n" -ForegroundColor Cyan

foreach ($row in $servers) {
    $server   = $row.Server.Trim()
    $username = $row.Username.Trim()
    $port     = if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) { $row.Port.Trim() } else { "22" }

    # Throttle parallelism — also reap any jobs that have exceeded the timeout
    # so a hung connection can never permanently block the launch queue.
    while ((Get-Job -State Running).Count -ge $MaxParallelJobs) {
        Get-Job -State Running | ForEach-Object {
            $runningMeta = $jobs[$_.Name]
            if ($runningMeta) {
                $runningElapsed = ((Get-Date) - $runningMeta.StartTime).TotalMinutes
                if ($runningElapsed -gt $JobTimeoutMinutes) {
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$($runningMeta.Server)] TIMEOUT in throttle loop — stopping job after $([math]::Round($runningElapsed,1)) min" -ForegroundColor Magenta
                    Stop-Job -Job $_
                }
            }
        }
        Start-Sleep -Seconds 2
    }

    $sshArgs = Get-SshArgs -username $username -server $server -port $port

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Launching job on $server..." -ForegroundColor Yellow

    $job = Start-Job -ScriptBlock {
        param($sshExe, $sshArgList, $launchCmd, $srv, $pollIntervalSec, $timeoutSec)

        # Step 1: Send the launch command — writes the wrapper script and starts
        # it under nohup. SSH returns immediately after launch; the IO script
        # keeps running on the remote host independently of this connection.
        $launchOutput = $launchCmd | & $sshExe @sshArgList "bash -s" 2>&1
        if ($LASTEXITCODE -ne 0) {
            return [PSCustomObject]@{
                Server   = $srv
                Output   = ($launchOutput -join "`n")
                ExitCode = $LASTEXITCODE
            }
        }

        Write-Output ($launchOutput -join "`n")

        # Step 2: Poll the remote host for the done file every $pollIntervalSec
        # seconds. The wrapper script writes the IO script's exit code to
        # ~/.snapshot_io.done when it finishes (including any minimum runtime hold).
        $pollCmd = "cat `${HOME}/.snapshot_io.done 2>/dev/null || echo RUNNING"
        $waited  = 0
        $exitCode = -1
        $doneOutput = ""

        while ($waited -lt $timeoutSec) {
            Start-Sleep -Seconds $pollIntervalSec
            $waited += $pollIntervalSec

            $pollResult = & $sshExe @sshArgList $pollCmd 2>&1
            $pollText   = ($pollResult -join "").Trim()

            if ($pollText -ne "RUNNING" -and $pollText -ne "") {
                # Done file exists — contains the exit code
                try { $exitCode = [int]$pollText } catch { $exitCode = 1 }
                $doneOutput = "[INFO] Remote script completed with exit code $exitCode after ${waited}s"
                Write-Output $doneOutput
                break
            }

            $mins = [math]::Round($waited / 60, 1)
            Write-Output "[INFO] Still running on $srv — ${mins} min elapsed"
        }

        if ($exitCode -eq -1) {
            Write-Output "[WARN] Timed out waiting for done file on $srv after ${waited}s"
        }

        # Retrieve any output the wrapper captured
        $remoteLog = & $sshExe @sshArgList "cat `${HOME}/.snapshot_io.out 2>/dev/null | tail -20" 2>&1

        return [PSCustomObject]@{
            Server   = $srv
            Output   = (($launchOutput + $remoteLog) -join "`n")
            ExitCode = $exitCode
        }
    } -ArgumentList "ssh", $sshArgs, $remoteCommand, $server, 30, ($JobTimeoutMinutes * 60)

    $jobs[$job.Name] = [PSCustomObject]@{
        Job       = $job
        Server    = $server
        Username  = $username
        Port      = $port
        StartTime = Get-Date
    }
}

Write-Host "`nAll jobs launched. Waiting for completion (minimum ${MinimumRuntimeMinutes} min per server)...`n" -ForegroundColor Cyan

# --- Progress monitoring loop ---
$completedServers = @{}

while ($jobs.Count -gt $completedServers.Count) {
    foreach ($jobName in $jobs.Keys) {
        if ($completedServers.ContainsKey($jobName)) { continue }

        $meta    = $jobs[$jobName]
        $job     = $meta.Job
        $elapsed = [int]((Get-Date) - $meta.StartTime).TotalSeconds

        if ($job.State -in @("Completed", "Failed", "Stopped")) {
            $result = Receive-Job -Job $job
            Remove-Job -Job $job

            $status   = if ($result.ExitCode -eq 0) { "SUCCESS" } else { "FAILED" }
            $color    = if ($result.ExitCode -eq 0) { "Green" }   else { "Red" }
            $duration = [math]::Round(((Get-Date) - $meta.StartTime).TotalMinutes, 1)

            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$($meta.Server)] $status — ${duration} min" -ForegroundColor $color
            if ($result.Output) {
                $result.Output -split "`n" | Where-Object { $_ -match "\[INFO\]|\[DONE\]|\[ERROR\]" } |
                    ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }

            $results += [PSCustomObject]@{
                Server       = $meta.Server
                Username     = $meta.Username
                Port         = $meta.Port
                Status       = $status
                ExitCode     = $result.ExitCode
                DurationMin  = $duration
                ScriptOutput = $result.Output
                StartTime    = $meta.StartTime.ToString("yyyy-MM-dd HH:mm:ss")
                EndTime      = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
            }

            $completedServers[$jobName] = $true

            if ($StopOnError -and $result.ExitCode -ne 0) {
                Write-Warning "-StopOnError set. No new jobs will be launched (existing ones continue)."
            }
        }
        else {
            $elapsedMins = [math]::Round($elapsed / 60, 1)

            # Kill jobs that have exceeded the timeout
            if ($elapsed -gt ($JobTimeoutMinutes * 60)) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$($meta.Server)] TIMEOUT — exceeded ${JobTimeoutMinutes} min limit. Stopping job." -ForegroundColor Magenta
                Stop-Job -Job $job
                $result = Receive-Job -Job $job
                Remove-Job -Job $job

                $results += [PSCustomObject]@{
                    Server       = $meta.Server
                    Username     = $meta.Username
                    Port         = $meta.Port
                    Status       = "TIMEOUT"
                    ExitCode     = -1
                    DurationMin  = $elapsedMins
                    ScriptOutput = if ($result) { ($result.Output) } else { "(no output captured)" }
                    StartTime    = $meta.StartTime.ToString("yyyy-MM-dd HH:mm:ss")
                    EndTime      = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                }
                $completedServers[$jobName] = $true
            }
            # Heartbeat every 60s for jobs still within timeout
            elseif ($elapsed % 60 -lt 3) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$($meta.Server)] Still running... ${elapsedMins} min elapsed (timeout at ${JobTimeoutMinutes} min)" -ForegroundColor DarkCyan
            }
        }
    }

    if ($jobs.Count -gt $completedServers.Count) {
        Start-Sleep -Seconds 3
    }
}

# --- Final summary ---
$totalDuration = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
$successCount  = ($results | Where-Object { $_.Status -eq "SUCCESS" }).Count
$failCount     = ($results | Where-Object { $_.Status -eq "FAILED"  }).Count
$timeoutCount  = ($results | Where-Object { $_.Status -eq "TIMEOUT" }).Count

Write-Host "`n===== Run Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded    : $successCount" -ForegroundColor Green
Write-Host "  Failed       : $failCount"    -ForegroundColor Red
Write-Host "  Timed out    : $timeoutCount"  -ForegroundColor Magenta
Write-Host "  Total VMs    : $($servers.Count)"
Write-Host "  Total elapsed: ${totalDuration} min"

$logPath = "snapshot_io_results_$(Get-Date -Format 'yyyyMMdd_HHmmss').csv"
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
