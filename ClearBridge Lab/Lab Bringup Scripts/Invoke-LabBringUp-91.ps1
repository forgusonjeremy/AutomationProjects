# ===========================================================================
# Invoke-LabBringUp-91.ps1
# VCF 9.1 lab bring-up.
#
# Flow:
#   1. REQUIRED esx-01a..04a (TCP/443). OPTIONAL esx-05a = VCF Automation gate.
#      ESXi-direct VI connections confirm host presence only; disconnected before
#      vCenter wait.
#   2. Wait vCenter ready (TCP/443 + Get-Datacenter).
#   3. vSAN HARD GATE - do not proceed until vSAN datastore is accessible.
#   4. Cluster readiness gate - all cluster hosts Connected + PoweredOn before
#      any Start-VM is issued. Covers vCenter post-boot tasks: vSAN config,
#      HA admission control, DRS init, system VMs, plugins.
#   5. Power on $BootPlan91 in order via vCenter. Each Start-VM is retried
#      independently on transient failures (no host compatible, task failed)
#      without restarting the script.
#   6. Completion = every powered-on VM reports a non-link-local guest IP
#      via VMware Tools, polled through vCenter.
#
# No FleetOps. No installer probe. Assumes dispatcher confirmed ESXi 9.1.
# ASCII only - download this file, do not paste it.
# ===========================================================================

Set-Location -Path $PSScriptRoot

. "$PSScriptRoot\LabBringUp.config.ps1"
Import-Module "$PSScriptRoot\LabBringUp.Common.psm1" -Force
Import-LabPowerCLI
$LogFile = Initialize-LabBringUp -LogDir $LogDir -LogNamePrefix 'Lab-BringUp-91'

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
$ConfirmPreference     = "None"

Write-Log "Log file: $LogFile"

$credEsx = New-LabCredential -User $EsxiUser    -Password $EsxiPassword
$credVc  = New-LabCredential -User $VcenterUser -Password $VcenterPassword

$viservers        = @()
$vcConn           = $null
$esx05TcpPresent  = $false
$esx05ViPresent   = $false
$Esx05Present     = $false
$poweredOnTargets = @()
$completed        = $false

# ---------------------------------------------------------------------------
# Invoke-StartVmWithRetry
# Attempts Start-VM and retries on transient scheduling errors
# ("no host compatible", "task failed", "server task failed") without
# restarting the script. Non-transient errors are rethrown immediately.
# ---------------------------------------------------------------------------
function Invoke-StartVmWithRetry {
  param(
    [Parameter(Mandatory)] $VM,
    [Parameter(Mandatory)] $VcenterConnection,
    [Parameter(Mandatory)] [string] $Label,
    [int] $RetryIntervalSec = 30,
    [int] $TimeoutSec       = 600
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt  = 0

  while ((Get-Date) -lt $deadline) {
    $attempt++
    # Refresh VM object so power state and host placement are current
    $current = Get-VM -Server $VcenterConnection -Id $VM.Id -ErrorAction Stop

    if ($current.PowerState -eq 'PoweredOn') {
      Write-Log "[$Label] '$($current.Name)' is already PoweredOn (attempt $attempt)."
      return
    }

    try {
      Write-Log "[$Label] Start-VM '$($current.Name)' (attempt $attempt)..."
      Start-VM -VM $current -Server $VcenterConnection -Confirm:$false -ErrorAction Stop | Out-Null
      Write-Log "[$Label] Start-VM issued successfully for '$($current.Name)'."
      return
    } catch {
      $msg = $_.Exception.Message
      $isTransient = (
        $msg -match 'No host is compatible' -or
        $msg -match 'task failed' -or
        $msg -match 'Server task failed' -or
        $msg -match 'is not connected' -or
        $msg -match 'not enough resources' -or
        $msg -match 'timed out'
      )
      if ($isTransient) {
        $remaining = [int](($deadline - (Get-Date)).TotalSeconds)
        Write-Log "[$Label] Transient Start-VM error (attempt $attempt, ${remaining}s remaining): $msg. Retrying in ${RetryIntervalSec}s..." "WARN"
        Start-Sleep -Seconds $RetryIntervalSec
      } else {
        Write-Log "[$Label] Non-transient Start-VM error: $msg" "ERROR"
        throw
      }
    }
  }

  throw "[$Label] Start-VM for '$($VM.Name)' did not succeed within ${TimeoutSec}s."
}

try {
  Wait-ForNetwork -TimeoutSec 900 -TestHosts @("10.1.10.1") | Out-Null

  # ---------------------------------------------------------------------------
  # STEP 1 - TCP/443 gate for required ESXi hosts
  # ---------------------------------------------------------------------------
  Write-Log "Waiting for TCP/$TcpPort on REQUIRED ESXi hosts..."
  foreach ($h in $EsxiHosts) {
    while (-not (Test-TcpPort -ServerName $h -Port $TcpPort -TimeoutSec $TcpTimeoutSec)) {
      Write-Log "TCP/$TcpPort not reachable yet: $h" "WARN"
      Start-Sleep -Seconds $TcpRetryIntervalSec
    }
    Write-Log "TCP/$TcpPort reachable: $h"
  }

  # ---------------------------------------------------------------------------
  # STEP 1b - optional esx-05a TCP timebox
  # ---------------------------------------------------------------------------
  Write-Log "Checking optional host TCP/$TcpPort (timeboxed ${OptionalHostTcpWaitSec}s): $OptionalEsxiHost"
  $esx05Deadline = (Get-Date).AddSeconds($OptionalHostTcpWaitSec)
  while ((Get-Date) -lt $esx05Deadline) {
    if (Test-TcpPort -ServerName $OptionalEsxiHost -Port $TcpPort -TimeoutSec $TcpTimeoutSec) {
      Write-Log "TCP/$TcpPort reachable for optional host: $OptionalEsxiHost"
      $esx05TcpPresent = $true
      break
    }
    Start-Sleep -Seconds $TcpRetryIntervalSec
  }
  if (-not $esx05TcpPresent) {
    Write-Log "TCP/$TcpPort NOT reachable for optional host within ${OptionalHostTcpWaitSec}s. Treating as NOT deployed: $OptionalEsxiHost" "WARN"
  }

  # ---------------------------------------------------------------------------
  # STEP 1c - ESXi-direct VI connections (presence confirmation only)
  # ---------------------------------------------------------------------------
  $viservers = Connect-RequiredEsxiHosts -Hosts $EsxiHosts -Credential $credEsx -RetryIntervalSec $ViRetryIntervalSec -OverallTimeoutSec $ViOverallTimeoutSec

  # ---------------------------------------------------------------------------
  # STEP 1d - optional esx-05a VI connect
  # ---------------------------------------------------------------------------
  if ($esx05TcpPresent) {
    $optionalVi = Try-ConnectOptionalEsxiHost -hostName $OptionalEsxiHost -Credential $credEsx -TimeoutSec $OptionalHostViConnectWaitSec -RetryIntervalSec $ViRetryIntervalSec
    if ($optionalVi) {
      $viservers += $optionalVi
      $esx05ViPresent = $true
    }
  }

  $Esx05Present = ($esx05TcpPresent -and $esx05ViPresent)
  Write-Log "ESX-05 gate (no DNS): Tcp=$esx05TcpPresent Vi=$esx05ViPresent Present=$Esx05Present"
  Write-Log "ESXi-direct connections confirmed: $($viservers.Name -join ', ')"

  Write-Log "Disconnecting ESXi-direct connections. All further VM operations will use vCenter."
  $viservers | ForEach-Object { try { Disconnect-VIServer -Server $_ -Confirm:$false | Out-Null } catch {} }
  $viservers = @()

  # ---------------------------------------------------------------------------
  # STEP 2 - wait for vCenter ready (TCP + inventory)
  # ---------------------------------------------------------------------------
  Write-Log "vCenter VM expected to power on automatically. Waiting for readiness..."
  $vcConn = Wait-ForVcenterReady -Server $VcenterServer -Credential $credVc -MinRetrySec $VcenterReadyMinRetrySec -TimeoutSec $VcenterReadyTimeoutSec -PollSec $VcenterReadyPollSec -TcpTimeoutSec 5

  # ---------------------------------------------------------------------------
  # STEP 3 - vSAN HARD GATE
  # ---------------------------------------------------------------------------
  Assert-VsanClusterOnline -VcenterConnection $vcConn -ClusterName $VsanClusterNameContains -TimeoutSec $VsanOnlineTimeoutSec -PollSec $VsanOnlinePollSec

  # ---------------------------------------------------------------------------
  # STEP 4 - cluster readiness gate
  # Waits until every host in the management cluster is Connected + PoweredOn.
  # This is the signal that vCenter has finished post-boot tasks (vSAN config,
  # HA, DRS, system VMs, plugins) and the cluster will accept Start-VM.
  # ---------------------------------------------------------------------------
  Write-Log ("[ClusterReady] Waiting for all hosts in cluster matching '{0}' to be Connected + PoweredOn (timeout {1}s)..." -f $VsanClusterNameContains, $ClusterReadyTimeoutSec)
  $clusterReadyDeadline = (Get-Date).AddSeconds($ClusterReadyTimeoutSec)
  while ($true) {
    try {
      $cluster = Find-ClusterByNameContains -VcenterConnection $vcConn -NameContains $VsanClusterNameContains
      $hosts   = @(Get-VMHost -Location $cluster -Server $vcConn -ErrorAction Stop)
      $notReady = @($hosts | Where-Object {
        $_.ConnectionState -ne 'Connected' -or $_.PowerState -ne 'PoweredOn'
      })
      if ($notReady.Count -eq 0 -and $hosts.Count -gt 0) {
        Write-Log ("[ClusterReady] All {0} host(s) Connected + PoweredOn. Cluster ready." -f $hosts.Count)
        break
      }
      $notReadyNames = ($notReady | ForEach-Object {
        "{0} [{1}/{2}]" -f $_.Name, $_.ConnectionState, $_.PowerState
      }) -join ', '
      Write-Log ("[ClusterReady] {0}/{1} host(s) ready. Not ready: {2}" -f ($hosts.Count - $notReady.Count), $hosts.Count, $notReadyNames) "WARN"
    } catch {
      Write-Log ("[ClusterReady] Poll error: {0}" -f $_.Exception.Message) "WARN"
    }
    if ((Get-Date) -ge $clusterReadyDeadline) {
      throw ("[ClusterReady] Timed out after {0}s waiting for all cluster hosts to be Connected + PoweredOn." -f $ClusterReadyTimeoutSec)
    }
    Start-Sleep -Seconds $ClusterReadyPollSec
  }

  # ---------------------------------------------------------------------------
  # STEP 5 - power on boot plan via vCenter with per-VM retry
  # ---------------------------------------------------------------------------
  foreach ($step in $BootPlan91) {
    $stepLabel   = [string]$step.Label
    $stepMatch   = [string]$step.Match
    $stepPattern = [string]$step.Pattern

    if ($step.RequiresEsx05 -and -not $Esx05Present) {
      Write-Log ("Skipping step '{0}' - esx-05a not present (VCF Automation gate not satisfied)." -f $stepLabel)
      continue
    }

    Write-Log ("Resolving VMs for step '{0}' [Match={1} Pattern={2}] via vCenter" -f $stepLabel, $stepMatch, $stepPattern)

    $allVcVms = @(Get-VM -Server $vcConn -ErrorAction SilentlyContinue)
    $p = $stepPattern.Trim().ToLowerInvariant()
    $matched = @($allVcVms | Where-Object {
      $n = $_.Name.Trim().ToLowerInvariant()
      switch ($stepMatch) {
        'Exact'    { $n -eq $p }
        'Prefix'   { $n.StartsWith($p) }
        'Contains' { $n.Contains($p) }
        default    { $false }
      }
    })

    if ($matched.Count -eq 0) {
      if ($step.RequireAtLeastOne) {
        throw ("No VMs matched required step '{0}' [Match={1} Pattern={2}]." -f $stepLabel, $stepMatch, $stepPattern)
      }
      Write-Log ("No VMs matched step '{0}'. Continuing." -f $stepLabel) "WARN"
      continue
    }

    foreach ($vm in ($matched | Sort-Object Name)) {
      if ($vm.PowerState -eq 'PoweredOn') {
        Write-Log "VM '$($vm.Name)' already PoweredOn; skipping Start-VM."
        $poweredOnTargets += [pscustomobject]@{ Label=$stepLabel; VMId=$vm.Id; Name=$vm.Name }
        continue
      }
      # Retry transient failures in place - no script restart needed
      Invoke-StartVmWithRetry -VM $vm -VcenterConnection $vcConn -Label $stepLabel -RetryIntervalSec $StartVmRetryIntervalSec -TimeoutSec $StartVmTimeoutSec
      $poweredOnTargets += [pscustomobject]@{ Label=$stepLabel; VMId=$vm.Id; Name=$vm.Name }
    }

    Write-Log "Sleeping ${PostPowerOnSleepSec}s before next boot tier..."
    Start-Sleep -Seconds $PostPowerOnSleepSec
  }

  # ---------------------------------------------------------------------------
  # STEP 6 - wait for all powered-on VMs to report a guest IP via vCenter
  # ---------------------------------------------------------------------------
  Write-Log "All Start-VM calls issued ($($poweredOnTargets.Count) VMs). Waiting for guest IPs via vCenter..."

  $deadline = (Get-Date).AddSeconds($AllGuestIpTimeoutSec)
  $ipMap    = @{}
  $pending  = [System.Collections.Generic.List[object]]::new()
  $poweredOnTargets | ForEach-Object { $pending.Add($_) }

  while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
    $stillPending = [System.Collections.Generic.List[object]]::new()
    foreach ($t in $pending) {
      $ips = @()
      try {
        $v = Get-VM -Server $vcConn -Id $t.VMId -ErrorAction SilentlyContinue
        if ($v -and $v.ExtensionData.Guest.ToolsRunningStatus -eq 'guestToolsRunning') {
          $ips = @($v.Guest.IPAddress | Where-Object {
            $_ -and
            $_ -notmatch '^169\.254' -and
            $_ -ne '0.0.0.0' -and
            $_ -notmatch '^fe80:'
          })
        }
      } catch {
        Write-Log "Guest IP poll error for '$($t.Name)': $($_.Exception.Message)" "WARN"
      }
      if ($ips.Count -gt 0) {
        Write-Log "[$($t.Label)] '$($t.Name)' guest IP(s): $($ips -join ', ')"
        $ipMap[$t.Name] = $ips
      } else {
        $stillPending.Add($t)
      }
    }
    $pending = $stillPending
    if ($pending.Count -gt 0) {
      $names = @($pending | ForEach-Object { $_.Name }) -join ', '
      Write-Log "Still waiting on guest IPs for: $names"
      Start-Sleep -Seconds $GuestIpPollSec
    }
  }

  if ($pending.Count -gt 0) {
    $names = @($pending | ForEach-Object { $_.Name }) -join ', '
    throw "Guest IP not reported within ${AllGuestIpTimeoutSec}s for: $names"
  }

  # ---------------------------------------------------------------------------
  # STEP 7 - write completion marker
  # ---------------------------------------------------------------------------
  $labMode = if ($Esx05Present) { 'VCF91-MgmtDomain+Automation' } else { 'VCF91-MgmtDomain' }
  $markerLines = @(
    "LabMode: $labMode"
    "ESX05_Present: $Esx05Present"
    "LogFile: $LogFile"
    "--- Component IPs ---"
  )
  foreach ($t in $poweredOnTargets) {
    $ipStr = if ($ipMap.ContainsKey($t.Name)) { ($ipMap[$t.Name] -join ',') } else { "<none>" }
    $markerLines += ("{0} [{1}]: {2}" -f $t.Name, $t.Label, $ipStr)
  }
  Write-CompletionMarker -Path $MarkerFile -Lines $markerLines
  $completed = $true
  Write-Log "9.1 bring-up complete. All VMs reporting guest IPs."
}
catch {
  Write-Log $_.Exception.Message "ERROR"
  throw
}
finally {
  if ($vcConn) {
    Write-Log "Disconnecting from vCenter."
    try { Disconnect-VIServer -Server $vcConn -Confirm:$false | Out-Null } catch {}
  }
  if ($viservers -and $viservers.Count -gt 0) {
    Write-Log "Disconnecting remaining ESXi-direct connections."
    $viservers | ForEach-Object { try { Disconnect-VIServer -Server $_ -Confirm:$false | Out-Null } catch {} }
  }
  if ($completed) {
    Remove-LabScheduledTask -TaskName $ScheduledTaskName
  } else {
    Write-Log "Run did not complete; leaving scheduled task '$ScheduledTaskName' in place for retry." "WARN"
  }
  Write-Log "Done."
}
