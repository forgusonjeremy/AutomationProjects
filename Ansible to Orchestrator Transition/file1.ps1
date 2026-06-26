# ---------------------------------------------------------------------------
# Lab / VCF 9 bring-up (ESXi-direct -> vCenter) PowerCLI script with file logging
# + completion marker file (no DNS-based existence checks)
#
# AUTO-DETECTED LAB USE CASES
# The script probes the network after required ESXi hosts are confirmed reachable
# and selects one of three operating modes automatically:
#
# USE CASE 1 — VCF INSTALLER WALKTHROUGH
#   Trigger : vcfinstaller.site-a.vcf.lab returns HTTP 2xx on
#             https://vcfinstaller.site-a.vcf.lab/vcf-installer-ui/login
#   Behavior: Confirm ESX 01-04 TCP/443 reachable, write completion marker, EXIT.
#             vCenter power-on and VM boot sequence are NOT performed.
#
# USE CASE 2 — VCF MANAGEMENT DOMAIN DEPLOYMENT
#   Trigger : VCF Installer probe fails/times-out AND ESX-05 is NOT reachable.
#   Behavior: Wait for vCenter, bring vSAN online, power on NSX / FleetOps /
#             Ops / OpsProxy / SDDCManager, write completion marker.
#
# USE CASE 3 — VCF AUTOMATION DEPLOYMENT (add-on to Use Case 2)
#   Trigger : VCF Installer probe fails/times-out AND ESX-05 IS reachable.
#   Behavior: Everything in Use Case 2, then Fleet Ops REST call to power on
#             VCF Automation.  Completion marker written only after HTTP 200.
#
# PROBE ORDER
#   1. Wait for required ESXi hosts (TCP/443)
#   2. Check VCF Installer HTTP endpoint   ← Use Case 1 branches off here
#   3. Wait for vCenter ready              ← Use Cases 2 & 3 continue from here
#
# COMPLETION MARKER RULES
# 1) Use Case 1  : Marker created after ESX 01-04 confirmed reachable.
# 2) Use Case 2  : Marker created after VMs are powered on in vCenter.
# 3) Use Case 3  : Marker created only after VMs are powered on AND Fleet Ops
#                  power-on action for VCF Automation succeeds (HTTP 200).
#
# "ESX-05 exists" determination (NO DNS):
# - ESX-05 is considered "present" only if it becomes TCP/443 reachable within
#   the optional TCP wait window AND Connect-VIServer succeeds within the
#   optional VI wait window.  Otherwise treated as not deployed.
#
# Logs + marker file:
# C:\Lab-Initialization\logs\Lab-BringUp_yyyyMMdd_HHmmss.log
# C:\Lab-Initialization\logs\Lab-Bringup-Complete.txt
# ---------------------------------------------------------------------------

Set-Location -Path $PSScriptRoot

# ---------------------------
# CONFIG
# ---------------------------
$EsxiHosts = @(
  "esx-01a.site-a.vcf.lab",
  "esx-02a.site-a.vcf.lab",
  "esx-03a.site-a.vcf.lab",
  "esx-04a.site-a.vcf.lab"
)

$OptionalEsxiHost              = "esx-05a.site-a.vcf.lab"

# Optional host timeboxes
$OptionalHostTcpWaitSec        = 120
$OptionalHostViConnectWaitSec  = 180

$VcenterServer   = "vc-mgmt-a.site-a.vcf.lab"
$VcenterUser     = "administrator@vsphere.local"
$VcenterPassword = "VMware123!VMware123!"       # CHANGE if different

$VsanClusterName = "mgmt-cl01"                  # CHANGE if different

$fleetOpsUsername  = "admin@local"
$fleetOpsPassword  = "VMware123!VMware123!"     # CHANGE if different
$fleetOpsFqdn      = "fleetops-a.site-a.vcf.lab"
$vcfAutomationFqdn = "auto-a.site-a.vcf.lab"

# ---------------------------------------------------------------------------
# VCF Installer probe settings (Use Case 1)
# The script performs an HTTPS GET against this URL after ESXi hosts are
# confirmed reachable.  Any HTTP 2xx response is treated as "online".
# Self-signed certificates are accepted (same handling as FleetOps calls).
# If the probe does not return 2xx within $VcfInstallerProbeSec seconds the
# installer is considered absent and the script continues with Use Case 2/3.
# ---------------------------------------------------------------------------
$VcfInstallerFqdn    = "vcfinstaller.site-a.vcf.lab"
$VcfInstallerPath    = "/vcf-installer-ui/login"
$VcfInstallerProbeSec = 30   # How long (total) to wait for an HTTP 2xx response

$BootPlanAfterVcenter = @(
  @{ Label="nsx-mgmt-01a";  Names=@("nsx-mgmt-01a") },
  @{ Label="fleetops-a";    Names=@("fleetops-a") },
  @{ Label="ops-a";         Names=@("ops-a") },
  @{ Label="opsproxy-01a";  Names=@("opsproxy-01a") },
  @{ Label="sddcmanager-a"; Names=@("sddcmanager-a") }
)

# Connection retry behavior
$TcpPort             = 443
$TcpTimeoutSec       = 3
$TcpRetryIntervalSec = 10

$ViRetryIntervalSec  = 10
$ViOverallTimeoutSec = 3600

# VM behavior
$PostPowerOnSleepSec = 30

# Embedded lab credentials (ESXi direct)
$EsxiUser     = "root"
$EsxiPassword = "VMware123!VMware123!"

# vCenter readiness / vSAN verification timeouts
$VcenterReadyTimeoutSec = 1800
$VcenterReadyPollSec    = 10

$VsanOnlineTimeoutSec   = 1200
$VsanOnlinePollSec      = 10

# Fleet Ops environment lookup retry behavior
$FleetOpsEnvLookupRetryIntervalSec = 30
$FleetOpsEnvLookupTimeoutSec       = 600

# ---------------------------
# MODULE CHECK / IMPORT
# ---------------------------
if (-not (Get-Module -ListAvailable -Name VCF.PowerCLI)) {
  throw "VCF.PowerCLI is not installed or not discoverable. Install/repair it, then retry."
}
Import-Module VCF.PowerCLI -ErrorAction Stop

if (-not (Get-Module -ListAvailable -Name VMware.VimAutomation.Core)) {
  throw "VMware.VimAutomation.Core (PowerCLI core) is not installed. Install VMware.PowerCLI or ensure dependencies are present."
}
Import-Module VMware.VimAutomation.Core -ErrorAction Stop

if (Get-Module -ListAvailable -Name VMware.VimAutomation.Storage) {
  try { Import-Module VMware.VimAutomation.Storage -ErrorAction Stop } catch {}
}

# ------------------------------------------------------
# PowerCLI session config (scheduled-task safe)
# ------------------------------------------------------
Set-PowerCLIConfiguration -Scope Session `
  -InvalidCertificateAction Ignore `
  -ParticipateInCEIP:$false `
  -Confirm:$false | Out-Null

# ------------------------------------------------------
# Ensure TLS is usable for any HTTP probes (best-effort)
# ------------------------------------------------------
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {}
try {
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
} catch {}

# ---------------------------
# LOGGING SETUP
# ---------------------------
$ScriptDir  = "C:\Lab-Initialization"
$LogDir     = Join-Path $ScriptDir "logs"
if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }

$LogFile    = Join-Path $LogDir ("Lab-BringUp_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))
$MarkerFile = Join-Path $LogDir "Lab-Bringup-Complete.txt"

# Resolve the real Connect-VIServer cmdlet from VMware.VimAutomation.Core
$script:ConnectViCmd = Get-Command Connect-VIServer -All |
  Where-Object { $_.CommandType -eq 'Cmdlet' -and $_.Source -eq 'VMware.VimAutomation.Core' } |
  Select-Object -First 1
if (-not $script:ConnectViCmd) {
  throw "Could not resolve VMware.VimAutomation.Core Connect-VIServer cmdlet in this session."
}

# ---------------------------
# FUNCTIONS
# ---------------------------
function Write-Log {
  param(
    [Parameter(Mandatory)] [string] $Message,
    [ValidateSet("INFO","WARN","ERROR","DEBUG")] [string] $Level = "INFO"
  )
  $ts   = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  $line = "[$ts][$Level] $Message"
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {
    Write-Host "[$ts][WARN] Failed to write to log file '$LogFile': $($_.Exception.Message)"
  }
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory)] [string] $ServerName,
    [int] $Port       = 443,
    [int] $TimeoutSec = 3
  )
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar    = $client.BeginConnect($ServerName, $Port, $null, $null)
    $ok     = $iar.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($TimeoutSec), $false)
    if (-not $ok) { $client.Close(); return $false }
    $client.EndConnect($iar) | Out-Null
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Wait-ForNetwork {
  param(
    [int]      $TimeoutSec = 600,
    [int]      $PollSec    = 5,
    [string[]] $TestHosts  = @("10.1.10.1")
  )

  $deadline    = (Get-Date).AddSeconds($TimeoutSec)
  $attempt     = 0
  $nextVerbose = Get-Date

  Write-Log "[Wait-ForNetwork] Starting network readiness checks. Timeout=${TimeoutSec}s Poll=${PollSec}s TestHosts=$($TestHosts -join ', ')"

  while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
      $upAdapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up'
      if (-not $upAdapters) {
        if ((Get-Date) -ge $nextVerbose) {
          Write-Log "[Wait-ForNetwork] Attempt ${attempt}: No physical NIC is Up yet. Waiting ${PollSec}s..."
          $nextVerbose = (Get-Date).AddSeconds(30)
        }
        Start-Sleep -Seconds $PollSec
        continue
      }

      $ipv4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -and $_.IPAddress -notlike '169.254*' -and $_.PrefixOrigin -ne 'WellKnown' }

      if (-not $ipv4) {
        if ((Get-Date) -ge $nextVerbose) {
          Write-Log "[Wait-ForNetwork] Attempt ${attempt}: NIC Up, but no usable IPv4 yet. Waiting ${PollSec}s..."
          $nextVerbose = (Get-Date).AddSeconds(30)
        }
        Start-Sleep -Seconds $PollSec
        continue
      }

      $defaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' } |
        Select-Object -First 1

      if (-not $defaultRoute) {
        if ((Get-Date) -ge $nextVerbose) {
          Write-Log "[Wait-ForNetwork] Attempt ${attempt}: IPv4 present, but no default route yet. Waiting ${PollSec}s..."
          $nextVerbose = (Get-Date).AddSeconds(30)
        }
        Start-Sleep -Seconds $PollSec
        continue
      }

      if ((Get-Date) -ge $nextVerbose) {
        $adaptersStr = ($upAdapters | Select-Object -ExpandProperty Name) -join ', '
        $ipsStr      = ($ipv4 | Select-Object -ExpandProperty IPAddress) -join ', '
        Write-Log "[Wait-ForNetwork] Attempt ${attempt}: NIC Up ($adaptersStr), IPv4=$ipsStr, NextHop=$($defaultRoute.NextHop). Testing reachability..."
        $nextVerbose = (Get-Date).AddSeconds(30)
      }

      foreach ($h in $TestHosts) {
        if (Test-Connection -ComputerName $h -Count 1 -Quiet -ErrorAction SilentlyContinue) {
          Write-Log "[Wait-ForNetwork] Network ready. Reachability PASSED to '$h'."
          return $true
        }
      }
    }
    catch {
      Write-Log "[Wait-ForNetwork] Attempt ${attempt}: Exception during network checks: $($_.Exception.Message)" "WARN"
    }

    Start-Sleep -Seconds $PollSec
  }

  throw "[Wait-ForNetwork] Network not ready after ${TimeoutSec}s."
}

function Wait-Tcp443RequiredAndOptional {
  param(
    [Parameter(Mandatory)] [string[]] $RequiredHosts,
    [Parameter(Mandatory)] [string]   $OptionalHost,
    [int] $OptionalTimeoutSec = 120
  )

  Write-Log "Waiting for TCP/$TcpPort on REQUIRED ESXi hosts..."
  foreach ($h in $RequiredHosts) {
    while (-not (Test-TcpPort -ServerName $h -Port $TcpPort -TimeoutSec $TcpTimeoutSec)) {
      Write-Log "TCP/$TcpPort not reachable yet: $h" "WARN"
      Start-Sleep -Seconds $TcpRetryIntervalSec
    }
    Write-Log "TCP/$TcpPort reachable: $h"
  }

  Write-Log "Checking optional host TCP/$TcpPort (timeboxed to ${OptionalTimeoutSec}s): $OptionalHost"
  $deadline = (Get-Date).AddSeconds($OptionalTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -ServerName $OptionalHost -Port $TcpPort -TimeoutSec $TcpTimeoutSec) {
      Write-Log "TCP/$TcpPort reachable for optional host: $OptionalHost"
      return $true
    }
    Start-Sleep -Seconds $TcpRetryIntervalSec
  }

  Write-Log "TCP/$TcpPort NOT reachable for optional host within ${OptionalTimeoutSec}s. Treating as NOT deployed: $OptionalHost" "WARN"
  return $false
}

# ---------------------------------------------------------------------------
# Test-VcfInstallerOnline
#
# Performs a single HTTPS GET to https://<fqdn><path> using HttpClient with
# certificate validation disabled (self-signed cert safe).
#
# Returns $true  if the server responds with any HTTP 2xx status code.
# Returns $false on connection failure, timeout, or non-2xx response.
# ---------------------------------------------------------------------------
function Test-VcfInstallerOnline {
  param(
    [Parameter(Mandatory)] [string] $Fqdn,
    [Parameter(Mandatory)] [string] $Path,
    [int] $TimeoutSec = 10
  )

  $url     = "https://$Fqdn$Path"
  $handler = $null
  $client  = $null

  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    try { $handler.CheckCertificateRevocationList = $false } catch {}

    try {
      $handler.SslProtocols =
        [System.Security.Authentication.SslProtocols]::Tls12 -bor
        [System.Security.Authentication.SslProtocols]::Tls13
    } catch {
      try { $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12 } catch {}
    }

    $handler.ServerCertificateCustomValidationCallback =
      [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator

    $client         = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)

    $request = [System.Net.Http.HttpRequestMessage]::new(
      [System.Net.Http.HttpMethod]::Get,
      $url
    )
    try {
      $request.Version       = [System.Version]::new(1, 1)
      $request.VersionPolicy = [System.Net.Http.HttpVersionPolicy]::RequestVersionOrLower
    } catch {}

    $response   = $client.SendAsync($request).GetAwaiter().GetResult()
    $statusCode = [int]$response.StatusCode
    $is2xx      = ($statusCode -ge 200 -and $statusCode -lt 300)

    Write-Log "[Test-VcfInstallerOnline] GET $url -> HTTP $statusCode (2xx=$is2xx)"
    return $is2xx
  }
  catch {
    $ex    = $_.Exception
    $inner = $ex.InnerException
    $msg   = $ex.Message
    if ($inner) { $msg += " | $($inner.Message)" }
    Write-Log "[Test-VcfInstallerOnline] GET $url failed: $msg" "WARN"
    return $false
  }
  finally {
    try { if ($client)  { $client.Dispose()  } } catch {}
    try { if ($handler) { $handler.Dispose() } } catch {}
  }
}

# ---------------------------------------------------------------------------
# Wait-ForVcfInstallerOnline
#
# Polls Test-VcfInstallerOnline until a 2xx is received or the timebox
# expires.  Returns $true (online) or $false (not detected within window).
# ---------------------------------------------------------------------------
function Wait-ForVcfInstallerOnline {
  param(
    [Parameter(Mandatory)] [string] $Fqdn,
    [Parameter(Mandatory)] [string] $Path,
    [int] $TimeoutSec  = 600,
    [int] $PollSec     = 10,
    [int] $HttpTimeout = 10
  )
  Write-Log "[VcfInstaller] Probing https://$Fqdn$Path for HTTP 2xx (timebox=${TimeoutSec}s)..."
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -ServerName $Fqdn -Port 443 -TimeoutSec 3) {
      if (Test-VcfInstallerOnline -Fqdn $Fqdn -Path $Path -TimeoutSec $HttpTimeout) {
        Write-Log "[VcfInstaller] VCF Installer endpoint is ONLINE."; return $true
      }
    }
    $remaining = [int](($deadline - (Get-Date)).TotalSeconds)
    Write-Log "[VcfInstaller] Not ready yet. Retrying... (${remaining}s remaining)" "WARN"
    Start-Sleep -Seconds $PollSec
  }
  Write-Log "[VcfInstaller] No HTTP 2xx within ${TimeoutSec}s. Treating as absent." "WARN"; return $false
}

function Connect-EsxiHostOnce {
  param(
    [Parameter(Mandatory)] [string]       $ServerName,
    [Parameter(Mandatory)] [pscredential] $Credential
  )

  $ServerName = ([string]$ServerName).Trim()
  if ([string]::IsNullOrWhiteSpace($ServerName)) { throw "Connect-EsxiHostOnce received empty ServerName." }

  $params = @{
    Server      = @([string]$ServerName)
    Credential  = $Credential
    Force       = $true
    ErrorAction = 'Stop'
  }

  $vi = & $script:ConnectViCmd @params
  Get-VMHost -Server $vi -Name $ServerName -ErrorAction Stop | Out-Null
  return $vi
}

function Connect-RequiredEsxiHosts {
  param(
    [Parameter(Mandatory)] [string[]]     $Hosts,
    [Parameter(Mandatory)] [pscredential] $Credential
  )

  $connected = @()
  $sw = [Diagnostics.Stopwatch]::StartNew()

  foreach ($h in $Hosts) {
    while ($true) {
      if ($ViOverallTimeoutSec -gt 0 -and $sw.Elapsed.TotalSeconds -gt $ViOverallTimeoutSec) {
        throw "Timed out after ${ViOverallTimeoutSec}s waiting for required VIServer connections."
      }

      try {
        Write-Log "Connecting to REQUIRED ESXi host via Connect-VIServer: $h"
        $vi = Connect-EsxiHostOnce -ServerName $h -Credential $Credential
        $connected += $vi
        Write-Log "Connected: $h"
        break
      } catch {
        Write-Log "Connect-VIServer failed for ${h}: $($_.Exception.Message)" "WARN"
        Start-Sleep -Seconds $ViRetryIntervalSec
      }
    }
  }

  return $connected
}

function Try-ConnectOptionalEsxiHost {
  param(
    [Parameter(Mandatory)] [string]       $hostName,
    [Parameter(Mandatory)] [pscredential] $Credential,
    [int] $TimeoutSec = 180
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      Write-Log "Connecting to OPTIONAL ESXi host via Connect-VIServer: $hostName"
      $vi = Connect-EsxiHostOnce -ServerName $hostName -Credential $Credential
      Write-Log "Connected OPTIONAL host: $hostName"
      return $vi
    } catch {
      Write-Log "Connect-VIServer failed for optional host ${hostName}: $($_.Exception.Message)" "WARN"
      Start-Sleep -Seconds $ViRetryIntervalSec
    }
  }

  Write-Log "Optional host VIServer connect did not succeed within ${TimeoutSec}s. Treating as NOT deployed: $hostName" "WARN"
  return $null
}

function Get-VMExactOnServer {
  param(
    [Parameter(Mandatory)] $Server,
    [Parameter(Mandatory)] [string] $Name
  )

  $n = $Name.Trim()
  if ([string]::IsNullOrWhiteSpace($n)) { return @() }

  $exact = @(Get-VM -Server $Server -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $n })
  if ($exact.Count -gt 0) { return $exact }

  $all = @(Get-VM -Server $Server -ErrorAction SilentlyContinue)
  @($all | Where-Object { $_.Name -and $_.Name.Trim().ToLowerInvariant() -eq $n.ToLowerInvariant() })
}

function Find-VMByAnyName {
  param(
    [Parameter(Mandatory)] [string[]] $CandidateNames,
    [Parameter(Mandatory)] $Servers
  )

  foreach ($nRaw in $CandidateNames) {
    $n = ([string]$nRaw).Trim()
    if ([string]::IsNullOrWhiteSpace($n)) { continue }

    $hits = @()
    foreach ($srv in @($Servers)) {
      $m = Get-VMExactOnServer -Server $srv -Name $n
      foreach ($vm in $m) {
        $hits += [pscustomobject]@{
          VM     = $vm
          Server = $srv
          Name   = $vm.Name
          VMHost = $vm.VMHost
        }
      }
    }

    if ($hits.Count -eq 1) { return $hits[0] }

    if ($hits.Count -gt 1) {
      $detail = $hits | Select-Object Name, @{N="Server";E={$_.Server.Name}}, VMHost |
        Format-Table -AutoSize | Out-String
      throw "VM name '$n' matched multiple VMs across connected ESXi hosts. Refine lookup.`n$detail"
    }
  }

  return $null
}

function Wait-ForExactVmName {
  param(
    [Parameter(Mandatory)] [string] $ExactName,
    [Parameter(Mandatory)] $Servers,
    [int]    $TimeoutSec = 900,
    [int]    $PollSec    = 10,
    [string] $Label      = "VM"
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $found = Find-VMByAnyName -CandidateNames @($ExactName) -Servers $Servers
      if ($found) {
        Write-Log "[$Label] Found exact VM name '$($found.Name)' on '$($found.Server.Name)'."
        return $found
      }
      Write-Log "[$Label] Exact name '$ExactName' not visible yet. Waiting..." "INFO"
    } catch {
      Write-Log "[$Label] Lookup failed: $($_.Exception.Message)" "WARN"
    }
    Start-Sleep -Seconds $PollSec
  }

  throw "[$Label] Timed out after ${TimeoutSec}s waiting for '$ExactName'."
}

function Refresh-VMExactOnServer {
  param(
    [Parameter(Mandatory)] $Server,
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [string] $Context
  )

  $vmMatches = Get-VMExactOnServer -Server $Server -Name $Name
  if ($vmMatches.Count -ne 1) {
    $detail = $vmMatches | Select-Object Name, Id, PowerState, VMHost | Format-Table -AutoSize | Out-String
    throw "[$Context] Expected exactly 1 VM named '$Name' on '$($Server.Name)' but got $($vmMatches.Count).`n$detail"
  }
  return $vmMatches[0]
}

function Wait-ForVcenterReady {
  param(
    [Parameter(Mandatory)] [string]       $Server,
    [Parameter(Mandatory)] [pscredential] $Credential,
    [int] $MinRetrySec   = 600,
    [int] $TimeoutSec    = 1800,
    [int] $PollSec       = 10,
    [int] $TcpTimeoutSec = 5
  )

  $start    = Get-Date
  $minUntil = $start.AddSeconds($MinRetrySec)
  $deadline = $start.AddSeconds($TimeoutSec)

  Write-Log "[Wait-ForVcenterReady] Server=$Server MinRetrySec=${MinRetrySec}s TimeoutSec=${TimeoutSec}s PollSec=${PollSec}s"

  while ((Get-Date) -lt $deadline) {
    if (-not (Test-TcpPort -ServerName $Server -Port 443 -TimeoutSec $TcpTimeoutSec)) {
      Start-Sleep -Seconds $PollSec
      continue
    }

    $vc = $null
    try {
      Write-Log "[Wait-ForVcenterReady] TCP/443 reachable. Connecting via Connect-VIServer..." "INFO"
      $vc = & $script:ConnectViCmd -Server $Server -Credential $Credential -Force -ErrorAction Stop
      Get-Datacenter -Server $vc -ErrorAction Stop | Select-Object -First 1 | Out-Null
      Write-Log "[Wait-ForVcenterReady] vCenter READY." "INFO"
      return $vc
    }
    catch {
      Write-Log "[Wait-ForVcenterReady] Connect/inventory failed: $($_.Exception.Message)" "WARN"
      if ($vc) { try { Disconnect-VIServer -Server $vc -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }
      Start-Sleep -Seconds $PollSec
      continue
    }
  }

  throw "[Wait-ForVcenterReady] Timed out after ${TimeoutSec}s waiting for vCenter readiness: $Server"
}

function Bring-VsanClusterOnline {
  param(
    [Parameter(Mandatory)] $VcenterConnection,
    [Parameter(Mandatory)] [string] $ClusterName,
    [int] $TimeoutSec  = 600,
    [int] $PollSec     = 15
  )

  Write-Log "[Bring-VsanClusterOnline] Starting vSAN cluster services on '$ClusterName'..."

  # Retry Start-VsanCluster until vsanHealth endpoint is available
  $deadline       = (Get-Date).AddSeconds($TimeoutSec)
  $startIssued    = $false

  while ((Get-Date) -lt $deadline) {
    if (-not $startIssued) {
      try {
        Get-Cluster -Name $ClusterName -Server $VcenterConnection -ErrorAction Stop |
          Start-VsanCluster -ErrorAction Stop
        Write-Log "[Bring-VsanClusterOnline] Start-VsanCluster issued successfully."
        $startIssued = $true
      } catch {
        if ($_.Exception.Message -match 'vsanHealth|unavailable|endpoint') {
          Write-Log "[Bring-VsanClusterOnline] vsanHealth service not ready yet. Retrying in ${PollSec}s..." "WARN"
          Start-Sleep -Seconds $PollSec
          continue
        } else {
          Write-Log "[Bring-VsanClusterOnline] Start-VsanCluster failed: $($_.Exception.Message)" "WARN"
          $startIssued = $true  # non-transient error, stop retrying
        }
      }
    }

    # Poll for vSAN datastore accessibility once start has been issued
    if ($startIssued) {
      $cluster = Get-Cluster -Name $ClusterName -Server $VcenterConnection -ErrorAction SilentlyContinue

      $vsanDatastores = @()
      if ($cluster) {
        $vsanDatastores = @(
          Get-Datastore -Server $VcenterConnection -RelatedObject $cluster -ErrorAction SilentlyContinue |
            Where-Object { $_.Type -eq 'vsan' }
        )
      }

      $accessibleVsan = @(
        $vsanDatastores | Where-Object {
          $_.State -eq 'Available' -and $_.ExtensionData.Summary.Accessible -eq $true
        }
      )

      if ($accessibleVsan.Count -gt 0) {
        $dsNames = ($accessibleVsan | Select-Object -ExpandProperty Name) -join ', '
        Write-Log "[Bring-VsanClusterOnline] vSAN datastore accessible ($dsNames). Cluster storage online."
        return
      }

      Write-Log "[Bring-VsanClusterOnline] vSAN datastore not accessible yet (vsan=$($vsanDatastores.Count), accessible=$($accessibleVsan.Count))..." "INFO"
    }

    Start-Sleep -Seconds $PollSec
  }

  Write-Log "[Bring-VsanClusterOnline] WARNING: vSAN datastore did not become accessible within ${TimeoutSec}s. Continuing bring-up." "WARN"
}

function New-FleetOpsAuthHeaderValue {
  param(
    [Parameter(Mandatory)] [string]$Username,
    [Parameter(Mandatory)] [string]$Password
  )
  $plainText = '{0}:{1}' -f $Username, $Password
  $bytes     = [System.Text.Encoding]::UTF8.GetBytes($plainText)
  $base64    = [System.Convert]::ToBase64String($bytes)
  return "Basic $base64"
}

function Invoke-FleetOpsRestCall {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $FleetOpsFqdn,
    [Parameter(Mandatory)] [string] $FleetOpsApiUrl,
    [Parameter(Mandatory)] [string] $AuthorizationHeaderValue,
    [Parameter(Mandatory)] [ValidateSet('GET','POST','PUT','PATCH','DELETE')] [string] $RestMethod,
    [Parameter()] [object] $RestBody,
    [Parameter()] [switch] $SkipCertificateCheck,
    [Parameter()] [int]    $TimeoutSec = 180
  )

  $fullUrl = "https://$FleetOpsFqdn$FleetOpsApiUrl"
  Write-Log "Calling Fleet Ops API: $RestMethod $fullUrl"

  $handler = $null
  $client  = $null

  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    try { $handler.CheckCertificateRevocationList = $false } catch {}

    try {
      $handler.SslProtocols =
        [System.Security.Authentication.SslProtocols]::Tls12 -bor
        [System.Security.Authentication.SslProtocols]::Tls13
    } catch {
      try { $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12 } catch {}
    }

    if ($SkipCertificateCheck) {
      $handler.ServerCertificateCustomValidationCallback =
        [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
    }

    $client         = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)

    $request = [System.Net.Http.HttpRequestMessage]::new(
      [System.Net.Http.HttpMethod]::new($RestMethod),
      $fullUrl
    )

    try {
      $request.Version       = [System.Version]::new(1,1)
      $request.VersionPolicy = [System.Net.Http.HttpVersionPolicy]::RequestVersionOrLower
    } catch {}

    $request.Headers.TryAddWithoutValidation("Authorization", $AuthorizationHeaderValue) | Out-Null
    $request.Headers.TryAddWithoutValidation("Accept", "application/json") | Out-Null

    if ($null -ne $RestBody -and $RestMethod -notin @('GET','DELETE')) {
      $bodyString      = if ($RestBody -is [string]) { $RestBody } else { ($RestBody | ConvertTo-Json -Depth 20) }
      $request.Content = [System.Net.Http.StringContent]::new($bodyString, [System.Text.Encoding]::UTF8, "application/json")
    }

    $response = $client.SendAsync($request).GetAwaiter().GetResult()

    $raw = $null
    try { $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } catch {}

    $content = $null
    if ($raw) {
      try { $content = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $content = $raw }
    }

    return [pscustomobject]@{
      Success           = $response.IsSuccessStatusCode
      StatusCode        = [int]$response.StatusCode
      StatusDescription = [string]$response.ReasonPhrase
      Content           = $content
      RawContent        = $raw
      Url               = $fullUrl
      ExceptionMessage  = $null
    }
  }
  catch {
    $ex    = $_.Exception
    $inner = $ex.InnerException
    return [pscustomobject]@{
      Success           = $false
      StatusCode        = $null
      StatusDescription = $null
      Content           = $null
      RawContent        = $null
      Url               = $fullUrl
      ExceptionMessage  = @(
        "EX: $($ex.GetType().FullName): $($ex.Message)"
        $(if ($inner) { "INNER: $($inner.GetType().FullName): $($inner.Message)" })
        "TOSTRING: $($ex.ToString())"
      ) -join " | "
    }
  }
  finally {
    try { if ($client)  { $client.Dispose()  } } catch {}
    try { if ($handler) { $handler.Dispose() } } catch {}
  }
}

function Get-FleetOpsEnvironmentsWithRetry {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $FleetOpsFqdn,
    [Parameter(Mandatory)] [string] $AuthorizationHeaderValue,
    [int] $RetryIntervalSec = 30,
    [int] $TimeoutSec       = 600
  )

  $apiPath  = "/lcm/lcops/api/v2/environments"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt  = 0

  while ((Get-Date) -lt $deadline) {
    $attempt++
    Write-Log "[FleetOps] Environment lookup attempt ${attempt}..."

    $response = Invoke-FleetOpsRestCall `
      -FleetOpsFqdn             $FleetOpsFqdn `
      -FleetOpsApiUrl           $apiPath `
      -AuthorizationHeaderValue $AuthorizationHeaderValue `
      -RestMethod               "GET" `
      -SkipCertificateCheck

    if ($response.Success -and $response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $response.Content) {
      Write-Log "[FleetOps] Successfully retrieved environments. HTTP $($response.StatusCode)"
      return $response
    }

    $statusCode = $response.StatusCode
    if ($statusCode -eq 401) { throw "[FleetOps] Authentication failed (401) retrieving environments." }
    if ($statusCode -eq 403) { throw "[FleetOps] Authorization failed (403) retrieving environments." }

    if ($null -ne $statusCode) {
      Write-Log "[FleetOps] HTTP $statusCode retrieving environments. Retrying in ${RetryIntervalSec}s..." "WARN"
    } else {
      Write-Log "[FleetOps] Request failed before HTTP status: $($response.ExceptionMessage). Retrying in ${RetryIntervalSec}s..." "WARN"
    }

    Start-Sleep -Seconds $RetryIntervalSec
  }

  throw "[FleetOps] Timed out after ${TimeoutSec}s waiting for GET /lcm/lcops/api/v2/environments to succeed."
}

function Write-CompletionMarker {
  param(
    [Parameter(Mandatory)] [string] $Path,
    [Parameter(Mandatory)] [string] $LabMode,
    [Parameter(Mandatory)] [bool]   $Esx05Present,
    [Parameter(Mandatory)] [bool]   $FleetOpsPowerOnSuccess,
    [Parameter(Mandatory)] [string] $LogFilePath
  )

  $content = @(
    "Completed: $(Get-Date -Format o)"
    "LabMode: $LabMode"
    "ESX05_Present: $Esx05Present"
    "FleetOpsPowerOnSuccess: $FleetOpsPowerOnSuccess"
    "LogFile: $LogFilePath"
  ) -join [Environment]::NewLine

  Set-Content -Path $Path -Value $content -Encoding UTF8 -Force
  Write-Log "Created completion marker: $Path"
}

# ---------------------------
# MAIN
# ---------------------------
Write-Log "Log file: $LogFile"
Write-Log ("[DEBUG] Using Connect-VIServer: {0}\{1} v{2}" -f $script:ConnectViCmd.Source, $script:ConnectViCmd.Name, $script:ConnectViCmd.Version) "DEBUG"

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
$ConfirmPreference     = "None"

$securePassEsx = ConvertTo-SecureString -String $EsxiPassword -AsPlainText -Force
$credEsx       = New-Object System.Management.Automation.PSCredential ($EsxiUser, $securePassEsx)

$securePassVc = ConvertTo-SecureString -String $VcenterPassword -AsPlainText -Force
$credVc       = New-Object System.Management.Automation.PSCredential ($VcenterUser, $securePassVc)

$viservers              = @()
$vcConn                 = $null
$esx05TcpPresent        = $false
$esx05ViPresent         = $false
$Esx05Present           = $false
$FleetOpsPowerOnSuccess = $false
$DetectedLabMode        = $null   # Set during auto-detection: 'VCFInstaller', 'MgmtDomain', 'VCFAutomation'

try {
  # Best-effort network readiness
  Wait-ForNetwork -TimeoutSec 900 -TestHosts @("10.1.10.1") | Out-Null

  # ===========================================================================
  # STEP 1 — TCP checks for REQUIRED ESXi hosts (all three use cases need this)
  # The optional ESX-05 TCP check is deferred until after the installer probe
  # so that Use Case 1 can exit early without touching ESX-05 at all.
  # ===========================================================================
  Write-Log "Waiting for TCP/$TcpPort on REQUIRED ESXi hosts..."
  foreach ($h in $EsxiHosts) {
    while (-not (Test-TcpPort -ServerName $h -Port $TcpPort -TimeoutSec $TcpTimeoutSec)) {
      Write-Log "TCP/$TcpPort not reachable yet: $h" "WARN"
      Start-Sleep -Seconds $TcpRetryIntervalSec
    }
    Write-Log "TCP/$TcpPort reachable: $h"
  }

  # ===========================================================================
  # STEP 2 — AUTO-DETECT LAB MODE: probe VCF Installer endpoint
  #
  # This probe runs AFTER the required ESXi hosts are confirmed up and BEFORE
  # any vCenter readiness check, per the stated requirement.
  #
  # If the installer responds with HTTP 2xx  → Use Case 1 (VCF Installer)
  # Otherwise                               → Use Case 2 or 3 (Mgmt / Automation)
  # ===========================================================================
  Write-Log "--- Auto-detecting lab mode ---"
  $vcfInstallerOnline = Wait-ForVcfInstallerOnline `
    -Fqdn       $VcfInstallerFqdn `
    -Path       $VcfInstallerPath `
    -TimeoutSec $VcfInstallerProbeSec `
    -PollSec    5 `
    -HttpTimeout 10

  if ($vcfInstallerOnline) {
    # =========================================================================
    # USE CASE 1 — VCF INSTALLER WALKTHROUGH
    # ESXi 01-04 already confirmed reachable above.  Write marker and exit.
    # =========================================================================
    $DetectedLabMode = 'VCFInstaller'
    Write-Log "=== Lab mode detected: USE CASE 1 — VCF Installer Walkthrough ==="
    Write-Log "VCF Installer is online and ESX hosts 01-04 are confirmed reachable."

    Write-CompletionMarker `
      -Path                  $MarkerFile `
      -LabMode               $DetectedLabMode `
      -Esx05Present          $false `
      -FleetOpsPowerOnSuccess $false `
      -LogFilePath           $LogFile

    Write-Log "Use Case 1 complete. Exiting."
  }
  else {
    # =========================================================================
    # USE CASE 2 or 3 — Management Domain / VCF Automation
    # Continue with optional ESX-05 probe, vCenter wait, and VM power-on.
    # =========================================================================
    Write-Log "VCF Installer not detected. Continuing with Management Domain bring-up..."

    # -------------------------------------------------------------------------
    # STEP 3 — TCP check for optional ESX-05
    # -------------------------------------------------------------------------
    Write-Log "Checking optional host TCP/$TcpPort (timeboxed to ${OptionalHostTcpWaitSec}s): $OptionalEsxiHost"
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

    # -------------------------------------------------------------------------
    # STEP 4 — Connect to required ESXi hosts (VI layer)
    # -------------------------------------------------------------------------
    $viservers = Connect-RequiredEsxiHosts -Hosts $EsxiHosts -Credential $credEsx

    # -------------------------------------------------------------------------
    # STEP 5 — Optional ESX-05 VI connect (only if TCP indicated presence)
    # -------------------------------------------------------------------------
    $optionalVi = $null
    if ($esx05TcpPresent) {
      $optionalVi = Try-ConnectOptionalEsxiHost `
        -hostName   $OptionalEsxiHost `
        -Credential $credEsx `
        -TimeoutSec $OptionalHostViConnectWaitSec
      if ($optionalVi) {
        $viservers      += $optionalVi
        $esx05ViPresent  = $true
      }
    }

    $Esx05Present = ($esx05TcpPresent -and $esx05ViPresent)

    if ($Esx05Present) {
      $DetectedLabMode = 'VCFAutomation'
      Write-Log "=== Lab mode detected: USE CASE 3 — VCF Automation Deployment ==="
    } else {
      $DetectedLabMode = 'MgmtDomain'
      Write-Log "=== Lab mode detected: USE CASE 2 — VCF Management Domain Deployment ==="
    }

    Write-Log "ESX-05 presence result (no DNS): TcpPresent=$esx05TcpPresent ViPresent=$esx05ViPresent => Present=$Esx05Present"
    Write-Log "Connected ESXi-direct VIServers: $($viservers.Name -join ', ')"

    # -------------------------------------------------------------------------
    # STEP 6 — vCenter VM expected to auto-start; skip manual power-on.
    # -------------------------------------------------------------------------
    Write-Log "vCenter VM expected to power on automatically with ESXi hosts. Skipping manual power-on."

    # -------------------------------------------------------------------------
    # STEP 7 — Wait for vCenter ready
    # -------------------------------------------------------------------------
    $vcConn = Wait-ForVcenterReady `
      -Server        $VcenterServer `
      -Credential    $credVc `
      -MinRetrySec   600 `
      -TimeoutSec    $VcenterReadyTimeoutSec `
      -PollSec       $VcenterReadyPollSec `
      -TcpTimeoutSec 5

    # -------------------------------------------------------------------------
    # STEP 8 — Bring vSAN online before powering on remaining VMs
    # -------------------------------------------------------------------------
    Bring-VsanClusterOnline `
      -VcenterConnection $vcConn `
      -ClusterName       $VsanClusterName `
      -TimeoutSec        $VsanOnlineTimeoutSec `
      -PollSec           $VsanOnlinePollSec

    # -------------------------------------------------------------------------
    # STEP 9 — Power on post-vCenter VMs (both Use Cases 2 and 3)
    # -------------------------------------------------------------------------
    foreach ($step in $BootPlanAfterVcenter) {
      $label = $step.Label
      $names = $step.Names

      Write-Log "Locating VM for step '$label' (candidates: $($names -join ', '))"
      $found = Find-VMByAnyName -CandidateNames $names -Servers $viservers
      if (-not $found) { throw "VM not found for step '$label'. Looked for: $($names -join ', ')" }

      $vmServer = $found.Server
      $vmName   = [string]$found.Name
      $vm       = Refresh-VMExactOnServer -Server $vmServer -Name $vmName -Context ("BootStep:" + $label)

      if ($vm.PowerState -eq "PoweredOn") {
        Write-Log "VM '$vmName' already PoweredOn; skipping Start-VM."
      } else {
        Write-Log "Powering on VM '$vmName' on '$($vmServer.Name)'"
        Start-VM -VM $vm -Confirm:$false | Out-Null
        Write-Log "Start-VM issued for '$vmName'."
      }

      Write-Log "Sleeping ${PostPowerOnSleepSec}s before next step..."
      Start-Sleep -Seconds $PostPowerOnSleepSec
    }

    # -------------------------------------------------------------------------
    # STEP 10 — Fleet Ops power-on for VCF Automation (Use Case 3 only)
    # -------------------------------------------------------------------------
    if ($Esx05Present) {
      Write-Log "ESX-05 is present; performing Fleet Ops power-on for VCF Automation '$vcfAutomationFqdn'"

      $authorizationHeaderValue = New-FleetOpsAuthHeaderValue `
        -Username $fleetOpsUsername `
        -Password $fleetOpsPassword

      $envResponse = Get-FleetOpsEnvironmentsWithRetry `
        -FleetOpsFqdn             $fleetOpsFqdn `
        -AuthorizationHeaderValue $authorizationHeaderValue `
        -RetryIntervalSec         $FleetOpsEnvLookupRetryIntervalSec `
        -TimeoutSec               $FleetOpsEnvLookupTimeoutSec

      $environments = @()
      if ($envResponse.Content -is [System.Array]) {
        $environments = $envResponse.Content
      } else {
        $environments = @($envResponse.Content)
      }

      $matchedEnvironmentId = $null
      $matchedProductId     = $null

      foreach ($environment in $environments) {
        if (-not $environment.products) { continue }

        foreach ($product in $environment.products) {
          if (-not $product.clusterVIP -or -not $product.clusterVIP.clusterVips) { continue }

          foreach ($clusterVip in $product.clusterVIP.clusterVips) {
            $hostName = $clusterVip.properties.hostName
            if ($hostName -and $hostName.Trim().ToLower() -eq $vcfAutomationFqdn.Trim().ToLower()) {
              $matchedEnvironmentId = $environment.environmentId
              $matchedProductId     = $product.id
              Write-Log "Match found. environmentId='$matchedEnvironmentId', productId='$matchedProductId', hostName='$hostName'"
              break
            }
          }
          if ($matchedEnvironmentId) { break }
        }
        if ($matchedEnvironmentId) { break }
      }

      if (-not $matchedEnvironmentId -or -not $matchedProductId) {
        throw "No environment/product match found for VCF Automation hostName '$vcfAutomationFqdn'"
      }

      $fleetOpsApiUrl = "/lcm/lcops/api/v2/environments/${matchedEnvironmentId}/products/${matchedProductId}/power-on"

      $powerOnResponse = Invoke-FleetOpsRestCall `
        -FleetOpsFqdn             $fleetOpsFqdn `
        -FleetOpsApiUrl           $fleetOpsApiUrl `
        -AuthorizationHeaderValue $authorizationHeaderValue `
        -RestMethod               "POST" `
        -SkipCertificateCheck

      if ($powerOnResponse.Success -and $powerOnResponse.StatusCode -eq 200) {
        $FleetOpsPowerOnSuccess = $true
        Write-Log "Fleet Ops power-on succeeded. HTTP 200"
      } else {
        $FleetOpsPowerOnSuccess = $false
        $statusCode = if ($null -ne $powerOnResponse.StatusCode) { $powerOnResponse.StatusCode } else { "<no status>" }
        $statusText = if ($powerOnResponse.StatusDescription)    { $powerOnResponse.StatusDescription } else { "<no status text>" }

        Write-Log "Fleet Ops power-on FAILED: HTTP $statusCode $statusText" "ERROR"
        if ($powerOnResponse.RawContent)       { Write-Log "Fleet Ops power-on response body: $($powerOnResponse.RawContent)" "ERROR" }
        if ($powerOnResponse.ExceptionMessage) { Write-Log "Fleet Ops power-on exception: $($powerOnResponse.ExceptionMessage)" "ERROR" }

        throw "Fleet Ops power-on did not succeed; refusing to write completion marker."
      }
    }
    else {
      Write-Log "ESX-05 not present; skipping Fleet Ops power-on for VCF Automation."
    }

    # -------------------------------------------------------------------------
    # STEP 11 — Completion marker (Use Cases 2 and 3)
    # -------------------------------------------------------------------------
    Write-CompletionMarker `
      -Path                  $MarkerFile `
      -LabMode               $DetectedLabMode `
      -Esx05Present          $Esx05Present `
      -FleetOpsPowerOnSuccess $FleetOpsPowerOnSuccess `
      -LogFilePath           $LogFile

    Write-Log "Power-on sequence completed successfully. Exiting."
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
    $viservers | ForEach-Object {
      try { Disconnect-VIServer -Server $_ -Confirm:$false | Out-Null } catch {}
    }
  }

  Write-Log "Done."
  schtasks /Delete /TN "\Lab-Power-On" /F | Out-Null
}