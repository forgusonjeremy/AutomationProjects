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

# Remote command sent over SSH.
# Bash variables are escaped with backtick (PowerShell's escape character) so
# PowerShell does not try to expand them — they arrive on the remote shell intact.
# $minimumRuntimeSeconds and $ScriptRemotePath are intentionally NOT escaped so
# PowerShell substitutes their values before the string is sent.
$remoteCommand = @"
chmod +x '$ScriptRemotePath';
START=`$(date +%s);
'$ScriptRemotePath' &
SCRIPT_PID=`$!;
echo '[INFO] Script started with PID '`$SCRIPT_PID;
wait `$SCRIPT_PID;
EXIT_CODE=`$?;
END=`$(date +%s);
ELAPSED=`$(( END - START ));
echo '[INFO] Script exited with code '`$EXIT_CODE' after '`${ELAPSED}'s';
if [ `$ELAPSED -lt $minimumRuntimeSeconds ]; then
    REMAINING=`$(( $minimumRuntimeSeconds - ELAPSED ));
    echo '[INFO] Runtime below minimum. Holding for '`${REMAINING}'s more...';
    sleep `$REMAINING;
fi;
TOTAL=`$(( `$(date +%s) - START ));
echo '[DONE] Total enforced runtime: '`${TOTAL}'s / exit code: '`$EXIT_CODE;
exit `$EXIT_CODE
"@

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

    # Throttle parallelism
    while ((Get-Job -State Running).Count -ge $MaxParallelJobs) {
        Start-Sleep -Seconds 2
    }

    $sshArgs = Get-SshArgs -username $username -server $server -port $port

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Launching job on $server..." -ForegroundColor Yellow

    $job = Start-Job -ScriptBlock {
        param($sshExe, $sshArgList, $remoteCmd, $srv)
        $output = & $sshExe @sshArgList $remoteCmd 2>&1
        return [PSCustomObject]@{
            Server   = $srv
            Output   = $output -join "`n"
            ExitCode = $LASTEXITCODE
        }
    } -ArgumentList "ssh", $sshArgs, $remoteCommand, $server

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
            # Still running — heartbeat every 60s
            if ($elapsed % 60 -lt 3) {
                $mins = [math]::Round($elapsed / 60, 1)
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$($meta.Server)] Still running... ${mins} min elapsed" -ForegroundColor DarkCyan
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

Write-Host "`n===== Run Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded    : $successCount" -ForegroundColor Green
Write-Host "  Failed       : $failCount"    -ForegroundColor Red
Write-Host "  Total VMs    : $($servers.Count)"
Write-Host "  Total elapsed: ${totalDuration} min"

$logPath = "snapshot_io_results_$(Get-Date -Format 'yyyyMMdd_HHmmss').csv"
$results | Select-Object Server, Username, Port, Status, ExitCode, DurationMin, StartTime, EndTime |
    Export-Csv -Path $logPath -NoTypeInformation
Write-Host "`nDetailed results saved to: $logPath`n" -ForegroundColor Cyan

$failures = $results | Where-Object { $_.Status -eq "FAILED" }
if ($failures) {
    Write-Host "===== Failed Server Output =====" -ForegroundColor Red
    foreach ($f in $failures) {
        Write-Host "`n[$($f.Server)]" -ForegroundColor Red
        Write-Host $f.ScriptOutput
    }
}

if ($failCount -gt 0) { exit 1 } else { exit 0 }