[CmdletBinding()]
param(
    [string]$Action,
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [int]$SnapshotAgeDays = 7,
    [decimal]$OversizedSnapshotGB = 25
)

$script:ReportName  = 'cvs_aged_oversized_snapshots report'
$script:LogFileName = 'cvs_aged_oversized_snapshots.log'

$DebugDir = Join-Path $PSScriptRoot 'debug'
if (-not (Test-Path $DebugDir)) { New-Item -ItemType Directory -Path $DebugDir -Force | Out-Null }
$LogFile = Join-Path $DebugDir $script:LogFileName

function Write-Log {
    param([string]$Message)
    $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    $line | Out-File -FilePath $LogFile -Append -Encoding utf8
    Write-Host $line
}

function Format-CvsTableHtml {
    param(
        [string]$Fragment,
        [string]$Accent,
        [string]$EmptyText = 'None in this range.'
    )
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return ('<p style="margin:4px 0 10px;padding:8px 10px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">' + $EmptyText + '</p>')
    }
    $t = $Fragment
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:4px 0 10px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:7px 8px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:5px 8px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,-]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', {
        param($m)
        $script:__zebraRow++
        if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' }
    })
    return $t
}

function Convert-RowsToStyledHtml {
    param(
        [array]$Rows,
        [string]$Accent,
        [string]$EmptyText = 'None in this range.'
    )
    if (($null -eq $Rows) -or (@($Rows).Count -eq 0)) {
        return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText
    }
    $fragment = $Rows | ConvertTo-Html -Fragment
    return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText
}

function Get-ShortVcName {
    param([string]$vCenter)
    if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' }
    return ($vCenter.Trim().Split('.')[0])
}

function Test-VcenterTcp443 {
    param([string]$Server)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($Server, 443, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(5000)) {
            Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"
            return $false
        }
        $tcp.EndConnect($iar)
        return $true
    } catch {
        Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"
        return $false
    } finally {
        $tcp.Close()
    }
}

$MailFrom = 'user5@dom3.example'
[array]$allResults = @()
[array]$consolidationOnly = @()
$now = Get-Date

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "Thresholds: SnapshotAgeDays=$SnapshotAgeDays OversizedSnapshotGB=$OversizedSnapshotGB"

if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) {
    Write-Log "ERROR: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting."
    exit 1
}
$vcCred = [pscredential]::new($env:VC_USER, (ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force))
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
        Write-Log "  Connected. Gathering VMs and snapshots."
        [array]$vms = @(Get-VM | Sort-Object Name)
        Write-Log "  VM count: $($vms.Count)"

        foreach ($vm in $vms) {
            $clusterName = ''
            try { $clusterName = ($vm | Get-Cluster).Name } catch { $clusterName = '' }

            $consolidationNeeded = $false
            try { $consolidationNeeded = [bool]$vm.ExtensionData.Runtime.ConsolidationNeeded } catch { $consolidationNeeded = $false }

            [array]$snaps = @()
            try { $snaps = @(Get-Snapshot -VM $vm -ErrorAction SilentlyContinue) } catch { Write-Log "    Snapshot lookup failed for VM [$($vm.Name)]: $($_.Exception.Message)" }
            $matchedSnapshot = $false

            foreach ($snap in $snaps) {
                if ($snap.Name -eq '__GX_BACKUP__') { continue }
                $ageDays = [int](New-TimeSpan -Start $snap.Created -End $now).TotalDays
                $sizeGB = 0
                try { $sizeGB = [decimal]$snap.SizeGB } catch { $sizeGB = 0 }

                $isAged = ($ageDays -ge $SnapshotAgeDays)
                $isOversized = ($sizeGB -ge $OversizedSnapshotGB)
                if (-not ($isAged -or $isOversized -or $consolidationNeeded)) { continue }
                $matchedSnapshot = $true

                $reason = @()
                if ($isAged) { $reason += "Older than $SnapshotAgeDays days" }
                if ($isOversized) { $reason += "Snapshot/delta size >= $OversizedSnapshotGB GB" }
                if ($consolidationNeeded) { $reason += 'VM consolidation needed' }

                $allResults += [pscustomobject][ordered]@{
                    'Reason'              = ($reason -join '; ')
                    'vCenter'             = Get-ShortVcName $vcenter
                    'VM'                  = $vm.Name
                    'Cluster'             = $clusterName
                    'PowerState'          = $vm.PowerState
                    'SnapshotName'        = $snap.Name
                    'SnapshotCreated'     = $snap.Created.ToString('yyyy-MM-dd HH:mm:ss')
                    'SnapshotAgeDays'     = $ageDays
                    'SnapshotDeltaSizeGB' = [Math]::Round($sizeGB, 2)
                    'ConsolidationNeeded' = $consolidationNeeded
                    'Description'         = $snap.Description
                }
            }

            if ($consolidationNeeded -and -not $matchedSnapshot) {
                $consolidationOnly += [pscustomobject][ordered]@{
                    'Reason'              = 'VM consolidation needed; no snapshot matched age/size filter'
                    'vCenter'             = Get-ShortVcName $vcenter
                    'VM'                  = $vm.Name
                    'Cluster'             = $clusterName
                    'PowerState'          = $vm.PowerState
                    'ConsolidationNeeded' = $true
                }
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) snapshot rows matched; $($consolidationOnly.Count) consolidation-only rows matched."

$critical = @($allResults | Where-Object { $_.ConsolidationNeeded -eq $true -or $_.SnapshotDeltaSizeGB -ge $OversizedSnapshotGB } |
    Sort-Object @{Expression='SnapshotDeltaSizeGB';Descending=$true}, @{Expression='SnapshotAgeDays';Descending=$true})
$agedOnly = @($allResults | Where-Object { $_.ConsolidationNeeded -ne $true -and $_.SnapshotDeltaSizeGB -lt $OversizedSnapshotGB } |
    Sort-Object @{Expression='SnapshotDeltaSizeGB';Descending=$true}, @{Expression='SnapshotAgeDays';Descending=$true})
$consolidationOnly = @($consolidationOnly | Sort-Object VM)

$totalSize = [Math]::Round((($allResults | Measure-Object -Property SnapshotDeltaSizeGB -Sum).Sum), 2)
$alert_title = "$($allResults.Count) aged/oversized snapshots | $totalSize GB delta size | $($consolidationOnly.Count) consolidation-only VMs"

$tblCritical = Convert-RowsToStyledHtml -Rows $critical          -Accent '#b91c1c' -EmptyText "No oversized snapshots or consolidation-needed snapshot rows found."
$tblAged     = Convert-RowsToStyledHtml -Rows $agedOnly          -Accent '#c2410c' -EmptyText "No aged-only snapshots found."
$tblConsol   = Convert-RowsToStyledHtml -Rows $consolidationOnly -Accent '#7c2d12' -EmptyText "No consolidation-needed VMs without matching snapshots found."
$reportTime  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:12px 8px;">
    <table role="presentation" width="1280" cellpadding="0" cellspacing="0" style="max-width:1280px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:16px 20px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">Aged / Oversized Snapshot Report</td></tr>
      <tr><td style="padding:12px 20px 2px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Snapshots are reported when they are older than <b>$SnapshotAgeDays days</b>, their snapshot/delta size is at least <b>$OversizedSnapshotGB GB</b>, or the VM has a <b>consolidation needed</b> flag. Rows are sorted biggest first so the silent datastore killers rise to the top.
      </td></tr>
      <tr><td style="padding:4px 20px 2px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:8px 0 0;padding-bottom:4px;border-bottom:2px solid #b91c1c;">&#9679; Highest risk &nbsp;&ndash;&nbsp; oversized and/or consolidation needed</div>
        $tblCritical
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:8px 0 0;padding-bottom:4px;border-bottom:2px solid #c2410c;">&#9679; Aged snapshots &nbsp;&ndash;&nbsp; older than $SnapshotAgeDays days, sorted biggest first</div>
        $tblAged
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#7c2d12;margin:8px 0 0;padding-bottom:4px;border-bottom:2px solid #7c2d12;">&#9679; Consolidation-needed VMs without matching snapshot rows</div>
        $tblConsol
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:10px 20px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_aged_oversized_snapshots.ps1 via Ansible &bull; $reportTime &bull; Total listed snapshot size: $totalSize GB
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8

$csvFile = Join-Path $DebugDir 'aged_oversized_snapshots.csv'
$allResults |
    Sort-Object @{Expression='SnapshotDeltaSizeGB';Descending=$true}, @{Expression='SnapshotAgeDays';Descending=$true} |
    Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8

$consolidationCsv = Join-Path $DebugDir 'consolidation_needed_without_matching_snapshots.csv'
$consolidationOnly | Export-Csv -NoTypeInformation -Path $consolidationCsv -Encoding utf8

Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"
Write-Log "Consolidation CSV written: $consolidationCsv"

if ($eMailReport -eq 'yes') {
    $mailParams = @{
        SmtpServer = $SMTPServer
        From       = $MailFrom
        To         = ($MailToString -split ',').Trim()
        Subject    = "$MailSubjectstring | $alert_title"
        Body       = $body
        BodyAsHtml = $true
    }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="