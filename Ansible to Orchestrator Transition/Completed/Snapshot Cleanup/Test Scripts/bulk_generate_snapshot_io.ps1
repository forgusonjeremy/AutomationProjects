# bulk_generate_snapshot_io.ps1
# Connects to each server in the CSV and launches generate_snapshot_io.sh
# under nohup so it survives the SSH session. Polls for completion from the
# main thread - no per-job sleep loops so it scales to any number of VMs.
#
# Usage:
#   .\bulk_generate_snapshot_io.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_snapshot_io.sh"
#
# Custom delta size (1GB per snapshot interval) and script runtime (30 min):
#   .\bulk_generate_snapshot_io.ps1 -CsvPath "servers.csv" -ScriptRemotePath "/tmp/generate_snapshot_io.sh" `
#       -TargetDeltaGB 1 -ScriptDurationMinutes 30
#
# Requires: OpenSSH client in PATH, passwordless SSH configured for sshuser
#
# CSV format:
#   Server,Username,Port
#   192.168.1.10,sshuser,22

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath,

    [Parameter(Mandatory=$true)]
    [string]$ScriptRemotePath,

    [int]$TargetDeltaGB        = 2,
    [int]$ScriptDurationMinutes = 30,
    [int]$MinimumRuntimeMinutes = 15,
    [int]$MaxParallelJobs       = 20,
    [int]$JobTimeoutMinutes     = 45,
    [int]$MaxRetries            = 3,
    [switch]$StopOnError
)

# --- Validate ---
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

# --- Derived values ---
$minimumRuntimeSeconds = $MinimumRuntimeMinutes * 60
$scriptDurationSeconds = $ScriptDurationMinutes * 60
$scriptArgs            = "--target-gb $TargetDeltaGB --duration $scriptDurationSeconds"

Write-Host "Script arguments  : $scriptArgs" -ForegroundColor Cyan

# --- SSH retry helper ---
function Invoke-SshWithRetry {
    param(
        [string[]]$ConnArgs,
        [string]$Command,
        [int]$MaxRetries   = 3,
        [int]$RetryDelayMs = 5000,
        [string]$InputData = $null
    )

    $attempt  = 0
    $lastExit = -1
    $output   = ""

    while ($attempt -lt $MaxRetries) {
        $attempt++
        try {
            if ($null -ne $InputData) {
                $output = $InputData | & ssh @ConnArgs $Command 2>&1
            } else {
                $output = & ssh @ConnArgs $Command 2>&1
            }
            $lastExit = $LASTEXITCODE
            if ($lastExit -eq 0) { break }
        } catch {
            $lastExit = -1
            $output   = $_.Exception.Message
        }

        if ($attempt -lt $MaxRetries) {
            $delay = [int]($RetryDelayMs * [math]::Pow(2, $attempt - 1))
            Write-Host "    [RETRY] Attempt $attempt failed (exit $lastExit) - retrying in $([math]::Round($delay/1000,1))s..." -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds $delay
        }
    }

    return [PSCustomObject]@{
        Output   = ($output -join "`n")
        ExitCode = $lastExit
        Attempts = $attempt
    }
}

# --- Build SSH connection args ---
function Get-ConnArgs {
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

# --- Build remote wrapper and launch command ---
# The wrapper script is built as a PowerShell string with PowerShell variables
# ($ScriptRemotePath, $scriptArgs, $minimumRuntimeSeconds) expanded now,
# and bash variables escaped with backtick so they arrive intact on the remote.
# The whole thing is then delivered via piped bash -s to avoid here-string
# parsing issues when the content contains bash syntax (if/then, >, &, etc).

function Build-WrapperScript {
    param(
        [string]$RemotePath,
        [string]$ScriptArguments,
        [int]$MinRuntimeSec
    )

    # Each line is a plain string - no here-string so PowerShell cannot
    # misinterpret bash syntax characters like >, &, [, then, fi
    $lines = @(
        "#!/bin/bash",
        "PIDFILE=`${HOME}/.snapshot_io.pid",
        "DONEFILE=`${HOME}/.snapshot_io.done",
        "OUTFILE=`${HOME}/.snapshot_io.out",
        "rm -f `"`$DONEFILE`"",
        "chmod +x '$RemotePath'",
        "START=`$(date +%s)",
        "'$RemotePath' $ScriptArguments > `"`$OUTFILE`" 2>&1 &",
        "SCRIPT_PID=`$!",
        "echo `$SCRIPT_PID > `"`$PIDFILE`"",
        "echo `"[INFO] Script started with PID `$SCRIPT_PID`"",
        "wait `$SCRIPT_PID",
        "EXIT_CODE=`$?",
        "END=`$(date +%s)",
        "ELAPSED=`$(( END - START ))",
        "echo `"[INFO] Script exited with code `$EXIT_CODE after `${ELAPSED}s`"",
        "if [ `$ELAPSED -lt $MinRuntimeSec ]; then",
        "    REMAINING=`$(( $MinRuntimeSec - ELAPSED ))",
        "    echo `"[INFO] Runtime below minimum. Holding for `${REMAINING}s more...`"",
        "    sleep `$REMAINING",
        "fi",
        "TOTAL=`$(( `$(date +%s) - START ))",
        "echo `"[DONE] Total enforced runtime: `${TOTAL}s / exit code: `$EXIT_CODE`"",
        "rm -f `"`$PIDFILE`"",
        "echo `$EXIT_CODE > `"`$DONEFILE`""
    )
    return ($lines -join "`n") -replace "`r", ""
}

function Build-LaunchCommand {
    param([string]$WrapperContent)

    # Encode the wrapper as base64 so it can be passed cleanly over SSH
    # without any shell interpretation of its contents on the way through
    $bytes      = [System.Text.Encoding]::UTF8.GetBytes($WrapperContent)
    $b64        = [Convert]::ToBase64String($bytes)

    # Remote command: decode base64 back to a file, then nohup it.
    # Lines joined with newline not semicolon - nohup ... & cannot be
    # followed by ; as & already terminates the statement in bash.
    $lines = @(
        "echo '$b64' | base64 -d > `${HOME}/.snapshot_io_wrapper.sh",
        "chmod +x `${HOME}/.snapshot_io_wrapper.sh",
        "rm -f `${HOME}/.snapshot_io.done",
        "nohup `${HOME}/.snapshot_io_wrapper.sh > `${HOME}/.snapshot_io_nohup.out 2>&1 &",
        "LAUNCHER_PID=`$!",
        "echo `$LAUNCHER_PID > `${HOME}/.snapshot_io_launcher.pid",
        "echo `"[LAUNCHED] nohup PID `$LAUNCHER_PID`""
    )
    return ($lines -join "`n")
}

$wrapperContent = Build-WrapperScript `
    -RemotePath       $ScriptRemotePath `
    -ScriptArguments  $scriptArgs `
    -MinRuntimeSec    $minimumRuntimeSeconds

$launchCommand = Build-LaunchCommand -WrapperContent $wrapperContent

# --- Phase 1: Launch all servers via short-lived parallel SSH jobs ---
$serverMeta = @{}
$launchJobs = @{}
$results    = @()
$startTime  = Get-Date

Write-Host "`nLaunching snapshot IO script on $($servers.Count) server(s)" -ForegroundColor Cyan
Write-Host "Target delta size : ${TargetDeltaGB}GB per snapshot interval" -ForegroundColor Cyan
Write-Host "Script duration   : ${ScriptDurationMinutes} minutes" -ForegroundColor Cyan
Write-Host "Minimum runtime   : ${MinimumRuntimeMinutes} minutes" -ForegroundColor Cyan
Write-Host "Max parallel jobs : $MaxParallelJobs`n" -ForegroundColor Cyan

foreach ($row in $servers) {
    $server   = $row.Server.Trim()
    $username = $row.Username.Trim()
    $port     = if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) { $row.Port.Trim() } else { "22" }
    $srvKey   = $server

    while ((Get-Job -State Running).Count -ge $MaxParallelJobs) {
        Start-Sleep -Seconds 1
    }

    $connArgs = Get-ConnArgs -username $username -server $server -port $port

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Launching on $server..." -ForegroundColor Yellow

    $job = Start-Job -ScriptBlock {
        param($connArgList, $cmd, $srv, $maxRetries)
        $attempt  = 0
        $lastExit = -1
        $output   = ""
        while ($attempt -lt $maxRetries) {
            $attempt++
            $output   = & ssh @connArgList $cmd 2>&1
            $lastExit = $LASTEXITCODE
            if ($lastExit -eq 0) { break }
            if ($attempt -lt $maxRetries) {
                $delay = [int](5000 * [math]::Pow(2, $attempt - 1))
                Start-Sleep -Milliseconds $delay
            }
        }
        return [PSCustomObject]@{
            Server   = $srv
            Output   = ($output -join "`n")
            ExitCode = $lastExit
            Attempts = $attempt
        }
    } -ArgumentList $connArgs, $launchCommand, $server, $MaxRetries

    $launchJobs[$job.Name] = $srvKey
    $serverMeta[$srvKey] = [PSCustomObject]@{
        Server    = $server
        Username  = $username
        Port      = $port
        ConnArgs  = $connArgs
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

# --- Phase 2: Poll all servers from the main thread ---
$pollInterval = 30
$timeoutSec   = $JobTimeoutMinutes * 60
$pendingCount = ($serverMeta.Values | Where-Object { -not $_.Done }).Count

Write-Host "`nAll launches complete. Polling $pendingCount server(s) every ${pollInterval}s for completion...`n" -ForegroundColor Cyan

while ($pendingCount -gt 0) {
    Start-Sleep -Seconds $pollInterval

    foreach ($srvKey in $serverMeta.Keys) {
        $meta = $serverMeta[$srvKey]
        if ($meta.Done -or -not $meta.Launched) { continue }

        $elapsed     = [int]((Get-Date) - $meta.StartTime).TotalSeconds
        $elapsedMins = [math]::Round($elapsed / 60, 1)

        if ($elapsed -gt $timeoutSec) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] TIMEOUT after ${elapsedMins} min - killing remote wrapper" -ForegroundColor Magenta
            & ssh @($meta.ConnArgs) "pkill -f snapshot_io_wrapper; pkill -f generate_snapshot_io" 2>&1 | Out-Null
            $meta.Done     = $true
            $meta.ExitCode = -1
            $meta.Output  += "`n[TIMEOUT] Exceeded ${JobTimeoutMinutes} min limit"
            $pendingCount--
            continue
        }

        $pollResult = Invoke-SshWithRetry `
            -ConnArgs     $meta.ConnArgs `
            -Command      'bash -c "cat ~/.snapshot_io.done 2>/dev/null || echo RUNNING"' `
            -MaxRetries   3 `
            -RetryDelayMs 3000
        $pollText = $pollResult.Output.Trim()

        if ($pollResult.ExitCode -ne 0 -and $pollText -eq "") {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] Poll SSH failed - will retry next cycle" -ForegroundColor DarkYellow
            continue
        }

        if ($pollText -ne "RUNNING" -and $pollText -ne "") {
            try { $meta.ExitCode = [int]$pollText } catch { $meta.ExitCode = 1 }
            $logResult = Invoke-SshWithRetry `
                -ConnArgs     $meta.ConnArgs `
                -Command      'bash -c "cat ~/.snapshot_io.out 2>/dev/null | tail -20"' `
                -MaxRetries   3 `
                -RetryDelayMs 3000
            $meta.Output  += "`n" + $logResult.Output
            $meta.Done     = $true
            $pendingCount--

            $status = if ($meta.ExitCode -eq 0) { "SUCCESS" } else { "FAILED" }
            $color  = if ($meta.ExitCode -eq 0) { "Green" }   else { "Red" }
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] $status after ${elapsedMins} min" -ForegroundColor $color
        } else {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [$srvKey] Still running - ${elapsedMins} min elapsed" -ForegroundColor DarkCyan
        }
    }

    $pendingCount = ($serverMeta.Values | Where-Object { -not $_.Done }).Count
}

# --- Collect results ---
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

# --- Final summary ---
$totalDuration = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
$successCount  = ($results | Where-Object { $_.Status -eq "SUCCESS" }).Count
$failCount     = ($results | Where-Object { $_.Status -eq "FAILED"  }).Count
$timeoutCount  = ($results | Where-Object { $_.Status -eq "TIMEOUT" }).Count

Write-Host "`n===== Run Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded    : $successCount" -ForegroundColor Green
Write-Host "  Failed       : $failCount"    -ForegroundColor Red
Write-Host "  Timed out    : $timeoutCount" -ForegroundColor Magenta
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
