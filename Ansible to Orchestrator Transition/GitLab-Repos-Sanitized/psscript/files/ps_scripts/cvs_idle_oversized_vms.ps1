[CmdletBinding()]
param(
    [string]$Action,                 # accepted for playbook compatibility; not used (dedicated script)
    [string]$eMailReport = 'no',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,
    [int]$LookbackDays = 30,
    [int]$StatIntervalMins = 120,
    [decimal]$TargetCpuPct = 50,
    [decimal]$TargetMemPct = 70,
    [int]$MinimumCpuToEvaluate = 4,
    [int]$MinimumMemoryGBToEvaluate = 8,
    [int]$MinimumReclaimvCPU = 2,
    [int]$MinimumReclaimMemGB = 4
)

$script:ReportName = 'cvs_idle_oversized_vms rightsizing report'
$script:LogFileName = 'cvs_idle_oversized_vms.log'

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

function Get-Percentile {
    param([decimal[]]$Values,[decimal]$Percentile)
    if (($null -eq $Values) -or ($Values.Count -eq 0)) { return $null }
    $sorted = @($Values | Sort-Object)
    $rank = [Math]::Ceiling(($Percentile / 100) * $sorted.Count) - 1
    if ($rank -lt 0) { $rank = 0 }
    if ($rank -ge $sorted.Count) { $rank = $sorted.Count - 1 }
    return [decimal]$sorted[$rank]
}

function Round-UpEvenGB {
    param([decimal]$ValueGB)
    return [int]([Math]::Ceiling($ValueGB / 2) * 2)
}

$MailFrom = 'user5@dom3.example'
[array]$allResults = @()
$start = (Get-Date).AddDays(-1 * $LookbackDays)

Write-Log "=== $script:ReportName start (Action=$Action) ==="
Write-Log "LookbackDays=$LookbackDays StatIntervalMins=$StatIntervalMins TargetCpuPct=$TargetCpuPct TargetMemPct=$TargetMemPct"

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
        Write-Log "  Connected. Gathering powered-on VMs."
        $vms = Get-VM | Where-Object { $_.PowerState -eq 'PoweredOn' } | Sort-Object Name
        Write-Log "  Powered-on VM count: $($vms.Count)"

        foreach ($vm in $vms) {
            try {
                if (($vm.NumCpu -lt $MinimumCpuToEvaluate) -and ([Math]::Round($vm.MemoryGB,0) -lt $MinimumMemoryGBToEvaluate)) { continue }

                $cpuStats = Get-Stat -Entity $vm -Stat 'cpu.usage.average' -Start $start -IntervalMins $StatIntervalMins -ErrorAction SilentlyContinue
                $memStats = Get-Stat -Entity $vm -Stat 'mem.usage.average' -Start $start -IntervalMins $StatIntervalMins -ErrorAction SilentlyContinue
                if (($null -eq $cpuStats -or $cpuStats.Count -eq 0) -and ($null -eq $memStats -or $memStats.Count -eq 0)) { continue }

                $cpuValues = @($cpuStats | Select-Object -ExpandProperty Value | ForEach-Object { [decimal]$_ })
                $memValues = @($memStats | Select-Object -ExpandProperty Value | ForEach-Object { [decimal]$_ })
                $cpuAvg = if ($cpuValues.Count -gt 0) { [Math]::Round((($cpuValues | Measure-Object -Average).Average), 2) } else { $null }
                $memAvg = if ($memValues.Count -gt 0) { [Math]::Round((($memValues | Measure-Object -Average).Average), 2) } else { $null }
                $cpuP95 = if ($cpuValues.Count -gt 0) { [Math]::Round((Get-Percentile -Values $cpuValues -Percentile 95), 2) } else { $null }
                $memP95 = if ($memValues.Count -gt 0) { [Math]::Round((Get-Percentile -Values $memValues -Percentile 95), 2) } else { $null }

                $recCpu = [int]$vm.NumCpu
                $cpuReclaim = 0
                if (($vm.NumCpu -ge $MinimumCpuToEvaluate) -and ($null -ne $cpuP95) -and ($cpuP95 -lt $TargetCpuPct)) {
                    $calcCpu = [int][Math]::Ceiling(($vm.NumCpu * $cpuP95) / $TargetCpuPct)
                    if ($calcCpu -lt 2) { $calcCpu = 2 }
                    if ($calcCpu -lt $vm.NumCpu) { $recCpu = $calcCpu; $cpuReclaim = [int]($vm.NumCpu - $recCpu) }
                }

                $memGB = [decimal][Math]::Round($vm.MemoryGB, 2)
                $recMem = [int][Math]::Ceiling($memGB)
                $memReclaim = 0
                if (($memGB -ge $MinimumMemoryGBToEvaluate) -and ($null -ne $memP95) -and ($memP95 -lt $TargetMemPct)) {
                    $calcMem = Round-UpEvenGB -ValueGB (($memGB * $memP95) / $TargetMemPct)
                    if ($calcMem -lt 4) { $calcMem = 4 }
                    if ($calcMem -lt $memGB) { $recMem = $calcMem; $memReclaim = [int]([Math]::Floor($memGB - $recMem)) }
                }

                if (($cpuReclaim -lt $MinimumReclaimvCPU) -and ($memReclaim -lt $MinimumReclaimMemGB)) { continue }

                $datastoreNames = ''
                try { $datastoreNames = (($vm | Get-Datastore | Select-Object -ExpandProperty Name) -join ', ') } catch { $datastoreNames = '' }
                $clusterName = ''
                try { $clusterName = ($vm | Get-Cluster).Name } catch { $clusterName = '' }

                $reason = @()
                if ($cpuReclaim -ge $MinimumReclaimvCPU) { $reason += "CPU reclaim $cpuReclaim vCPU" }
                if ($memReclaim -ge $MinimumReclaimMemGB) { $reason += "Memory reclaim $memReclaim GB" }

                $allResults += [pscustomobject][ordered]@{
                    'vCenter'       = Get-ShortVcName $vcenter
                    'VM'            = $vm.Name
                    'Cluster'       = $clusterName
                    'Datastore'     = $datastoreNames
                    'CurrentvCPU'   = $vm.NumCpu
                    'RecVCPU'       = $recCpu
                    'ReclaimvCPU'   = $cpuReclaim
                    'CurrentMemGB'  = $memGB
                    'RecMemGB'      = $recMem
                    'ReclaimMemGB'  = $memReclaim
                    'CPUAvgPct30d'  = $cpuAvg
                    'CPUP95Pct30d'  = $cpuP95
                    'MemAvgPct30d'  = $memAvg
                    'MemP95Pct30d'  = $memP95
                    'SamplesCPU'    = $cpuValues.Count
                    'SamplesMem'    = $memValues.Count
                    'Reason'        = ($reason -join '; ')
                }
            } catch {
                Write-Log "    ERROR evaluating VM [$($vm.Name)]: $($_.Exception.Message)"
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) idle/oversized VMs matched."

$sorted = $allResults | Sort-Object -Property @{Expression='ReclaimMemGB';Descending=$true}, @{Expression='ReclaimvCPU';Descending=$true}, VM
$totalCpu = [int](($sorted | Measure-Object -Property ReclaimvCPU -Sum).Sum)
$totalMem = [int](($sorted | Measure-Object -Property ReclaimMemGB -Sum).Sum)
$cpuOnly = $sorted | Where-Object { $_.ReclaimvCPU -ge $MinimumReclaimvCPU -and $_.ReclaimMemGB -lt $MinimumReclaimMemGB }
$memOnly = $sorted | Where-Object { $_.ReclaimMemGB -ge $MinimumReclaimMemGB -and $_.ReclaimvCPU -lt $MinimumReclaimvCPU }
$both    = $sorted | Where-Object { $_.ReclaimvCPU -ge $MinimumReclaimvCPU -and $_.ReclaimMemGB -ge $MinimumReclaimMemGB }
$alert_title = "$($sorted.Count) rightsizing targets | $totalCpu vCPU / $totalMem GB reclaim"
$tblBoth = Convert-RowsToStyledHtml -Rows $both -Accent '#b91c1c' -EmptyText 'No VMs have both CPU and memory waste above threshold.'
$tblCpu  = Convert-RowsToStyledHtml -Rows $cpuOnly -Accent '#c2410c' -EmptyText 'No CPU-only rightsizing targets were found.'
$tblMem  = Convert-RowsToStyledHtml -Rows $memOnly -Accent '#a16207' -EmptyText 'No memory-only rightsizing targets were found.'
$reportTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="1040" cellpadding="0" cellspacing="0" style="max-width:1040px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">Idle / Oversized VM Rightsizing Report</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Powered-on VMs are evaluated over the last <b>$LookbackDays days</b> using <b>cpu.usage.average</b> and <b>mem.usage.average</b>. The report only lists VMs with real waste: at least <b>$MinimumReclaimvCPU vCPU</b> reclaimable or <b>$MinimumReclaimMemGB GB</b> memory reclaimable. Recommended size is based on 95th percentile utilization with target ceilings of <b>$TargetCpuPct% CPU</b> and <b>$TargetMemPct% memory</b>.
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#b91c1c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #b91c1c;">&#9679; CPU and memory waste</div>
        $tblBoth
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#c2410c;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #c2410c;">&#9679; CPU waste only</div>
        $tblCpu
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#a16207;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid #a16207;">&#9679; Memory waste only</div>
        $tblMem
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_idle_oversized_vms.ps1 via Ansible &bull; $reportTime &bull; Estimated reclaim: $totalCpu vCPU / $totalMem GB memory
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'idle_oversized_vms.csv'
$sorted | Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="
