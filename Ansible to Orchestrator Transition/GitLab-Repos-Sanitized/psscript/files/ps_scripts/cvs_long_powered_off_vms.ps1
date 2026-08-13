[CmdletBinding()]
param(
    [string]$Action,                 # accepted for playbook compatibility; not used (dedicated script)
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [int]$WarningDays = 60,
    [int]$CriticalDays = 90,
    [int]$EventLookbackDays = 730
)

$script:ReportName = 'cvs_powered_off_vms inventory report'
$script:LogFileName = 'cvs_long_powered_off_vms.log'

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
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', { param($m) $script:__zebraRow++; if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' } })
    return $t
}

function Convert-RowsToStyledHtml { param([array]$Rows,[string]$Accent,[string]$EmptyText = 'None in this range.') if (($null -eq $Rows) -or ($Rows.Count -eq 0)) { return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText } $fragment = $Rows | ConvertTo-Html -Fragment; return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText }
function Get-ShortVcName { param([string]$vCenter) if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' } return ($vCenter.Trim().Split('.')[0]) }
function Test-VcenterTcp443 { param([string]$Server) $tcp = New-Object System.Net.Sockets.TcpClient; try { $iar = $tcp.BeginConnect($Server,443,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"; return $false }; $tcp.EndConnect($iar); return $true } catch { Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"; return $false } finally { $tcp.Close() } }

# Single event pull per VM returns both the most recent power-off (or suspend) and
# power-on times. Doing this in one Get-VIEvent call keeps API load down now that we
# inspect every powered-off VM instead of only the long-idle ones.
function Get-VmPowerEventTimes {
    param(
        $VM,
        [datetime]$StartDate
    )
    $out = [pscustomobject]@{ LastOff = $null; LastOn = $null }
    try {
        $events = Get-VIEvent -Entity $VM -Start $StartDate -MaxSamples 1000 -ErrorAction SilentlyContinue
        $out.LastOff = ($events | Where-Object { @('VmPoweredOffEvent','VmSuspendedEvent') -contains $_.GetType().Name } | Sort-Object CreatedTime -Descending | Select-Object -First 1).CreatedTime
        $out.LastOn  = ($events | Where-Object { $_.GetType().Name -eq 'VmPoweredOnEvent' } | Sort-Object CreatedTime -Descending | Select-Object -First 1).CreatedTime
    } catch {
        Write-Log "    Event lookup failed for VM [$($VM.Name)]: $($_.Exception.Message)"
    }
    return $out
}

$MailFrom = 'user5@dom3.example'
Set-Variable BYTES_IN_GB -Option Constant -Value ([int64]1073741824) -Visibility Private
[array]$allResults = @()
$now = Get-Date
$eventStart = $now.AddDays(-1 * $EventLookbackDays)

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "Thresholds: WarningDays=$WarningDays CriticalDays=$CriticalDays EventLookbackDays=$EventLookbackDays"

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
        Write-Log "  Connected. Gathering powered-off VMs."
        $vms = Get-VM | Where-Object { $_.PowerState -eq 'PoweredOff' } | Sort-Object Name
        Write-Log "  Powered-off VM count: $($vms.Count)"

        foreach ($vm in $vms) {
            $evt = Get-VmPowerEventTimes -VM $vm -StartDate $eventStart

            if ($null -ne $evt.LastOff) {
                $daysOff        = [int](New-TimeSpan -Start $evt.LastOff -End $now).TotalDays
                $lastOffDisplay = $evt.LastOff.ToString('yyyy-MM-dd HH:mm:ss')
            } else {
                # No power-off event inside the lookback window - the VM has almost
                # certainly been off longer than that, so treat the lookback as a floor
                # and still include it (these are the strongest decommission candidates).
                $daysOff        = $EventLookbackDays
                $lastOffDisplay = "No power-off event in last $EventLookbackDays days (off >= $EventLookbackDays)"
            }

            $datastoreNames = ''
            try { $datastoreNames = (($vm | Get-Datastore | Select-Object -ExpandProperty Name) -join ', ') } catch { $datastoreNames = '' }
            $clusterName = ''
            try { $clusterName = ($vm | Get-Cluster).Name } catch { $clusterName = '' }

            $allResults += [pscustomobject][ordered]@{
                'vCenter'          = Get-ShortVcName $vcenter
                'VM'               = $vm.Name
                'Cluster'          = $clusterName
                'Datastore'        = $datastoreNames
                'vCPU'             = $vm.NumCpu
                'MemoryGB'         = [Math]::Round($vm.MemoryGB, 2)
                'ProvisionedGB'    = [Math]::Round($vm.ProvisionedSpaceGB, 2)
                'UsedGB'           = [Math]::Round($vm.UsedSpaceGB, 2)
                'DaysPoweredOff'   = $daysOff
                'LastPowerOffDate' = $lastOffDisplay
                'LastPowerOnDate'  = if ($evt.LastOn) { $evt.LastOn.ToString('yyyy-MM-dd HH:mm:ss') } else { 'Not found in event retention' }
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) powered-off VMs found."

$critical = $allResults | Where-Object { $_.DaysPoweredOff -ge $CriticalDays } | Sort-Object -Property DaysPoweredOff -Descending
$warning  = $allResults | Where-Object { $_.DaysPoweredOff -ge $WarningDays -and $_.DaysPoweredOff -lt $CriticalDays } | Sort-Object -Property DaysPoweredOff -Descending
$recent   = $allResults | Where-Object { $_.DaysPoweredOff -lt $WarningDays } | Sort-Object -Property DaysPoweredOff -Descending

$totalProvisioned = [Math]::Round((($allResults | Measure-Object -Property ProvisionedGB -Sum).Sum), 2)
$critCount = ($critical | Measure-Object).Count
$alert_title = "$($allResults.Count) powered-off VMs | $critCount >= $CriticalDays days | $totalProvisioned GB provisioned"

$tblCritical = Convert-RowsToStyledHtml -Rows $critical -Accent '#b91c1c' -EmptyText "No VMs powered off for $CriticalDays+ days were found."
$tblWarning  = Convert-RowsToStyledHtml -Rows $warning -Accent '#c2410c' -EmptyText "No VMs powered off between $WarningDays and $($CriticalDays - 1) days were found."
$tblRecent   = Convert-RowsToStyledHtml -Rows $recent -Accent '#2563eb' -EmptyText "No VMs powered off for less than $WarningDays days were found."
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="960" cellpadding="0" cellspacing="0" style="max-width:960px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">Powered-Off VM Inventory Report</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Every powered-off VM is listed with how long it has been powered off, based on the most recent power-off event in vCenter event retention. VMs with no power-off event inside the configured <b>$EventLookbackDays-day</b> lookback are still listed and flagged as powered off for at least that long. Rows are grouped by how long they have been off, with the oldest (decommission candidates) at the top.
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">&#9679; Decommission candidates &nbsp;&ndash;&nbsp; &ge; $CriticalDays days powered off</div>
        $tblCritical
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">&#9679; Review candidates &nbsp;&ndash;&nbsp; $WarningDays to $($CriticalDays - 1) days powered off</div>
        $tblWarning
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#2563eb;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #2563eb;">&#9679; Recently powered off &nbsp;&ndash;&nbsp; &lt; $WarningDays days powered off</div>
        $tblRecent
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_long_powered_off_vms.ps1 via Ansible &bull; $reportTime &bull; $($allResults.Count) powered-off VMs &bull; Total provisioned: $totalProvisioned GB
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'long_powered_off_vms.csv'
$allResults | Sort-Object DaysPoweredOff -Descending | Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="