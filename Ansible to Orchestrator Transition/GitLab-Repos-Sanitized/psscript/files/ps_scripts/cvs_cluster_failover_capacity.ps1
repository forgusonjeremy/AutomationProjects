[CmdletBinding()]
param(
    [string]$Action,                 # accepted for playbook compatibility; not used (dedicated script)
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [string]$OnlyProblemClusters = 'no'
)

$script:ReportName = 'cvs_cluster_failover_capacity report'
$script:LogFileName = 'cvs_cluster_failover_capacity.log'

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

function Get-ObjectPropertyValue {
    param($Object, [string[]]$Names)
    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        try {
            if ($Object.PSObject.Properties.Match($name).Count -gt 0) { return $Object.$name }
        } catch { }
    }
    return $null
}

function Sum-Property { param([array]$Objects,[string]$Property) $sum = 0; foreach ($o in $Objects) { try { $sum += [decimal]$o.$Property } catch { } }; return $sum }
function Max-Property { param([array]$Objects,[string]$Property) $max = 0; foreach ($o in $Objects) { try { if ([decimal]$o.$Property -gt $max) { $max = [decimal]$o.$Property } } catch { } }; return $max }

$MailFrom = 'user5@dom3.example'
[array]$allResults = @()

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "OnlyProblemClusters=$OnlyProblemClusters"

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
        Write-Log "  Connected. Gathering clusters and HA/admission control state."
        [array]$clusters = @(Get-Cluster | Sort-Object Name)
        Write-Log "  Cluster count: $($clusters.Count)"

        foreach ($cluster in $clusters) {
            $view = $cluster.ExtensionData
            $configEx = $view.ConfigurationEx
            $dasConfig = $configEx.DasConfig
            $policy = $dasConfig.AdmissionControlPolicy
            $policyType = if ($policy) { $policy.GetType().Name } else { 'None' }
            $summary = $view.Summary
            $admissionInfo = Get-ObjectPropertyValue -Object $summary -Names @('AdmissionControlInfo','DasAdmissionControlInfo')

            $haEnabled = [bool](Get-ObjectPropertyValue -Object $dasConfig -Names @('Enabled'))
            $admissionEnabled = [bool](Get-ObjectPropertyValue -Object $dasConfig -Names @('AdmissionControlEnabled'))
            $configuredFailures = Get-ObjectPropertyValue -Object $policy -Names @('FailoverLevel','HostFailuresToTolerate','FailoverHosts')
            if ($configuredFailures -is [array]) { $configuredFailures = @($configuredFailures).Count }
            $currentFailover = Get-ObjectPropertyValue -Object $summary -Names @('CurrentFailoverLevel')
            if ($null -eq $currentFailover) { $currentFailover = Get-ObjectPropertyValue -Object $admissionInfo -Names @('CurrentFailoverLevel') }

            $configuredCpuReserve = Get-ObjectPropertyValue -Object $policy -Names @('CpuFailoverResourcesPercent','CpuFailoverPercent')
            $configuredMemReserve = Get-ObjectPropertyValue -Object $policy -Names @('MemoryFailoverResourcesPercent','MemoryFailoverPercent')
            $currentCpuFailover = Get-ObjectPropertyValue -Object $admissionInfo -Names @('CurrentCpuFailoverResourcesPercent','CpuFailoverResourcesPercent')
            $currentMemFailover = Get-ObjectPropertyValue -Object $admissionInfo -Names @('CurrentMemoryFailoverResourcesPercent','MemoryFailoverResourcesPercent')

            [array]$hosts = @(Get-Cluster -Name $cluster.Name | Get-VMHost -ErrorAction SilentlyContinue)
            [array]$activeHosts = @($hosts | Where-Object { $_.ConnectionState -eq 'Connected' })
            $totalCpuMhz = Sum-Property -Objects $activeHosts -Property 'CpuTotalMhz'
            $largestHostCpuMhz = Max-Property -Objects $activeHosts -Property 'CpuTotalMhz'
            $totalMemGB = Sum-Property -Objects $activeHosts -Property 'MemoryTotalGB'
            $largestHostMemGB = Max-Property -Objects $activeHosts -Property 'MemoryTotalGB'
            $largestHostCpuPct = if ($totalCpuMhz -gt 0) { [Math]::Round(($largestHostCpuMhz / $totalCpuMhz) * 100, 2) } else { $null }
            $largestHostMemPct = if ($totalMemGB -gt 0) { [Math]::Round(($largestHostMemGB / $totalMemGB) * 100, 2) } else { $null }

            $status = 'OK'
            $headroom = $null
            if (-not $haEnabled) {
                $status = 'HA disabled'
            } elseif (-not $admissionEnabled) {
                $status = 'Admission control disabled'
            } elseif ($null -eq $configuredFailures) {
                $status = 'Configured host failures not exposed by policy'
            } elseif ($null -eq $currentFailover) {
                $status = 'Current failover level unavailable'
            } else {
                $headroom = [int]$currentFailover - [int]$configuredFailures
                if ($headroom -lt 0) { $status = 'Cannot tolerate configured host failures' }
                elseif ($headroom -eq 0) { $status = 'Exactly at configured failover capacity' }
                else { $status = 'OK' }
            }

            $allResults += [pscustomobject][ordered]@{
                'Status'                         = $status
                'vCenter'                        = Get-ShortVcName $vcenter
                'Cluster'                        = $cluster.Name
                'HAEnabled'                      = $haEnabled
                'AdmissionControlEnabled'        = $admissionEnabled
                'AdmissionPolicyType'            = $policyType
                'ConfiguredHostFailures'         = $configuredFailures
                'CurrentFailoverLevel'           = $currentFailover
                'FailoverHeadroomHosts'          = $headroom
                'HostCount'                      = @($hosts).Count
                'ConnectedHostCount'             = @($activeHosts).Count
                'LargestHostCpuPctOfCluster'     = $largestHostCpuPct
                'LargestHostMemoryPctOfCluster'  = $largestHostMemPct
                'ConfiguredCpuReservePct'        = $configuredCpuReserve
                'ConfiguredMemoryReservePct'     = $configuredMemReserve
                'CurrentCpuFailoverPct'          = $currentCpuFailover
                'CurrentMemoryFailoverPct'       = $currentMemFailover
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) clusters evaluated."

$critical = @($allResults | Where-Object { $_.Status -eq 'Cannot tolerate configured host failures' } | Sort-Object FailoverHeadroomHosts, Cluster)
$warning = @($allResults | Where-Object { $_.Status -in @('Exactly at configured failover capacity','Admission control disabled','Current failover level unavailable','Configured host failures not exposed by policy') } | Sort-Object Status, Cluster)
$ok = @($allResults | Where-Object { $_.Status -eq 'OK' } | Sort-Object vCenter, Cluster)
if ($OnlyProblemClusters -eq 'yes') { $ok = @() }

$alert_title = "$($critical.Count) clusters cannot tolerate configured host failures | $($warning.Count) warnings"
$tblCritical = Convert-RowsToStyledHtml -Rows $critical -Accent '#b91c1c' -EmptyText 'No clusters are below their configured host-failure tolerance.'
$tblWarning = Convert-RowsToStyledHtml -Rows $warning -Accent '#c2410c' -EmptyText 'No admission-control warnings found.'
$tblOk = Convert-RowsToStyledHtml -Rows $ok -Accent '#166534' -EmptyText 'OK cluster rows hidden or none found.'
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="1120" cellpadding="0" cellspacing="0" style="max-width:1120px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">Cluster Failover Capacity Report</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Compares each cluster's configured HA/admission-control host-failure tolerance with the current failover level exposed by vCenter. Clusters are flagged when the current level is below the configured failures-to-tolerate value, which means the cluster can no longer tolerate the configured host loss.
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">&#9679; Critical &nbsp;&ndash;&nbsp; cannot tolerate configured host failures</div>
        $tblCritical
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">&#9679; Warning / review</div>
        $tblWarning
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#166534;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #166534;">&#9679; OK clusters</div>
        $tblOk
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_cluster_failover_capacity.ps1 via Ansible &bull; $reportTime
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'cluster_failover_capacity.csv'
$allResults | Sort-Object Status, vCenter, Cluster | Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="
