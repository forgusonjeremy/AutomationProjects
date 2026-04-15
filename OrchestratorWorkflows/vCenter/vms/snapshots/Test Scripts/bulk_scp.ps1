# SCP-to-Servers.ps1
# Usage: .\SCP-to-Servers.ps1 -FilePath "C:\path\to\file.txt" -CsvPath "servers.csv"
#
# CSV format (headers required):
#   Server,Username,RemotePath,Port
#   192.168.1.10,admin,/home/admin/,22
#   myserver.com,deploy,/var/www/html/,22

param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath,           # Local file to transfer

    [Parameter(Mandatory=$true)]
    [string]$CsvPath,            # Path to CSV file with server list

    [string]$IdentityFile = "",  # Optional: path to SSH private key

    [switch]$StopOnError        # Stop script if any transfer fails
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

# Check scp is available
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
    Write-Error "scp not found. Install OpenSSH or add it to PATH."
    exit 1
}

# --- Load servers from CSV ---
$servers = Import-Csv -Path $CsvPath

if ($servers.Count -eq 0) {
    Write-Error "CSV file is empty or has no valid rows."
    exit 1
}

# Validate required columns exist
$requiredCols = @("Server", "Username", "RemotePath")
$csvCols = $servers[0].PSObject.Properties.Name
foreach ($col in $requiredCols) {
    if ($col -notin $csvCols) {
        Write-Error "CSV is missing required column: '$col'. Required: $($requiredCols -join ', ')"
        exit 1
    }
}

# --- Transfer loop ---
$results = @()
$successCount = 0
$failCount = 0

Write-Host "`nStarting SCP transfers for: $FilePath" -ForegroundColor Cyan
Write-Host "Servers to process: $($servers.Count)`n" -ForegroundColor Cyan

foreach ($row in $servers) {
    $server   = $row.Server.Trim()
    $username = $row.Username.Trim()
    $remotePath = $row.RemotePath.Trim()
    $port     = if ($row.PSObject.Properties.Name -contains "Port" -and $row.Port) { $row.Port.Trim() } else { "22" }

    $target = "${username}@${server}:${remotePath}"
    Write-Host "[$server] Transferring to $target (port $port)..." -ForegroundColor Yellow

    # Build scp arguments
    $scpArgs = @("-P", $port, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")
    if ($IdentityFile -ne "") {
        $scpArgs += @("-i", $IdentityFile)
    }
    $scpArgs += @($FilePath, $target)

    # Run scp and capture result
    $process = Start-Process -FilePath "scp" `
                             -ArgumentList $scpArgs `
                             -NoNewWindow `
                             -Wait `
                             -PassThru

    $status = if ($process.ExitCode -eq 0) { "SUCCESS" } else { "FAILED" }
    $color  = if ($process.ExitCode -eq 0) { "Green" } else { "Red" }

    Write-Host "[$server] $status (exit code: $($process.ExitCode))" -ForegroundColor $color

    $results += [PSCustomObject]@{
        Server     = $server
        Username   = $username
        RemotePath = $remotePath
        Port       = $port
        Status     = $status
        ExitCode   = $process.ExitCode
        Timestamp  = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }

    if ($process.ExitCode -eq 0) { $successCount++ } else { $failCount++ }

    if ($StopOnError -and $process.ExitCode -ne 0) {
        Write-Warning "StopOnError is set. Halting after failure on $server."
        break
    }
}

# --- Summary ---
Write-Host "`n===== Transfer Summary =====" -ForegroundColor Cyan
Write-Host "  Succeeded : $successCount" -ForegroundColor Green
Write-Host "  Failed    : $failCount"    -ForegroundColor Red
Write-Host "  Total     : $($servers.Count)"

# Export results to a log CSV
$logPath = "scp_results_$(Get-Date -Format 'yyyyMMdd_HHmmss').csv"
$results | Export-Csv -Path $logPath -NoTypeInformation
Write-Host "`nDetailed results saved to: $logPath`n" -ForegroundColor Cyan

# Exit with non-zero code if any failures
if ($failCount -gt 0) { exit 1 } else { exit 0 }