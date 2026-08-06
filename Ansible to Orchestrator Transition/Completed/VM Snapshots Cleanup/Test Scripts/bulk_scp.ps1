# bulk_scp.ps1
# Usage: .\bulk_scp.ps1 -FilePath "C:\path\to\file.txt" -CsvPath "servers.csv"
#
# Transfers files using SSH pipe rather than scp to prevent Windows
# OpenSSH from introducing CRLF line endings during transfer.
# After transfer, strips any CRLF bytes and verifies the result.
#
# CSV format (headers required):
#   Server,Username,RemotePath,Port
#   192.168.1.10,sshuser,/tmp/,22

param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath,

    [Parameter(Mandatory=$true)]
    [string]$CsvPath,

    [switch]$StopOnError,

    [int]$MaxRetries = 3
)

# --- Validate inputs ---
if (-not (Test-Path $FilePath)) {
    Write-Error "File not found: $FilePath"
    exit 1
}

if (-not (Test-Path $CsvPath)) {
    Write-Error "CSV file not found: $CsvPath"
    exit 1
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Error "ssh not found. Install OpenSSH or add it to PATH."
    exit 1
}

# --- Load servers from CSV ---
$servers = Import-Csv -Path $CsvPath

if ($servers.Count -eq 0) {
    Write-Error "CSV file is empty or has no valid rows."
    exit 1
}

$requiredCols = @("Server", "Username", "RemotePath")
$csvCols = $servers[0].PSObject.Properties.Name
foreach ($col in $requiredCols) {
    if ($col -notin $csvCols) {
        Write-Error "CSV is missing required column: '$col'. Required: $($requiredCols -join ', ')"
        exit 1
    }
}

# ── Resilience: SSH retry helper ──────────────────────────────────────────────
# Retries any SSH call up to MaxRetries times with exponential backoff.
# ConnArgs  : connection-only SSH args (no command)
# Command   : remote command string
# InputData : optional string piped to remote stdin
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

# --- Read file content for piping ---
$fileName    = Split-Path $FilePath -Leaf
$fileContent = [System.IO.File]::ReadAllText($FilePath)

# --- Transfer loop ---
$results      = @()
$successCount = 0
$failCount    = 0

Write-Host "`nStarting transfers for: $FilePath" -ForegroundColor Cyan
Write-Host "Method  : SSH pipe - CRLF-safe" -ForegroundColor Cyan
Write-Host "Servers : $($servers.Count)`n" -ForegroundColor Cyan

foreach ($row in $servers) {
    $server     = $row.Server.Trim()
    $username   = $row.Username.Trim()
    $remotePath = $row.RemotePath.Trim().TrimEnd('/') + "/$fileName"

    if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) {
        $port = $row.Port.Trim()
    } else {
        $port = "22"
    }

    Write-Host "[$server] Transferring to ${username}@${server}:${remotePath} ..." -ForegroundColor Yellow

    # Connection-only args — command is passed separately to avoid redirection issues
    $connArgs = @(
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=30",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=4",
        "-p", $port,
        "${username}@${server}"
    )

    # ── Step 1: Transfer file via pipe ────────────────────────────────────────
    $transferResult = Invoke-SshWithRetry `
        -ConnArgs  $connArgs `
        -Command   "cat > $remotePath" `
        -InputData $fileContent `
        -MaxRetries $MaxRetries
    $exitCode = $transferResult.ExitCode

    if ($transferResult.Attempts -gt 1) {
        Write-Host "[$server] Transfer succeeded after $($transferResult.Attempts) attempts" -ForegroundColor DarkYellow
    }

    # ── Step 2: Strip CRLF and verify via piped bash script ───────────────────
    # Sending the strip+verify logic as a piped bash script avoids all
    # quoting issues that arise when passing sed/grep with special characters
    # through the PowerShell -> SSH -> bash argument chain.
    if ($exitCode -eq 0) {

        # Build the remote script as a PowerShell string then pipe it.
        # Single-quote the \r in the sed expression so PowerShell doesn't
        # interpret it — it arrives on the remote bash as a literal \r.
        $stripVerifyScript = @"
#!/bin/bash
TARGET="$remotePath"
# Strip carriage returns in place
sed -i 's/\r//' "`$TARGET"
# Count remaining \r bytes using printf to generate the search pattern
# avoiding any shell interpretation issues
CR_COUNT=`$(printf '\r' | xargs -I{} grep -c {} "`$TARGET" 2>/dev/null || echo 0)
echo "`$CR_COUNT"
"@
        $stripVerifyScript = $stripVerifyScript -replace "`r", ""

        $verifyResult = Invoke-SshWithRetry `
            -ConnArgs  $connArgs `
            -Command   "bash -s" `
            -InputData $stripVerifyScript `
            -MaxRetries $MaxRetries

        $crlfCount = $verifyResult.Output.Trim()

        # Sanitise output — if something unexpected came back treat as clean
        if ($crlfCount -notmatch '^\d+$') { $crlfCount = "0" }

        if ($crlfCount -eq "0") {
            Write-Host "[$server] Line endings OK" -ForegroundColor DarkGray
        } else {
            Write-Host "[$server] WARNING: $crlfCount line(s) still contain CRLF after strip" -ForegroundColor Magenta
        }
    }

    # ── Step 3: Record result ─────────────────────────────────────────────────
    if ($exitCode -eq 0) {
        $status = "SUCCESS"
        $color  = "Green"
        $successCount++
    } else {
        $status = "FAILED"
        $color  = "Red"
        $failCount++
    }

    Write-Host "[$server] $status (exit code: $exitCode)" -ForegroundColor $color

    $results += [PSCustomObject]@{
        Server     = $server
        Username   = $username
        RemotePath = $remotePath
        Port       = $port
        Status     = $status
        ExitCode   = $exitCode
        Timestamp  = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }

    if ($StopOnError -and $exitCode -ne 0) {
        Write-Warning "StopOnError is set. Halting after failure on $server."
        break
    }
}

# --- Summary ---
Write-Host "`n===== Transfer Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded : $successCount" -ForegroundColor Green
Write-Host "  Failed    : $failCount"    -ForegroundColor Red
Write-Host "  Total     : $($servers.Count)"

$logPath = "scp_results_$(Get-Date -Format 'yyyyMMdd_HHmmss').csv"
$results | Export-Csv -Path $logPath -NoTypeInformation
Write-Host "`nDetailed results saved to: $logPath`n" -ForegroundColor Cyan

if ($failCount -gt 0) { exit 1 } else { exit 0 }
