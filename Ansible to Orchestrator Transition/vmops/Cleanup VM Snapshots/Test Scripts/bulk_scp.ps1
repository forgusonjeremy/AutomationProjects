# bulk_scp.ps1
# Usage: .\bulk_scp.ps1 -FilePath "C:\path\to\file.txt" -CsvPath "servers.csv"
#
# Transfers files using SSH pipe (cat >) rather than scp to prevent Windows
# OpenSSH from introducing CRLF line endings during transfer.
#
# CSV format (headers required):
#   Server,Username,RemotePath,Port
#   192.168.1.10,sshuser,/tmp/,22

param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath,

    [Parameter(Mandatory=$true)]
    [string]$CsvPath,

    [switch]$StopOnError
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

# --- Read file content for piping ---
$fileName    = Split-Path $FilePath -Leaf
$fileContent = [System.IO.File]::ReadAllText($FilePath)

# --- Transfer loop ---
$results      = @()
$successCount = 0
$failCount    = 0

Write-Host "`nStarting transfers for: $FilePath" -ForegroundColor Cyan
Write-Host "Method  : SSH pipe (cat >) — CRLF-safe" -ForegroundColor Cyan
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

    $sshArgs = @(
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-p", $port,
        "${username}@${server}",
        "cat > '$remotePath'"
    )

    $fileContent | & ssh @sshArgs
    $exitCode = $LASTEXITCODE

    # Strip \r bytes unconditionally — no-op if already clean
    if ($exitCode -eq 0) {
        $stripArgs = @(
            "-o", "StrictHostKeyChecking=no",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-p", $port,
            "${username}@${server}",
            "sed -i 's/\r//' '$remotePath'"
        )
        & ssh @stripArgs 2>&1 | Out-Null

        $verifyArgs = @(
            "-o", "StrictHostKeyChecking=no",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-p", $port,
            "${username}@${server}",
            "grep -cP '\r' '$remotePath' 2>/dev/null || echo 0"
        )
        $crlfCount = (& ssh @verifyArgs 2>&1).Trim()

        if ($crlfCount -eq "0") {
            Write-Host "[$server] Line endings OK (no CRLF bytes found)" -ForegroundColor DarkGray
        } else {
            Write-Host "[$server] WARNING: $crlfCount lines still contain CRLF after strip" -ForegroundColor Magenta
        }
    }

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