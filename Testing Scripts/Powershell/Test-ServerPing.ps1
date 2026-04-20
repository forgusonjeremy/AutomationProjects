<#
.SYNOPSIS
    Tests connectivity to a list of servers from a CSV input file.

.DESCRIPTION
    Reads a CSV file that contains a "Server" column (hostname or IP address),
    pings each entry in parallel, and writes the results to a timestamped
    CSV file. Also prints a summary to the console.

.PARAMETER InputCsv
    Path to the input CSV. Must contain a column named "Server".

.PARAMETER OutputCsv
    Optional. Path to the output CSV. Defaults to
    ".\PingResults_yyyyMMdd_HHmmss.csv" in the current directory.

.PARAMETER Count
    Number of ICMP echo requests per server. Default is 2.

.PARAMETER TimeoutSeconds
    Per-ping timeout in seconds. Default is 2.

.PARAMETER ThrottleLimit
    Max concurrent pings. Default is 32. Requires PowerShell 7+ for
    ForEach-Object -Parallel; falls back to serial on Windows PowerShell 5.1.

.EXAMPLE
    .\Test-ServerPing.ps1 -InputCsv .\servers.csv

.EXAMPLE
    .\Test-ServerPing.ps1 -InputCsv .\servers.csv -OutputCsv .\results.csv -Count 4
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$InputCsv,

    [string]$OutputCsv = (Join-Path -Path (Get-Location) -ChildPath ("PingResults_{0}.csv" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))),

    [ValidateRange(1, 20)]
    [int]$Count = 2,

    [ValidateRange(1, 60)]
    [int]$TimeoutSeconds = 2,

    [ValidateRange(1, 128)]
    [int]$ThrottleLimit = 32
)

# --- Load and validate CSV ---------------------------------------------------
try {
    $rows = Import-Csv -LiteralPath $InputCsv -ErrorAction Stop
} catch {
    Write-Error "Failed to import CSV '$InputCsv': $($_.Exception.Message)"
    return
}

if (-not $rows) {
    Write-Warning "Input CSV '$InputCsv' is empty."
    return
}

if (-not ($rows[0].PSObject.Properties.Name -contains 'Server')) {
    Write-Error "Input CSV must contain a 'Server' column. Found columns: $($rows[0].PSObject.Properties.Name -join ', ')"
    return
}

# Keep only rows with a non-empty Server value, preserve other columns for output
$targets = $rows | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Server) }

if (-not $targets) {
    Write-Warning "No non-empty values found in the 'Server' column."
    return
}

Write-Host "Pinging $($targets.Count) server(s) from '$InputCsv'..." -ForegroundColor Cyan

# --- Define the ping worker --------------------------------------------------
$pingScript = {
    param($row, $count, $timeoutSeconds)

    $server  = $row.Server
    $ping    = New-Object System.Net.NetworkInformation.Ping
    $replies = @()
    $resolvedIp = $null

    for ($i = 0; $i -lt $count; $i++) {
        try {
            $reply = $ping.Send($server, $timeoutSeconds * 1000)
            $replies += $reply
            if ($reply.Status -eq 'Success' -and -not $resolvedIp) {
                $resolvedIp = $reply.Address.ToString()
            }
        } catch {
            $replies += [pscustomobject]@{
                Status         = 'Error'
                RoundtripTime  = $null
                ErrorMessage   = $_.Exception.InnerException?.Message ?? $_.Exception.Message
            }
        }
        Start-Sleep -Milliseconds 200
    }

    $successes = @($replies | Where-Object { $_.Status -eq 'Success' })
    $successCount = $successes.Count
    $avgRtt = if ($successCount -gt 0) {
        [math]::Round((($successes | Measure-Object -Property RoundtripTime -Average).Average), 2)
    } else { $null }

    $status = if ($successCount -eq $count) { 'Online' }
              elseif ($successCount -gt 0)  { 'Partial' }
              else                          { 'Offline' }

    $lastError = ($replies | Where-Object { $_.Status -ne 'Success' } | Select-Object -Last 1).Status

    # Build an output object that preserves every original column, then adds results.
    $out = [ordered]@{}
    foreach ($prop in $row.PSObject.Properties) {
        $out[$prop.Name] = $prop.Value
    }
    $out['ResolvedIP']     = $resolvedIp
    $out['Status']         = $status
    $out['PacketsSent']    = $count
    $out['PacketsReceived']= $successCount
    $out['LossPercent']    = [math]::Round((($count - $successCount) / $count) * 100, 0)
    $out['AvgRTTms']       = $avgRtt
    $out['LastReplyStatus']= $lastError
    $out['TestedAt']       = (Get-Date).ToString('s')

    [pscustomobject]$out
}

# --- Run pings (parallel on PS7+, serial on 5.1) -----------------------------
$results = if ($PSVersionTable.PSVersion.Major -ge 7) {
    $targets | ForEach-Object -Parallel {
        $script = [scriptblock]::Create($using:pingScript)
        & $script $_ $using:Count $using:TimeoutSeconds
    } -ThrottleLimit $ThrottleLimit
} else {
    Write-Verbose "PowerShell 5.1 detected; running pings serially."
    $targets | ForEach-Object { & $pingScript $_ $Count $TimeoutSeconds }
}

# --- Export + summarize ------------------------------------------------------
try {
    $results | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding UTF8
    Write-Host "Results written to: $OutputCsv" -ForegroundColor Green
} catch {
    Write-Error "Failed to write output CSV: $($_.Exception.Message)"
}

$summary = $results | Group-Object Status | Select-Object Name, Count
Write-Host "`nSummary:" -ForegroundColor Cyan
$summary | Format-Table -AutoSize | Out-String | Write-Host

# Return results to the pipeline for further use
$results
