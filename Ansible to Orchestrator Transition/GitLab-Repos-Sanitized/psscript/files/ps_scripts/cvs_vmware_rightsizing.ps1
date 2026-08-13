[CmdletBinding()]
param(
    [string]$Action,
    [string]$eMailReport = 'yes',
    [string]$SMTPServer,
    [string]$MailToString,
    [string]$MailCcString,
    [string]$MailSubjectstring,
    [string]$vCenterList,

    # --- analysis window ---
    [int]$LookbackDays = 30,
    [int]$IntervalMins = 1440,          # 1440 = daily rollup

    # --- CPU thresholds ---
    [int]$CpuDownsizeP95Pct = 40,
    [double]$CpuReadyWarnPct = 5,
    [double]$CpuReadyCritPct = 10,
    [double]$CostopWarnPct = 3,
    [int]$MinVcpu = 1,

    # --- memory thresholds ---
    [int]$MemDownsizeP95Pct = 50,
    [int]$HeadroomPct = 30,

    # --- minimum change worth reporting ---
    [int]$MinVcpuReclaim = 1,
    [double]$MinRamReclaimGB = 2,
    [int]$MinRamReclaimPct = 10,

    # --- data-quality gate / scope ---
    [int]$MinSampleDays = 7,
    [int]$QueryVmChunkSize = 25,       # keep QueryPerf below vpxd.stats.maxQueryMetrics
    [string]$ClusterFilter = '*',

    # --- output / from address (optional) ---
    [string]$OutputFolder = '',         # persistent path; survives temp cleanup. Empty = <script>\debug
    [string]$MailFrom = ''              # empty = <COMPUTERNAME>user6@dom3.example
)

$script:ReportName  = 'cvs_vmware_rightsizing evidence report'
$script:LogFileName = 'cvs_vmware_rightsizing.log'

# ---- Standalone framework shims -------------
if ([string]::IsNullOrWhiteSpace($OutputFolder)) { $OutputFolder = Join-Path $PSScriptRoot 'debug' }
if (-not (Test-Path $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null }
$DebugDir = $OutputFolder
$LogFile = Join-Path $DebugDir $script:LogFileName

function Write-Log {
    param([string]$Message)
    $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    $line | Out-File -FilePath $LogFile -Append -Encoding utf8
    Write-Host $line
}

# ---- Email formatting helper (presentation only) ----------------------------
function Format-CvsTableHtml {
    param([string]$Fragment,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if ([string]::IsNullOrWhiteSpace($Fragment) -or ($Fragment -notmatch '<td')) {
        return ('<p style="margin:6px 0 20px;padding:10px 12px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:4px;color:#6b7280;font-size:13px;font-family:Segoe UI,Arial,sans-serif;">' + $EmptyText + '</p>')
    }
    $t = $Fragment
    $t = $t -replace '<table>','<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;">'
    $t = $t -replace '<th>',('<th align="left" bgcolor="' + $Accent + '" style="background:' + $Accent + ';color:#ffffff;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;white-space:nowrap;border:1px solid ' + $Accent + ';">')
    $t = $t -replace '<td>','<td style="padding:7px 11px;border:1px solid #e5e7eb;color:#111827;background:#ffffff">'
    $t = $t -replace '(<td style="[^"]+?)(">)(\s*[\d.,]+\s*)(</td>)','$1;text-align:right$2$3$4'
    $script:__zebraRow = 0
    $t = [regex]::Replace($t, '<tr>(?=\s*<td)', { param($m) $script:__zebraRow++; if ($script:__zebraRow % 2 -eq 0) { '<tr style="background:#f9fafb">' } else { '<tr>' } })
    return $t
}

function Convert-RowsToStyledHtml {
    param([array]$Rows,[string]$Accent,[string]$EmptyText = 'None in this range.')
    if (($null -eq $Rows) -or ($Rows.Count -eq 0)) { return Format-CvsTableHtml -Fragment '' -Accent $Accent -EmptyText $EmptyText }
    $fragment = $Rows | ConvertTo-Html -Fragment
    return Format-CvsTableHtml -Fragment ($fragment -join "`n") -Accent $Accent -EmptyText $EmptyText
}

function New-CvsSection {
    param([string]$Title,[string]$Sub,[array]$Rows,[string]$Accent,[string]$EmptyText)
    $tbl = Convert-RowsToStyledHtml -Rows $Rows -Accent $Accent -EmptyText $EmptyText
    return @"
      <tr><td style="padding:8px 28px 4px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:$Accent;margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid $Accent;">&#9679; $Title</div>
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#6b7280;margin:6px 0 0;">$Sub</div>
        $tbl
      </td></tr>
"@
}

function Get-ShortVcName { param([string]$vCenter) if ([string]::IsNullOrWhiteSpace($vCenter)) { return '' } return ($vCenter.Trim().Split('.')[0]) }

function Test-VcenterTcp443 {
    param([string]$Server)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($Server, 443, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { Write-Log "  $Server unreachable on 443 (5s timeout) - skipping"; return $false }
        $tcp.EndConnect($iar); return $true
    } catch { Write-Log "  $Server TCP 443 test failed: $($_.Exception.Message) - skipping"; return $false }
    finally { $tcp.Close() }
}

# ---- Numeric helpers --------------------------------------------------------
function Get-Percentile {
    param([double[]]$Values,[double]$P)
    $v = @($Values | Where-Object { $_ -ne $null } | Sort-Object)
    if ($v.Count -eq 0) { return $null }
    $rank = [math]::Ceiling(($P / 100.0) * $v.Count)
    if ($rank -lt 1) { $rank = 1 }
    if ($rank -gt $v.Count) { $rank = $v.Count }
    return [double]$v[$rank - 1]
}
function Get-Max {
    param([double[]]$Values)
    $v = @($Values | Where-Object { $_ -ne $null })
    if ($v.Count -eq 0) { return $null }
    return ($v | Measure-Object -Maximum).Maximum
}

function Invoke-CvsQueryPerfSafe {
    param(
        [Parameter(Mandatory=$true)]$PerfManager,
        [Parameter(Mandatory=$true)][array]$Specs,
        [string]$Label = 'QueryPerf'
    )

    if (($null -eq $Specs) -or ($Specs.Count -eq 0)) { return @() }

    try {
        return @($PerfManager.QueryPerf($Specs))
    }
    catch {
        $msg = $_.Exception.Message

        $canSplit = ($Specs.Count -gt 1) -and (
            $msg -match 'vpxd\.stats\.maxQueryMetrics' -or
            $msg -match 'restricted by the administrator' -or
            $msg -match 'query metrics'
        )

        if (-not $canSplit) {
            Write-Log "    WARN $Label failed for $($Specs.Count) spec(s): $msg"
            return @()
        }

        $mid = [int][math]::Floor($Specs.Count / 2)
        $leftSpecs  = @($Specs[0..($mid - 1)])
        $rightSpecs = @($Specs[$mid..($Specs.Count - 1)])

        Write-Log "    WARN $Label exceeded vCenter query limit for $($Specs.Count) spec(s); retrying as $($leftSpecs.Count) + $($rightSpecs.Count)."
        return @(
            Invoke-CvsQueryPerfSafe -PerfManager $PerfManager -Specs $leftSpecs -Label $Label
            Invoke-CvsQueryPerfSafe -PerfManager $PerfManager -Specs $rightSpecs -Label $Label
        )
    }
}

if ([string]::IsNullOrWhiteSpace($MailFrom)) { $MailFrom = $env:COMPUTERNAME + 'user6@dom3.example' }
[array]$allResults = @()

Write-Log "=== $script:ReportName start (Action=$Action) ==="

if ([string]::IsNullOrEmpty($env:VC_USER) -or [string]::IsNullOrEmpty($env:VC_PASS)) {
    Write-Log "ERROR: VC_USER/VC_PASS not present in environment - vault creds not delivered by the task. Aborting."
    exit 1
}
$vcCred = [pscredential]::new($env:VC_USER,(ConvertTo-SecureString $env:VC_PASS -AsPlainText -Force))
Write-Log "Credential built for user [$($vcCred.UserName)]."

Write-Log "Loading PowerCLI module..."
if (!(Get-Module VMware.VimAutomation.Core)) { Import-Module VMware.VimAutomation.Core }
Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null
Write-Log "PowerCLI ready."

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }

# Counters we need: "group.name.rollup"
$wantCounters = @(
    'cpu.usage.average',
    'cpu.ready.summation',
    'cpu.costop.summation',
    'mem.active.average',
    'mem.consumed.average',
    'mem.vmmemctl.average',
    'mem.swapped.average'
)

$start  = (Get-Date).AddDays(-$LookbackDays)
$finish = Get-Date

foreach ($vcenter in $vCenterList.Split(',')) {
    $vcenter = $vcenter.Trim()
    if ([string]::IsNullOrWhiteSpace($vcenter)) { continue }
    Write-Log "vCenter: $vcenter"
    if (-not (Test-VcenterTcp443 -Server $vcenter)) { continue }

    try {
        Write-Log "  Connecting to $vcenter..."
        Connect-VIServer -Server $vcenter -Credential $vcCred -Force -WarningAction 0 -ErrorAction Stop | Out-Null
        $vcShort = Get-ShortVcName $vcenter
        Write-Log "  Connected. Resolving PerformanceManager and counter dictionary."

        $perfMgr = Get-View (Get-View ServiceInstance).Content.PerfManager

        # Map counter name -> id (and back)
        $counterIdByName = @{}
        $nameByCounterId = @{}
        foreach ($pc in $perfMgr.PerfCounter) {
            $full = "{0}.{1}.{2}" -f $pc.GroupInfo.Key, $pc.NameInfo.Key, $pc.RollupType
            if ($wantCounters -contains $full) {
                $counterIdByName[$full] = $pc.Key
                $nameByCounterId[$pc.Key] = $full
            }
        }
        if ($counterIdByName.Count -eq 0) { Write-Log "  WARN no matching perf counters found - skipping $vcenter"; continue }

        # Pick the enabled historical interval closest to the requested window
        $targetSec = $IntervalMins * 60
        $intervals = @($perfMgr.HistoricalInterval | Where-Object { $_.Enabled })
        if (-not $intervals) { $intervals = @($perfMgr.HistoricalInterval) }
        $interval  = $intervals | Sort-Object { [math]::Abs($_.SamplingPeriod - $targetSec) } | Select-Object -First 1
        $intervalId = [int]$interval.SamplingPeriod
        $intervalMs = [double]$intervalId * 1000.0
        Write-Log "  Perf interval: $($interval.Name) ($intervalId s)"

        # Build the reusable metricId list (aggregate instance only)
        $metricIds = @()
        foreach ($cid in $counterIdByName.Values) {
            $m = New-Object VMware.Vim.PerfMetricId
            $m.CounterId = $cid
            $m.Instance  = ''
            $metricIds  += $m
        }

        # host MoRef -> cluster name
        $hostToCluster = @{}
        foreach ($cl in (Get-View -ViewType ClusterComputeResource -Property Name,Host)) {
            foreach ($h in @($cl.Host)) { $hostToCluster[$h.Value] = $cl.Name }
        }

        # Powered-on, non-template VMs (server-side power filter)
        $vmViews = Get-View -ViewType VirtualMachine `
            -Property Name,Config.Hardware.NumCPU,Config.Hardware.MemoryMB,Config.Template,Runtime.Host `
            -Filter @{ 'Runtime.PowerState' = 'poweredOn' }
        $vmViews = @($vmViews | Where-Object { -not $_.Config.Template })

        # Optional cluster filter
        if ($ClusterFilter -ne '*') {
            $vmViews = @($vmViews | Where-Object {
                $_.Runtime.Host -and ($hostToCluster[$_.Runtime.Host.Value] -like $ClusterFilter)
            })
        }
        Write-Log "  Powered-on VMs in scope: $($vmViews.Count)"

        # MoRef.Value -> VM facts
        $vmInfo = @{}
        foreach ($v in $vmViews) {
            $clusterName = if ($v.Runtime.Host) { $hostToCluster[$v.Runtime.Host.Value] } else { '' }
            $vmInfo[$v.MoRef.Value] = [pscustomobject]@{
                Name    = $v.Name
                NumCpu  = [int]$v.Config.Hardware.NumCPU
                RamGB   = [double]([math]::Round($v.Config.Hardware.MemoryMB / 1024.0, 2))
                Cluster = $clusterName
                MoRef   = $v.MoRef
            }
        }

        # QueryPerf in chunks. Keep this low enough to stay under vCenter's vpxd.stats.maxQueryMetrics limit.
        if ($QueryVmChunkSize -lt 1) { $QueryVmChunkSize = 1 }
        $chunkSize = [int]$QueryVmChunkSize
        $metricCount = @($metricIds).Count
        $estimatedSeriesPerCall = $chunkSize * $metricCount
        Write-Log "  QueryPerf chunk size: $chunkSize VM(s) x $metricCount counter(s) = about $estimatedSeriesPerCall metric series per call."
        $vmList = @($vmViews)
        $chunkTot = [math]::Ceiling($vmList.Count / $chunkSize)
        for ($i = 0; $i -lt $vmList.Count; $i += $chunkSize) {
            $chunk = $vmList[$i..([math]::Min($i + $chunkSize - 1, $vmList.Count - 1))]
            $chunkNo = [int]($i / $chunkSize) + 1

            $specs = @()
            foreach ($v in $chunk) {
                $spec = New-Object VMware.Vim.PerfQuerySpec
                $spec.Entity     = $v.MoRef
                $spec.MetricId   = $metricIds
                $spec.IntervalId = $intervalId
                $spec.StartTime  = $start
                $spec.EndTime    = $finish
                $spec.Format     = 'normal'
                $specs += $spec
            }

            Write-Log ("    chunk {0}/{1}: QueryPerf on {2} VMs..." -f $chunkNo,$chunkTot,$chunk.Count)
            $ct0 = Get-Date
            $res = @(Invoke-CvsQueryPerfSafe -PerfManager $perfMgr -Specs $specs -Label "QueryPerf chunk $chunkNo")
            if ($res.Count -eq 0) {
                Write-Log "    WARN QueryPerf chunk $chunkNo returned no data after retry attempts."
                continue
            }
            Write-Log ("    chunk {0}/{1}: {2} entities returned in {3:n1}s" -f $chunkNo,$chunkTot,$res.Count,((Get-Date)-$ct0).TotalSeconds)

            foreach ($em in $res) {
                try {
                    $info = $vmInfo[$em.Entity.Value]
                    if (-not $info) { continue }

                    # counter name -> double[] (aggregate instance only)
                    $series = @{}
                    foreach ($v in @($em.Value)) {
                        if ($v.Id.Instance -ne '') { continue }
                        $nm = $nameByCounterId[$v.Id.CounterId]
                        if ($nm) { $series[$nm] = @($v.Value | ForEach-Object { [double]$_ }) }
                    }

                    function S([string]$name) { if ($series.ContainsKey($name)) { return $series[$name] } else { return @() } }

                    $numCpu   = $info.NumCpu
                    $cfgRamGB = $info.RamGB
                    $cfgRamKB = $cfgRamGB * 1048576.0
                    $cluster  = $info.Cluster

                    # --- CPU ---
                    $cpuVals    = S 'cpu.usage.average'                       # %
                    $sampleDays = [math]::Round(($cpuVals.Count * $intervalId) / 86400.0, 1)
                    $cpuP50 = Get-Percentile $cpuVals 50
                    $cpuP95 = Get-Percentile $cpuVals 95
                    $cpuMax = Get-Max $cpuVals

                    # per-vCPU %RDY = ready_ms / interval_ms * 100 / vCPU
                    $rdyVals = @(S 'cpu.ready.summation' | ForEach-Object { if ($numCpu -gt 0) { ($_ / $intervalMs) * 100.0 / $numCpu } })
                    $rdyP95 = Get-Percentile $rdyVals 95

                    # co-stop % (aggregate) = costop_ms / interval_ms * 100
                    $costopVals = @(S 'cpu.costop.summation' | ForEach-Object { ($_ / $intervalMs) * 100.0 })
                    $costopP95 = Get-Percentile $costopVals 95

                    # --- Memory (all KB) ---
                    $actP95KB = Get-Percentile (S 'mem.active.average') 95
                    $conP95KB = Get-Percentile (S 'mem.consumed.average') 95
                    $balMaxKB = Get-Max (S 'mem.vmmemctl.average')
                    $swpMaxKB = Get-Max (S 'mem.swapped.average')

                    $actP95GB = if ($null -ne $actP95KB) { [math]::Round($actP95KB / 1048576.0, 2) } else { $null }
                    $conP95GB = if ($null -ne $conP95KB) { [math]::Round($conP95KB / 1048576.0, 2) } else { $null }
                    $balMaxMB = if ($null -ne $balMaxKB) { [math]::Round($balMaxKB / 1024.0, 1) } else { $null }
                    $swpMaxMB = if ($null -ne $swpMaxKB) { [math]::Round($swpMaxKB / 1024.0, 1) } else { $null }
                    $actPctCfg = if (($null -ne $actP95KB) -and ($cfgRamKB -gt 0)) { [math]::Round($actP95KB / $cfgRamKB * 100.0, 1) } else { $null }

                    $lowData    = ($sampleDays -lt $MinSampleDays)
                    $hasBalloon = (($null -ne $balMaxKB) -and ($balMaxKB -gt 0))
                    $hasSwap    = (($null -ne $swpMaxKB) -and ($swpMaxKB -gt 0))

                    $base = [ordered]@{
                        vCenter=$vcShort; VM=$info.Name; Cluster=$cluster; Days=$sampleDays
                        CurVcpu=$numCpu; CpuP50=$cpuP50; CpuP95=$cpuP95; CpuMax=$cpuMax
                        RdyP95=$rdyP95; CostopP95=$costopP95
                        CurRamGB=$cfgRamGB; ActiveP95GB=$actP95GB; ActivePctCfg=$actPctCfg
                        ConsumedP95GB=$conP95GB; BalloonMaxMB=$balMaxMB; SwapMaxMB=$swpMaxMB
                        Finding=''; SuggChange=''; Evidence=''; ReclaimVcpu=0; ReclaimRamGB=0
                    }

                    # === Memory pressure (upsize / investigate) — live risk, report first ===
                    if ($hasBalloon -or $hasSwap) {
                        $why = @()
                        if ($hasSwap)    { $why += "swapped up to $swpMaxMB MB (severe)" }
                        if ($hasBalloon) { $why += "ballooned up to $balMaxMB MB" }
                        $f = [ordered]@{} + $base
                        $f.Finding='Memory pressure (upsize/investigate)'
                        $f.SuggChange='Add RAM or reduce host memory overcommit'
                        $f.Evidence=($why -join '; ')
                        $allResults += [pscustomobject]$f; continue
                    }

                    # === CPU contention (review) ===
                    if ((($null -ne $rdyP95) -and ($rdyP95 -ge $CpuReadyWarnPct)) -or
                        (($null -ne $costopP95) -and ($costopP95 -ge $CostopWarnPct))) {
                        $sev = if (($null -ne $rdyP95) -and ($rdyP95 -ge $CpuReadyCritPct)) { 'critical' } else { 'elevated' }
                        $why = @()
                        if ($null -ne $rdyP95) { $why += ("per-vCPU %RDY p95 = {0}%" -f [math]::Round($rdyP95,1)) }
                        if (($null -ne $costopP95) -and ($costopP95 -ge $CostopWarnPct)) { $why += ("co-stop p95 = {0}%" -f [math]::Round($costopP95,1)) }
                        $f = [ordered]@{} + $base
                        $f.Finding="CPU contention ($sev) - review"
                        $f.SuggChange='Investigate host oversubscription; if VM is wide, fewer vCPUs may cut co-stop'
                        $f.Evidence=($why -join '; ')
                        $allResults += [pscustomobject]$f; continue
                    }

                    # === Memory downsize ===
                    if ((-not $lowData) -and ($null -ne $actPctCfg) -and ($actPctCfg -lt $MemDownsizeP95Pct)) {
                        $suggGB = [math]::Ceiling(($actP95GB * (1 + $HeadroomPct/100.0)))
                        if ($suggGB -lt 1) { $suggGB = 1 }
                        $redGB = $cfgRamGB - $suggGB
                        $redPct = if ($cfgRamGB -gt 0) { $redGB / $cfgRamGB * 100.0 } else { 0 }
                        if (($suggGB -lt $cfgRamGB) -and ($redGB -ge $MinRamReclaimGB) -and ($redPct -ge $MinRamReclaimPct)) {
                            $f = [ordered]@{} + $base
                            $f.Finding='Memory downsize'
                            $f.SuggChange=("RAM {0} -> {1} GB (reclaim {2} GB)" -f $cfgRamGB,$suggGB,[math]::Round($redGB,0))
                            $f.Evidence=("active p95 {0} GB = {1}% of configured; no balloon/swap; +{2}% headroom" -f $actP95GB,$actPctCfg,$HeadroomPct)
                            $f.ReclaimRamGB=[math]::Round($redGB,0)
                            $allResults += [pscustomobject]$f
                        }
                    }

                    # === CPU downsize ===
                    if ((-not $lowData) -and ($numCpu -gt $MinVcpu) -and ($null -ne $cpuP95) -and ($cpuP95 -lt $CpuDownsizeP95Pct) `
                        -and (($null -eq $rdyP95) -or ($rdyP95 -lt $CpuReadyWarnPct)) `
                        -and (($null -eq $costopP95) -or ($costopP95 -lt $CostopWarnPct))) {
                        $usedCores = $numCpu * ($cpuP95 / 100.0)
                        $target = (100.0 - $HeadroomPct) / 100.0
                        $suggVcpu = [math]::Ceiling($usedCores / $target)
                        if ($suggVcpu -lt $MinVcpu) { $suggVcpu = $MinVcpu }
                        $redVcpu = $numCpu - $suggVcpu
                        if (($suggVcpu -lt $numCpu) -and ($redVcpu -ge $MinVcpuReclaim)) {
                            $f = [ordered]@{} + $base
                            $f.Finding='CPU downsize'
                            $f.SuggChange=("vCPU {0} -> {1} (reclaim {2})" -f $numCpu,$suggVcpu,$redVcpu)
                            $f.Evidence=("CPU p95 {0}% (p50 {1}%, max {2}%); %RDY/vCPU p95 {3}%; co-stop {4}%; ~{5} cores used at p95" -f `
                                [math]::Round($cpuP95,1),
                                $(if($null -ne $cpuP50){[math]::Round($cpuP50,1)}else{'n/a'}),
                                $(if($null -ne $cpuMax){[math]::Round($cpuMax,1)}else{'n/a'}),
                                $(if($null -ne $rdyP95){[math]::Round($rdyP95,1)}else{'n/a'}),
                                $(if($null -ne $costopP95){[math]::Round($costopP95,1)}else{'n/a'}),
                                [math]::Round($usedCores,1))
                            $f.ReclaimVcpu=$redVcpu
                            $allResults += [pscustomobject]$f
                        }
                    }

                    # === Low data ===
                    if ($lowData) {
                        $f = [ordered]@{} + $base
                        $f.Finding='Low data - review manually'
                        $f.SuggChange='Insufficient samples for a confident recommendation'
                        $f.Evidence=("only {0} days of usable samples (need >= {1})" -f $sampleDays,$MinSampleDays)
                        $allResults += [pscustomobject]$f
                    }
                }
                catch { Write-Log "    WARN entity skipped: $($_.Exception.Message)" }
            }
        }
    } catch {
        Write-Log "  ERROR processing $vcenter : $($_.Exception.Message)"
    } finally {
        if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
    }
}

if ($Global:DefaultVIServers.Count -gt 0) { Disconnect-VIServer * -Force -Confirm:$False }
Write-Log "Collection complete. $($allResults.Count) findings."

# ---- Tier the findings ------------------------------------------------------
$pressure = @($allResults | Where-Object { $_.Finding -like 'Memory pressure*' })
$content  = @($allResults | Where-Object { $_.Finding -like 'CPU contention*' })
$memDown  = @($allResults | Where-Object { $_.Finding -eq 'Memory downsize' } | Sort-Object -Property ReclaimRamGB -Descending)
$cpuDown  = @($allResults | Where-Object { $_.Finding -eq 'CPU downsize' } | Sort-Object -Property ReclaimVcpu -Descending)
$lowD     = @($allResults | Where-Object { $_.Finding -like 'Low data*' })

$reclaimVcpu = [int](($cpuDown | Measure-Object -Property ReclaimVcpu -Sum).Sum)
$reclaimRam  = [int](($memDown | Measure-Object -Property ReclaimRamGB -Sum).Sum)

# Column projections per tier
$rowsPressure = $pressure | Select-Object vCenter,VM,Cluster,@{n='RAM GB';e={$_.CurRamGB}},@{n='Balloon max MB';e={$_.BalloonMaxMB}},@{n='Swap max MB';e={$_.SwapMaxMB}},@{n='Active p95 GB';e={$_.ActiveP95GB}},Evidence
$rowsContent  = $content  | Select-Object vCenter,VM,Cluster,@{n='vCPU';e={$_.CurVcpu}},@{n='%RDY/vCPU p95';e={$_.RdyP95}},@{n='Co-stop p95';e={$_.CostopP95}},@{n='CPU p95';e={$_.CpuP95}},Evidence
$rowsMemDown  = $memDown  | Select-Object vCenter,VM,Cluster,@{n='Change';e={$_.SuggChange}},@{n='Active p95 GB';e={$_.ActiveP95GB}},@{n='Active % cfg';e={$_.ActivePctCfg}},@{n='Consumed p95 GB';e={$_.ConsumedP95GB}},@{n='Days';e={$_.Days}}
$rowsCpuDown  = $cpuDown  | Select-Object vCenter,VM,Cluster,@{n='Change';e={$_.SuggChange}},@{n='CPU p50';e={$_.CpuP50}},@{n='CPU p95';e={$_.CpuP95}},@{n='CPU max';e={$_.CpuMax}},@{n='%RDY/vCPU p95';e={$_.RdyP95}},@{n='Days';e={$_.Days}}
$rowsLowD     = $lowD     | Select-Object vCenter,VM,Cluster,@{n='Days';e={$_.Days}},Evidence

$alert_title = "reclaimable ~$reclaimVcpu vCPU / ~$reclaimRam GB | $($allResults.Count) findings"
$reportTime  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$secPressure = New-CvsSection -Title 'Memory pressure - UPSIZE / investigate' -Sub "$($pressure.Count) VMs where the host is reclaiming guest memory (balloon/swap). Live performance risk." -Rows $rowsPressure -Accent '#b91c1c' -EmptyText 'No ballooning or swapping detected.'
$secContent  = New-CvsSection -Title 'CPU contention - review' -Sub "$($content.Count) VMs with high CPU ready or co-stop. May be host oversubscription; verify before adding vCPUs." -Rows $rowsContent -Accent '#c2410c' -EmptyText 'No CPU contention above threshold.'
$secMemDown  = New-CvsSection -Title 'Memory downsize candidates' -Sub "$($memDown.Count) VMs holding far more RAM than the guest touches. Reclaim ~$reclaimRam GB." -Rows $rowsMemDown -Accent '#15803d' -EmptyText 'No memory downsize candidates.'
$secCpuDown  = New-CvsSection -Title 'vCPU downsize candidates' -Sub "$($cpuDown.Count) VMs with idle vCPUs and no contention. Reclaim ~$reclaimVcpu vCPUs." -Rows $rowsCpuDown -Accent '#15803d' -EmptyText 'No vCPU downsize candidates.'
$secLowD     = New-CvsSection -Title 'Low data - manual review' -Sub "$($lowD.Count) VMs with too few samples for a confident call (new/recently migrated)." -Rows $rowsLowD -Accent '#6b7280' -EmptyText 'None.'

$body = @"
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="1040" cellpadding="0" cellspacing="0" style="max-width:1040px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#1f2937;padding:20px 28px;font-family:Segoe UI,Arial,sans-serif;color:#ffffff;font-size:19px;font-weight:700;">VMware Rightsizing Report</td></tr>
      <tr><td style="padding:18px 28px 4px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:13px;line-height:1.5;">
        Window: last <b>$LookbackDays days</b> &bull; $($allResults.Count) findings across the estate.<br>
        <b>Reclaimable at p95 with $HeadroomPct% headroom: ~$reclaimVcpu vCPUs and ~$reclaimRam GB RAM.</b><br>
        Every recommendation carries its supporting evidence. All findings are candidates; verify before applying.
      </td></tr>
$secPressure
$secContent
$secMemDown
$secCpuDown
$secLowD
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
        Automated report generated by cvs_vmware_rightsizing.ps1 via Ansible &bull; $reportTime &bull; Reclaimable: ~$reclaimVcpu vCPU / ~$reclaimRam GB
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
"@

$resultFile = Join-Path $DebugDir 'result.html'
$body | Out-File -FilePath $resultFile -Encoding utf8
$csvFile = Join-Path $DebugDir 'vmware_rightsizing.csv'
$allResults | Select-Object vCenter,VM,Cluster,Days,Finding,SuggChange,Evidence,CurVcpu,CpuP50,CpuP95,CpuMax,RdyP95,CostopP95,CurRamGB,ActiveP95GB,ActivePctCfg,ConsumedP95GB,BalloonMaxMB,SwapMaxMB,ReclaimVcpu,ReclaimRamGB |
    Export-Csv -NoTypeInformation -Path $csvFile -Encoding utf8
Write-Log "Report written: $resultFile ($alert_title)"
Write-Log "CSV written: $csvFile"

if ($eMailReport -eq 'yes') {
    $mailParams = @{ SmtpServer = $SMTPServer; From = $MailFrom; To = ($MailToString -split ',').Trim(); Subject = "$MailSubjectstring | $alert_title"; Body = $body; BodyAsHtml = $true }
    if ($MailCcString) { $mailParams.Cc = ($MailCcString -split ',').Trim() }
    Send-MailMessage @mailParams
    Write-Log "Email sent to $MailToString"
}

Write-Log "=== $script:ReportName end ==="