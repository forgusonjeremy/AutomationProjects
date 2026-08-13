[CmdletBinding()]
param(
    [string]$Action,                 # accepted for playbook compatibility; not used (dedicated script)
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [int]$ShortLookbackDays = 7,
    [int]$LongLookbackDays = 30,
    [decimal]$ProjectionThresholdPercent = 90,
    [int]$ProjectionWindowDays = 30,
    [decimal]$MinimumGrowthGBPerDay = 0.10
)

$script:ReportName = 'cvs_datastore_fill_projection report'
$script:LogFileName = 'cvs_datastore_fill_projection.log'

# ---- Standalone framework shims (not sourcing cvs_functions.ps1) -------------
$DebugDir = Join-Path $PSScriptRoot 'debug'
if (-not (Test-Path $DebugDir)) { New-Item -ItemType Directory -Path $DebugDir -Force | Out-Null }
$LogFile = Join-Path $DebugDir $script:LogFileName

function Write-Log { param([string]$Message) $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message); $line | Out-File -FilePath $LogFile -Append -Encoding utf8; Write-Host $line }

function Format-CvsTableHtml {
    param([string]$Fragment,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) { return ('<p style="margin:6px 0 20px;padding:10px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">' + $EmptyText + '</p>') }
    $t = $Fragment
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:7px 11px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,-]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', { param($m) $script:__zebraRow++; if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' } })
    return $t
}

function Convert-RowsToStyledHtml { param([array]$Rows,[string]$Accent,[string]$EmptyText = 'None in this range.') if (($null -eq $Rows) -or (@($Rows).Count -eq 0)) { return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText } $fragment = $Rows | ConvertTo-Html -Fragment; return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText }
function Get-ShortVcName { param([string]$vCenter) if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' } return ($vCenter.Trim().Split('.')[0]) }
function Test-VcenterTcp443 { param([string]$Server) $tcp = New-Object System.Net.Sockets.TcpClient; try { $iar = $tcp.BeginConnect($Server,443,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"; return $false }; $tcp.EndConnect($iar); return $true } catch { Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"; return $false } finally { $tcp.Close() } }

function Get-DatastoreGrowthRate {
    param(
        [Parameter(Mandatory=$true)]$Datastore,
        [int]$LookbackDays
    )

    $start = (Get-Date).AddDays(-1 * $LookbackDays)
    $metricNames = @('disk.used.latest.average','disk.used.latest')
    foreach ($metricName in $metricNames) {
        try {
            $samples = @(Get-Stat -Entity $Datastore -Stat $metricName -Start $start -MaxSamples 10000 -ErrorAction Stop | Sort-Object Timestamp)
            if ($samples.Count -lt 2) { continue }
            $first = $samples | Select-Object -First 1
            $last  = $samples | Select-Object -Last 1
            $daysObserved = [Math]::Max(1, (New-TimeSpan -Start $first.Timestamp -End $last.Timestamp).TotalDays)

            # vCenter reports disk.used datastore samples in KB. Convert KB -> GB.
            $firstGB = [decimal]$first.Value / 1048576
            $lastGB  = [decimal]$last.Value / 1048576
            $growthGB = $lastGB - $firstGB
            $rate = [decimal]($growthGB / $daysObserved)
            if ($rate -lt 0) { $rate = 0 }

            return [pscustomobject]@{
                MetricName     = $metricName
                GrowthGB       = [Math]::Round($growthGB, 2)
                GrowthGBPerDay = [Math]::Round($rate, 2)
                FirstSample    = $first.Timestamp
                LastSample     = $last.Timestamp
                Samples        = $samples.Count
            }
        } catch {
            Write-Log "    Growth metric [$metricName] unavailable for datastore [$($Datastore.Name)]: $($_.Exception.Message)"
        }
    }

    return [pscustomobject]@{
        MetricName     = 'Unavailable'
        GrowthGB       = $null
        GrowthGBPerDay = $null
        FirstSample    = $null
        LastSample     = $null
        Samples        = 0
    }
}

$MailFrom = 'user5@dom3.example'
[array]$allResults = @()
$now = Get-Date

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "Thresholds: ShortLookbackDays=$ShortLookbackDays LongLookbackDays=$LongLookbackDays ProjectionThresholdPercent=$ProjectionThresholdPercent ProjectionWindowDays=$ProjectionWindowDays MinimumGrowthGBPerDay=$MinimumGrowthGBPerDay"

if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) { Write-Log "ERROR: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting."; exit 1 }
$vcCred = [pscredential]::new($env:VC_USER,(ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force))
Write-Log "Credential built for user [$($vcCred.UserName)]."

Write-Log "Loading PowerCLI module..."
if (!(Get-Module VMware.VimAutomation.Core)) { Import-Module VMware.VimAutomation.Core }
Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null
Write-Log "PowerCLI ready."

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }

foreach ($vcenter in $vCenterList.Split(',')) {
    $vcenter = $vcenter.Trim()
    if ([string]::IsNullOrWhiteSpace($vcenter)) { continue }
    Write-Log "vCenter: $vcenter"
    if (-not (Test-VcenterTcp443 -Server $vcenter)) { continue }

    try {
        Write-Log "  Connecting to $vcenter..."
        Connect-VIServer -Server $vcenter -Credential $vcCred -Force -WarningAction 0 -ErrorAction Stop | Out-Null
        Write-Log "  Connected. Gathering datastores and historical usage metrics."
        [array]$datastores = @(Get-Datastore | Where-Object { $_.CapacityGB -gt 0 } | Sort-Object Name)
        Write-Log "  Datastore count: $($datastores.Count)"

        foreach ($ds in $datastores) {
            $capacityGB = [decimal]$ds.CapacityGB
            $freeGB = [decimal]$ds.FreeSpaceGB
            $usedGB = $capacityGB - $freeGB
            $percentUsed = if ($capacityGB -gt 0) { [Math]::Round(($usedGB / $capacityGB) * 100, 2) } else { 0 }
            $thresholdGB = $capacityGB * ([decimal]$ProjectionThresholdPercent / 100)
            $gbToThreshold = [Math]::Round(($thresholdGB - $usedGB), 2)

            $growth7  = Get-DatastoreGrowthRate -Datastore $ds -LookbackDays $ShortLookbackDays
            $growth30 = Get-DatastoreGrowthRate -Datastore $ds -LookbackDays $LongLookbackDays
            $rate7 = if ($null -ne $growth7.GrowthGBPerDay) { [decimal]$growth7.GrowthGBPerDay } else { $null }
            $rate30 = if ($null -ne $growth30.GrowthGBPerDay) { [decimal]$growth30.GrowthGBPerDay } else { $null }

            $projectionRate = $null
            $projectionSource = 'No positive growth metric'
            if (($null -ne $rate7) -or ($null -ne $rate30)) {
                $candidates = @()
                if ($null -ne $rate7) { $candidates += [pscustomobject]@{ Rate = $rate7; Source = "$ShortLookbackDays-day" } }
                if ($null -ne $rate30) { $candidates += [pscustomobject]@{ Rate = $rate30; Source = "$LongLookbackDays-day" } }
                $selected = $candidates | Sort-Object Rate -Descending | Select-Object -First 1
                $projectionRate = [decimal]$selected.Rate
                $projectionSource = $selected.Source
            }

            $daysToThreshold = $null
            $status = 'OK'
            if ($percentUsed -ge $ProjectionThresholdPercent) {
                $daysToThreshold = 0
                $status = 'Already at or above threshold'
            } elseif (($null -eq $projectionRate) -or ($projectionRate -lt $MinimumGrowthGBPerDay)) {
                $status = 'No measurable growth'
            } else {
                $daysToThreshold = [Math]::Round(($thresholdGB - $usedGB) / $projectionRate, 1)
                if ($daysToThreshold -le $ProjectionWindowDays) { $status = "Projected to hit $ProjectionThresholdPercent% within $ProjectionWindowDays days" }
                else { $status = 'Positive growth outside projection window' }
            }

            $allResults += [pscustomobject][ordered]@{
                'Status'             = $status
                'vCenter'            = Get-ShortVcName $vcenter
                'Datastore'          = $ds.Name
                'Type'               = $ds.Type
                'CapacityGB'         = [Math]::Round($capacityGB, 2)
                'UsedGB'             = [Math]::Round($usedGB, 2)
                'FreeGB'             = [Math]::Round($freeGB, 2)
                'PercentUsed'        = $percentUsed
                'GBToThreshold'      = $gbToThreshold
                'Growth7dGB'         = $growth7.GrowthGB
                'Growth7dGBPerDay'   = $growth7.GrowthGBPerDay
                'Growth30dGB'        = $growth30.GrowthGB
                'Growth30dGBPerDay'  = $growth30.GrowthGBPerDay
                'ProjectionRate'     = $projectionRate
                'ProjectionSource'   = $projectionSource
                'DaysToThreshold'    = $daysToThreshold
                'Samples7d'          = $growth7.Samples
                'Samples30d'         = $growth30.Samples
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) datastores evaluated."

$critical = @($allResults | Where-Object { $_.Status -like 'Already*' -or $_.Status -like 'Projected*' } | Sort-Object @{Expression='DaysToThreshold';Ascending=$true}, @{Expression='PercentUsed';Descending=$true})
$watch    = @($allResults | Where-Object { $_.Status -eq 'Positive growth outside projection window' } | Sort-Object @{Expression='DaysToThreshold';Ascending=$true})
$unknown  = @($allResults | Where-Object { $_.Status -eq 'No measurable growth' } | Sort-Object @{Expression='PercentUsed';Descending=$true} | Select-Object -First 25)

$alert_title = "$($critical.Count) datastores projected/over $ProjectionThresholdPercent% within $ProjectionWindowDays days"
$tblCritical = Convert-RowsToStyledHtml -Rows $critical -Accent '#b91c1c' -EmptyText "No datastores are projected to hit $ProjectionThresholdPercent% within $ProjectionWindowDays days."
$tblWatch    = Convert-RowsToStyledHtml -Rows $watch -Accent '#c2410c' -EmptyText "No positive-growth datastores outside the projection window were found."
$tblUnknown  = Convert-RowsToStyledHtml -Rows $unknown -Accent '#64748b' -EmptyText "No no-growth or no-metric datastores to show."
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="1120" cellpadding="0" cellspacing="0" style="max-width:1120px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">Datastore Fill Projection Report</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Datastores are projected using the faster of the <b>$ShortLookbackDays-day</b> and <b>$LongLookbackDays-day</b> positive growth rates from vCenter historical datastore usage. Anything projected to hit <b>$ProjectionThresholdPercent%</b> used within <b>$ProjectionWindowDays days</b> is flagged. Growth below <b>$MinimumGrowthGBPerDay GB/day</b> is treated as no measurable growth.
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">&#9679; Immediate risk &nbsp;&ndash;&nbsp; projected/over $ProjectionThresholdPercent% within $ProjectionWindowDays days</div>
        $tblCritical
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">&#9679; Watchlist &nbsp;&ndash;&nbsp; positive growth outside the $ProjectionWindowDays-day window</div>
        $tblWatch
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#64748b;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #64748b;">&#9679; No/low growth sample &nbsp;&ndash;&nbsp; top 25 by current utilization</div>
        $tblUnknown
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_datastore_fill_projection.ps1 via Ansible &bull; $reportTime
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'datastore_fill_projection.csv'
$allResults | Sort-Object @{Expression='DaysToThreshold';Ascending=$true}, @{Expression='PercentUsed';Descending=$true} | Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="
