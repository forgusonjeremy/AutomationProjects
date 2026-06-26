# ===========================================================================
# Invoke-LabBringUp-90.ps1
# VCF 9.0 lab bring-up. Behavior preserved from the original single-file
# script; all functions now come from LabBringUp.Common.psm1.
#
# Auto-detected use cases:
#   1. VCF Installer walkthrough (installer HTTP 2xx) -> marker, exit.
#   2. Management Domain (installer absent, esx-05a absent).
#   3. + VCF Automation (installer absent, esx-05a present) -> FleetOps power-on.
#
# Assumes the dispatcher already confirmed ESXi 9.0.
# ===========================================================================

Set-Location -Path $PSScriptRoot

. "$PSScriptRoot\LabBringUp.config.ps1"
Import-Module "$PSScriptRoot\LabBringUp.Common.psm1" -Force
Import-LabPowerCLI
$LogFile = Initialize-LabBringUp -LogDir $LogDir -LogNamePrefix 'Lab-BringUp-90'

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
$ConfirmPreference     = "None"

Write-Log "Log file: $LogFile"

$credEsx = New-LabCredential -User $EsxiUser     -Password $EsxiPassword
$credVc  = New-LabCredential -User $VcenterUser  -Password $VcenterPassword

$viservers              = @()
$vcConn                 = $null
$esx05TcpPresent        = $false
$esx05ViPresent         = $false
$Esx05Present           = $false
$FleetOpsPowerOnSuccess = $false
$DetectedLabMode        = $null
$completed              = $false

try {
  Wait-ForNetwork -TimeoutSec 900 -TestHosts @("10.1.10.1") | Out-Null

  # STEP 1 — required ESXi hosts TCP/443
  Write-Log "Waiting for TCP/$TcpPort on REQUIRED ESXi hosts..."
  foreach ($h in $EsxiHosts) {
    while (-not (Test-TcpPort -ServerName $h -Port $TcpPort -TimeoutSec $TcpTimeoutSec)) {
      Write-Log "TCP/$TcpPort not reachable yet: $h" "WARN"
      Start-Sleep -Seconds $TcpRetryIntervalSec
    }
    Write-Log "TCP/$TcpPort reachable: $h"
  }

  # STEP 2 — auto-detect: VCF Installer probe
  Write-Log "--- Auto-detecting lab mode ---"
  $vcfInstallerOnline = Wait-ForVcfInstallerOnline `
    -Fqdn       $VcfInstallerFqdn `
    -Path       $VcfInstallerPath `
    -TimeoutSec $VcfInstallerProbeSec `
    -PollSec    5 `
    -HttpTimeout 10

  if ($vcfInstallerOnline) {
    # USE CASE 1
    $DetectedLabMode = 'VCFInstaller'
    Write-Log "=== USE CASE 1 — VCF Installer Walkthrough ==="
    Write-CompletionMarker -Path $MarkerFile -Lines @(
      "LabMode: $DetectedLabMode"
      "ESX05_Present: $false"
      "FleetOpsPowerOnSuccess: $false"
      "LogFile: $LogFile"
    )
    $completed = $true
    Write-Log "Use Case 1 complete. Exiting."
  }
  else {
    Write-Log "VCF Installer not detected. Continuing with Management Domain bring-up..."

    # STEP 3 — optional esx-05a TCP timebox
    Write-Log "Checking optional host TCP/$TcpPort (timeboxed ${OptionalHostTcpWaitSec}s): $OptionalEsxiHost"
    $esx05Deadline = (Get-Date).AddSeconds($OptionalHostTcpWaitSec)
    while ((Get-Date) -lt $esx05Deadline) {
      if (Test-TcpPort -ServerName $OptionalEsxiHost -Port $TcpPort -TimeoutSec $TcpTimeoutSec) {
        Write-Log "TCP/$TcpPort reachable for optional host: $OptionalEsxiHost"
        $esx05TcpPresent = $true; break
      }
      Start-Sleep -Seconds $TcpRetryIntervalSec
    }
    if (-not $esx05TcpPresent) {
      Write-Log "TCP/$TcpPort NOT reachable for optional host within ${OptionalHostTcpWaitSec}s. Treating as NOT deployed: $OptionalEsxiHost" "WARN"
    }

    # STEP 4 — connect required ESXi hosts
    $viservers = Connect-RequiredEsxiHosts -Hosts $EsxiHosts -Credential $credEsx `
      -RetryIntervalSec $ViRetryIntervalSec -OverallTimeoutSec $ViOverallTimeoutSec

    # STEP 5 — optional esx-05a VI connect
    if ($esx05TcpPresent) {
      $optionalVi = Try-ConnectOptionalEsxiHost -hostName $OptionalEsxiHost -Credential $credEsx `
        -TimeoutSec $OptionalHostViConnectWaitSec -RetryIntervalSec $ViRetryIntervalSec
      if ($optionalVi) { $viservers += $optionalVi; $esx05ViPresent = $true }
    }
    $Esx05Present = ($esx05TcpPresent -and $esx05ViPresent)

    if ($Esx05Present) { $DetectedLabMode = 'VCFAutomation'; Write-Log "=== USE CASE 3 — VCF Automation Deployment ===" }
    else               { $DetectedLabMode = 'MgmtDomain';    Write-Log "=== USE CASE 2 — VCF Management Domain Deployment ===" }
    Write-Log "ESX-05 presence (no DNS): Tcp=$esx05TcpPresent Vi=$esx05ViPresent => Present=$Esx05Present"
    Write-Log "Connected ESXi-direct VIServers: $($viservers.Name -join ', ')"

    # STEP 6/7 — vCenter auto-starts; wait for ready
    Write-Log "vCenter VM expected to power on automatically. Waiting for readiness..."
    $vcConn = Wait-ForVcenterReady -Server $VcenterServer -Credential $credVc `
      -MinRetrySec $VcenterReadyMinRetrySec -TimeoutSec $VcenterReadyTimeoutSec `
      -PollSec $VcenterReadyPollSec -TcpTimeoutSec 5

    # STEP 8 — vSAN online (soft, original behavior)
    Bring-VsanClusterOnline -VcenterConnection $vcConn -ClusterName $VsanClusterName `
      -TimeoutSec $VsanOnlineTimeoutSec -PollSec $VsanOnlinePollSec

    # STEP 9 — power on post-vCenter VMs
    foreach ($step in $BootPlan90) {
      Write-Log "Locating VM for step '$($step.Label)' (candidates: $($step.Names -join ', '))"
      $found = Find-VMByAnyName -CandidateNames $step.Names -Servers $viservers
      if (-not $found) { throw "VM not found for step '$($step.Label)'. Looked for: $($step.Names -join ', ')" }
      $vm = Refresh-VMExactOnServer -Server $found.Server -Name ([string]$found.Name) -Context ("BootStep:" + $step.Label)
      if ($vm.PowerState -eq "PoweredOn") {
        Write-Log "VM '$($vm.Name)' already PoweredOn; skipping Start-VM."
      } else {
        Write-Log "Powering on VM '$($vm.Name)' on '$($found.Server.Name)'"
        Start-VM -VM $vm -Confirm:$false | Out-Null
      }
      Write-Log "Sleeping ${PostPowerOnSleepSec}s before next step..."
      Start-Sleep -Seconds $PostPowerOnSleepSec
    }

    # STEP 10 — FleetOps power-on for VCF Automation (Use Case 3 only)
    if ($Esx05Present) {
      Write-Log "ESX-05 present; FleetOps power-on for VCF Automation '$vcfAutomationFqdn'"
      $auth = New-FleetOpsAuthHeaderValue -Username $fleetOpsUsername -Password $fleetOpsPassword
      $envResponse = Get-FleetOpsEnvironmentsWithRetry -FleetOpsFqdn $fleetOpsFqdn `
        -AuthorizationHeaderValue $auth -RetryIntervalSec 30 -TimeoutSec 600

      $environments = if ($envResponse.Content -is [System.Array]) { $envResponse.Content } else { @($envResponse.Content) }
      $matchedEnvId = $null; $matchedProdId = $null
      foreach ($environment in $environments) {
        if (-not $environment.products) { continue }
        foreach ($product in $environment.products) {
          if (-not $product.clusterVIP -or -not $product.clusterVIP.clusterVips) { continue }
          foreach ($clusterVip in $product.clusterVIP.clusterVips) {
            $hn = $clusterVip.properties.hostName
            if ($hn -and $hn.Trim().ToLower() -eq $vcfAutomationFqdn.Trim().ToLower()) {
              $matchedEnvId = $environment.environmentId; $matchedProdId = $product.id
              Write-Log "Match: environmentId='$matchedEnvId', productId='$matchedProdId', hostName='$hn'"
              break
            }
          }
          if ($matchedEnvId) { break }
        }
        if ($matchedEnvId) { break }
      }
      if (-not $matchedEnvId -or -not $matchedProdId) {
        throw "No environment/product match for VCF Automation hostName '$vcfAutomationFqdn'"
      }

      $powerOnUrl = "/lcm/lcops/api/v2/environments/${matchedEnvId}/products/${matchedProdId}/power-on"
      $powerOnResponse = Invoke-FleetOpsRestCall -FleetOpsFqdn $fleetOpsFqdn -FleetOpsApiUrl $powerOnUrl `
        -AuthorizationHeaderValue $auth -RestMethod "POST" -SkipCertificateCheck

      if ($powerOnResponse.Success -and $powerOnResponse.StatusCode -eq 200) {
        $FleetOpsPowerOnSuccess = $true
        Write-Log "Fleet Ops power-on succeeded. HTTP 200"
      } else {
        $sc = if ($null -ne $powerOnResponse.StatusCode) { $powerOnResponse.StatusCode } else { "<no status>" }
        $st = if ($powerOnResponse.StatusDescription) { $powerOnResponse.StatusDescription } else { "<no status text>" }
        Write-Log "Fleet Ops power-on FAILED: HTTP $sc $st" "ERROR"
        if ($powerOnResponse.RawContent)       { Write-Log "Body: $($powerOnResponse.RawContent)" "ERROR" }
        if ($powerOnResponse.ExceptionMessage) { Write-Log "Exception: $($powerOnResponse.ExceptionMessage)" "ERROR" }
        throw "Fleet Ops power-on did not succeed; refusing to write completion marker."
      }
    } else {
      Write-Log "ESX-05 not present; skipping Fleet Ops power-on."
    }

    # STEP 11 — completion marker
    Write-CompletionMarker -Path $MarkerFile -Lines @(
      "LabMode: $DetectedLabMode"
      "ESX05_Present: $Esx05Present"
      "FleetOpsPowerOnSuccess: $FleetOpsPowerOnSuccess"
      "LogFile: $LogFile"
    )
    $completed = $true
    Write-Log "Power-on sequence completed successfully."
  }
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
    Write-Log "Disconnecting from ESXi hosts."
    $viservers | ForEach-Object { try { Disconnect-VIServer -Server $_ -Confirm:$false | Out-Null } catch {} }
  }
  if ($completed) { Remove-LabScheduledTask -TaskName $ScheduledTaskName }
  else { Write-Log "Run did not complete; leaving scheduled task '$ScheduledTaskName' in place for retry." "WARN" }
  Write-Log "Done."
}
