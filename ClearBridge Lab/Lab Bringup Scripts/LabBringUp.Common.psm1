# ===========================================================================
# LabBringUp.Common.psm1
# Shared functions for VCF lab bring-up (9.0 and 9.1).
#
# Module-scoped state (set by Initialize-LabBringUp):
#   $script:LogFile        - active log file path
#   $script:ConnectViCmd   - resolved VMware.VimAutomation.Core Connect-VIServer
#
# Typical load order in a calling script:
#   . "$PSScriptRoot\LabBringUp.config.ps1"
#   Import-Module "$PSScriptRoot\LabBringUp.Common.psm1" -Force
#   Import-LabPowerCLI
#   $LogFile = Initialize-LabBringUp -LogDir $LogDir -LogNamePrefix 'Lab-BringUp-91'
# ===========================================================================

# ---------------------------------------------------------------------------
# Session / state bootstrap
# ---------------------------------------------------------------------------
function Import-LabPowerCLI {
  [CmdletBinding()] param()
  if (-not (Get-Module -ListAvailable -Name VCF.PowerCLI)) {
    throw "VCF.PowerCLI is not installed or not discoverable. Install/repair it, then retry."
  }
  Import-Module VCF.PowerCLI -ErrorAction Stop
  if (-not (Get-Module -ListAvailable -Name VMware.VimAutomation.Core)) {
    throw "VMware.VimAutomation.Core (PowerCLI core) is not installed."
  }
  Import-Module VMware.VimAutomation.Core -ErrorAction Stop
  if (Get-Module -ListAvailable -Name VMware.VimAutomation.Storage) {
    try { Import-Module VMware.VimAutomation.Storage -ErrorAction Stop } catch {}
  }
  Set-PowerCLIConfiguration -Scope Session `
    -InvalidCertificateAction Ignore `
    -ParticipateInCEIP:$false `
    -Confirm:$false | Out-Null
}

function Initialize-LabBringUp {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $LogDir,
    [string] $LogNamePrefix = 'Lab-BringUp'
  )
  if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
  $script:LogFile = Join-Path $LogDir ("{0}_{1}.log" -f $LogNamePrefix, (Get-Date -Format "yyyyMMdd_HHmmss"))

  $script:ConnectViCmd = Get-Command Connect-VIServer -All |
    Where-Object { $_.CommandType -eq 'Cmdlet' -and $_.Source -eq 'VMware.VimAutomation.Core' } |
    Select-Object -First 1
  if (-not $script:ConnectViCmd) {
    throw "Could not resolve VMware.VimAutomation.Core Connect-VIServer cmdlet. Call Import-LabPowerCLI first."
  }

  # Best-effort TLS for any HTTP probes (9.0 FleetOps / installer)
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
  } catch {}
  try { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } } catch {}

  return $script:LogFile
}

function New-LabCredential {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $User,
    [Parameter(Mandatory)] [string] $Password
  )
  $sec = ConvertTo-SecureString -String $Password -AsPlainText -Force
  return New-Object System.Management.Automation.PSCredential ($User, $sec)
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Write-Log {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $Message,
    [ValidateSet("INFO","WARN","ERROR","DEBUG")] [string] $Level = "INFO"
  )
  $ts   = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  $line = "[$ts][$Level] $Message"
  Write-Host $line
  if ($script:LogFile) {
    try { Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 } catch {
      Write-Host "[$ts][WARN] Failed to write to log file '$($script:LogFile)': $($_.Exception.Message)"
    }
  }
}

# ---------------------------------------------------------------------------
# Connectivity primitives
# ---------------------------------------------------------------------------
function Test-TcpPort {
  [CmdletBinding()]
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
  } catch { return $false }
}

function Wait-ForNetwork {
  [CmdletBinding()]
  param(
    [int]      $TimeoutSec = 600,
    [int]      $PollSec    = 5,
    [string[]] $TestHosts  = @("10.1.10.1")
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt  = 0
  Write-Log "[Wait-ForNetwork] Starting network readiness checks. Timeout=${TimeoutSec}s TestHosts=$($TestHosts -join ', ')"
  while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
      $upAdapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up'
      if (-not $upAdapters) { Start-Sleep -Seconds $PollSec; continue }
      $ipv4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -and $_.IPAddress -notlike '169.254*' -and $_.PrefixOrigin -ne 'WellKnown' }
      if (-not $ipv4) { Start-Sleep -Seconds $PollSec; continue }
      $defaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' } | Select-Object -First 1
      if (-not $defaultRoute) { Start-Sleep -Seconds $PollSec; continue }
      foreach ($h in $TestHosts) {
        if (Test-Connection -ComputerName $h -Count 1 -Quiet -ErrorAction SilentlyContinue) {
          Write-Log "[Wait-ForNetwork] Network ready. Reachability PASSED to '$h'."
          return $true
        }
      }
    } catch {
      Write-Log "[Wait-ForNetwork] Attempt ${attempt}: $($_.Exception.Message)" "WARN"
    }
    Start-Sleep -Seconds $PollSec
  }
  throw "[Wait-ForNetwork] Network not ready after ${TimeoutSec}s."
}

# ---------------------------------------------------------------------------
# ESXi-direct connection
# ---------------------------------------------------------------------------
function Connect-EsxiHostOnce {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string]       $ServerName,
    [Parameter(Mandatory)] [pscredential] $Credential
  )
  $ServerName = ([string]$ServerName).Trim()
  if ([string]::IsNullOrWhiteSpace($ServerName)) { throw "Connect-EsxiHostOnce received empty ServerName." }
  $params = @{ Server = @([string]$ServerName); Credential = $Credential; Force = $true; ErrorAction = 'Stop' }
  $vi = & $script:ConnectViCmd @params
  Get-VMHost -Server $vi -Name $ServerName -ErrorAction Stop | Out-Null
  return $vi
}

function Connect-RequiredEsxiHosts {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string[]]     $Hosts,
    [Parameter(Mandatory)] [pscredential] $Credential,
    [int] $RetryIntervalSec  = 10,
    [int] $OverallTimeoutSec = 3600
  )
  $connected = @()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  foreach ($h in $Hosts) {
    while ($true) {
      if ($OverallTimeoutSec -gt 0 -and $sw.Elapsed.TotalSeconds -gt $OverallTimeoutSec) {
        throw "Timed out after ${OverallTimeoutSec}s waiting for required VIServer connections."
      }
      try {
        Write-Log "Connecting to REQUIRED ESXi host: $h"
        $vi = Connect-EsxiHostOnce -ServerName $h -Credential $Credential
        $connected += $vi
        Write-Log "Connected: $h"
        break
      } catch {
        Write-Log "Connect-VIServer failed for ${h}: $($_.Exception.Message)" "WARN"
        Start-Sleep -Seconds $RetryIntervalSec
      }
    }
  }
  return $connected
}

function Try-ConnectOptionalEsxiHost {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string]       $hostName,
    [Parameter(Mandatory)] [pscredential] $Credential,
    [int] $TimeoutSec       = 180,
    [int] $RetryIntervalSec = 10
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      Write-Log "Connecting to OPTIONAL ESXi host: $hostName"
      $vi = Connect-EsxiHostOnce -ServerName $hostName -Credential $Credential
      Write-Log "Connected OPTIONAL host: $hostName"
      return $vi
    } catch {
      Write-Log "Connect-VIServer failed for optional host ${hostName}: $($_.Exception.Message)" "WARN"
      Start-Sleep -Seconds $RetryIntervalSec
    }
  }
  Write-Log "Optional host VI connect did not succeed within ${TimeoutSec}s. Treating as NOT deployed: $hostName" "WARN"
  return $null
}

# ---------------------------------------------------------------------------
# Version detection (dispatcher)
# ---------------------------------------------------------------------------
function Get-EsxiVersionFromAnyHost {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string[]]     $EsxiHosts,
    [Parameter(Mandatory)] [pscredential] $Credential,
    [int] $TcpPort       = 443,
    [int] $TcpTimeoutSec = 3
  )
  foreach ($h in $EsxiHosts) {
    if (-not (Test-TcpPort -ServerName $h -Port $TcpPort -TimeoutSec $TcpTimeoutSec)) {
      Write-Log "[VersionDetect] TCP/$TcpPort not reachable, skipping: $h" "WARN"; continue
    }
    $vi = $null
    try {
      $vi  = Connect-EsxiHostOnce -ServerName $h -Credential $Credential
      $vmh = Get-VMHost -Server $vi -ErrorAction Stop | Select-Object -First 1
      $ver = [version]$vmh.ExtensionData.Config.Product.Version
      Write-Log "[VersionDetect] $h reports ESXi $ver (build $($vmh.Build))"
      return [pscustomobject]@{
        Version    = $ver
        MajorMinor = ('{0}.{1}' -f $ver.Major, $ver.Minor)
        Build      = $vmh.Build
        SourceHost = $h
      }
    } catch {
      Write-Log "[VersionDetect] Failed on ${h}: $($_.Exception.Message)" "WARN"
    } finally {
      if ($vi) { Disconnect-VIServer -Server $vi -Confirm:$false -ErrorAction SilentlyContinue | Out-Null }
    }
  }
  throw "[VersionDetect] Could not determine ESXi version from any provided host."
}

# ---------------------------------------------------------------------------
# vCenter readiness
# ---------------------------------------------------------------------------
function Wait-ForVcenterReady {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string]       $Server,
    [Parameter(Mandatory)] [pscredential] $Credential,
    [int] $MinRetrySec   = 600,
    [int] $TimeoutSec    = 1800,
    [int] $PollSec       = 10,
    [int] $TcpTimeoutSec = 5
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Write-Log "[Wait-ForVcenterReady] Server=$Server TimeoutSec=${TimeoutSec}s PollSec=${PollSec}s"
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-TcpPort -ServerName $Server -Port 443 -TimeoutSec $TcpTimeoutSec)) {
      Start-Sleep -Seconds $PollSec; continue
    }
    $vc = $null
    try {
      Write-Log "[Wait-ForVcenterReady] TCP/443 reachable. Connecting..."
      $vc = & $script:ConnectViCmd -Server $Server -Credential $Credential -Force -ErrorAction Stop
      Get-Datacenter -Server $vc -ErrorAction Stop | Select-Object -First 1 | Out-Null
      Write-Log "[Wait-ForVcenterReady] vCenter READY."
      return $vc
    } catch {
      Write-Log "[Wait-ForVcenterReady] Connect/inventory failed: $($_.Exception.Message)" "WARN"
      if ($vc) { try { Disconnect-VIServer -Server $vc -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }
      Start-Sleep -Seconds $PollSec
    }
  }
  throw "[Wait-ForVcenterReady] Timed out after ${TimeoutSec}s waiting for vCenter readiness: $Server"
}

# ---------------------------------------------------------------------------
# Cluster lookup by substring (case-insensitive contains match)
# ---------------------------------------------------------------------------
function Find-ClusterByNameContains {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] $VcenterConnection,
    [Parameter(Mandatory)] [string] $NameContains
  )
  $pattern  = $NameContains.Trim().ToLowerInvariant()
  $clusters = @(Get-Cluster -Server $VcenterConnection -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.Trim().ToLowerInvariant().Contains($pattern) })
  if ($clusters.Count -eq 0) {
    $all = (@(Get-Cluster -Server $VcenterConnection -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)) -join ', '
    throw "No cluster found whose name contains '$NameContains'. Clusters visible: $all"
  }
  if ($clusters.Count -gt 1) {
    $names = ($clusters | Select-Object -ExpandProperty Name) -join ', '
    throw "Multiple clusters match '$NameContains': $names. Refine VsanClusterNameContains in config."
  }
  Write-Log ("[Find-ClusterByNameContains] Matched cluster '{0}' using pattern '{1}'." -f $clusters[0].Name, $NameContains)
  return $clusters[0]
}

# ---------------------------------------------------------------------------
# vSAN: soft (9.0, warn-continue) and hard (9.1, throw) variants
# ---------------------------------------------------------------------------
function Invoke-VsanStartCore {
  param($VcenterConnection, [string]$ClusterName, [int]$TimeoutSec, [int]$PollSec)
  # ClusterName is a substring pattern; resolved via Find-ClusterByNameContains.
  # Returns $true if vSAN datastore became accessible within timeout, else $false.
  $deadline    = (Get-Date).AddSeconds($TimeoutSec)
  $startIssued = $false
  while ((Get-Date) -lt $deadline) {
    if (-not $startIssued) {
      try {
        Find-ClusterByNameContains -VcenterConnection $VcenterConnection -NameContains $ClusterName |
          Start-VsanCluster -ErrorAction Stop
        Write-Log "[VsanStart] Start-VsanCluster issued."
        $startIssued = $true
      } catch {
        if ($_.Exception.Message -match 'vsanHealth|unavailable|endpoint') {
          Write-Log "[VsanStart] vsanHealth not ready. Retrying in ${PollSec}s..." "WARN"
          Start-Sleep -Seconds $PollSec; continue
        } else {
          Write-Log "[VsanStart] Start-VsanCluster non-transient error: $($_.Exception.Message)" "WARN"
          $startIssued = $true
        }
      }
    }
    if ($startIssued) {
      $cluster = Find-ClusterByNameContains -VcenterConnection $VcenterConnection -NameContains $ClusterName
      $vsanDs = @()
      if ($cluster) {
        $vsanDs = @(Get-Datastore -Server $VcenterConnection -RelatedObject $cluster -ErrorAction SilentlyContinue |
          Where-Object { $_.Type -eq 'vsan' })
      }
      $accessible = @($vsanDs | Where-Object {
        $_.State -eq 'Available' -and $_.ExtensionData.Summary.Accessible -eq $true
      })
      if ($accessible.Count -gt 0) {
        Write-Log "[VsanStart] vSAN datastore accessible ($(($accessible.Name) -join ', '))."
        return $true
      }
      Write-Log "[VsanStart] vSAN not accessible yet (vsan=$($vsanDs.Count))..."
    }
    Start-Sleep -Seconds $PollSec
  }
  return $false
}

function Bring-VsanClusterOnline {
  # SOFT: warn and continue on timeout (9.0 behavior).
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] $VcenterConnection,
    [Parameter(Mandatory)] [string] $ClusterName,
    [int] $TimeoutSec = 600,
    [int] $PollSec    = 15
  )
  Write-Log "[Bring-VsanClusterOnline] Starting vSAN on '$ClusterName' (soft)..."
  if (-not (Invoke-VsanStartCore -VcenterConnection $VcenterConnection -ClusterName $ClusterName -TimeoutSec $TimeoutSec -PollSec $PollSec)) {
    Write-Log "[Bring-VsanClusterOnline] WARNING: vSAN not accessible within ${TimeoutSec}s. Continuing." "WARN"
  }
}

function Assert-VsanClusterOnline {
  # HARD: throw on timeout (9.1 behavior).
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] $VcenterConnection,
    [Parameter(Mandatory)] [string] $ClusterName,
    [int] $TimeoutSec = 1200,
    [int] $PollSec    = 15
  )
  Write-Log "[Assert-VsanClusterOnline] Starting/verifying vSAN on '$ClusterName' (HARD GATE)..."
  if (-not (Invoke-VsanStartCore -VcenterConnection $VcenterConnection -ClusterName $ClusterName -TimeoutSec $TimeoutSec -PollSec $PollSec)) {
    throw "[Assert-VsanClusterOnline] vSAN datastore did not become accessible within ${TimeoutSec}s. Aborting bring-up."
  }
  Write-Log "[Assert-VsanClusterOnline] vSAN online. Proceeding."
}

# ---------------------------------------------------------------------------
# VM lookup (9.0 exact-name) and (9.1 match-type)
# ---------------------------------------------------------------------------
function Get-VMExactOnServer {
  [CmdletBinding()]
  param([Parameter(Mandatory)] $Server, [Parameter(Mandatory)] [string] $Name)
  $n = $Name.Trim()
  if ([string]::IsNullOrWhiteSpace($n)) { return @() }
  $exact = @(Get-VM -Server $Server -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $n })
  if ($exact.Count -gt 0) { return $exact }
  $all = @(Get-VM -Server $Server -ErrorAction SilentlyContinue)
  @($all | Where-Object { $_.Name -and $_.Name.Trim().ToLowerInvariant() -eq $n.ToLowerInvariant() })
}

function Find-VMByAnyName {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string[]] $CandidateNames, [Parameter(Mandatory)] $Servers)
  foreach ($nRaw in $CandidateNames) {
    $n = ([string]$nRaw).Trim()
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    $hits = @()
    foreach ($srv in @($Servers)) {
      foreach ($vm in (Get-VMExactOnServer -Server $srv -Name $n)) {
        $hits += [pscustomobject]@{ VM=$vm; Server=$srv; Name=$vm.Name }
      }
    }
    if ($hits.Count -eq 1) { return $hits[0] }
    if ($hits.Count -gt 1) {
      $detail = $hits | Select-Object Name, @{N="Server";E={$_.Server.Name}} | Format-Table -AutoSize | Out-String
      throw "VM name '$n' matched multiple VMs across connected ESXi hosts. Refine lookup.`n$detail"
    }
  }
  return $null
}

function Refresh-VMExactOnServer {
  [CmdletBinding()]
  param([Parameter(Mandatory)] $Server, [Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [string] $Context)
  $vmMatches = Get-VMExactOnServer -Server $Server -Name $Name
  if ($vmMatches.Count -ne 1) {
    $detail = $vmMatches | Select-Object Name, Id, PowerState | Format-Table -AutoSize | Out-String
    throw "[$Context] Expected exactly 1 VM named '$Name' on '$($Server.Name)' but got $($vmMatches.Count).`n$detail"
  }
  return $vmMatches[0]
}

function Get-BootStepVMs {
  # 9.1 resolver. Returns an array (possibly empty) of {VM,Server,Name}.
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] $Servers,
    [Parameter(Mandatory)] [ValidateSet('Exact','Prefix','Contains')] [string] $Match,
    [Parameter(Mandatory)] [string] $Pattern
  )
  $p   = $Pattern.Trim().ToLowerInvariant()
  $out = @()
  foreach ($srv in @($Servers)) {
    foreach ($vm in @(Get-VM -Server $srv -ErrorAction SilentlyContinue)) {
      $n = $vm.Name
      if ([string]::IsNullOrWhiteSpace($n)) { continue }
      $ln = $n.Trim().ToLowerInvariant()
      $isMatch = switch ($Match) {
        'Exact'    { $ln -eq $p }
        'Prefix'   { $ln.StartsWith($p) }
        'Contains' { $ln.Contains($p) }
        default    { $false }
      }
      if ($isMatch) { $out += [pscustomobject]@{ VM=$vm; Server=$srv; Name=$n } }
    }
  }
  return ,$out
}

# ---------------------------------------------------------------------------
# Guest IP gate (9.1)
# ---------------------------------------------------------------------------
function Wait-ForAllGuestIps {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [object[]] $Targets,
    [int] $TimeoutSec = 1800,
    [int] $PollSec    = 15
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $resolved = @{}
  $pending  = [System.Collections.Generic.List[object]]::new()
  $Targets | ForEach-Object { $pending.Add($_) }

  while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
    $stillPending = [System.Collections.Generic.List[object]]::new()
    foreach ($t in $pending) {
      $ips = @()
      try {
        $v = Get-VM -Server $t.Server -Id $t.VM.Id -ErrorAction SilentlyContinue
        if ($v -and $v.ExtensionData.Guest.ToolsRunningStatus -eq 'guestToolsRunning') {
          $ips = @($v.Guest.IPAddress | Where-Object {
            $_ -and $_ -notmatch '^169\.254' -and $_ -ne '0.0.0.0' -and $_ -notmatch '^fe80:'
          })
        }
      } catch {
        Write-Log "[Wait-ForAllGuestIps] Poll error for '$($t.Name)': $($_.Exception.Message)" "WARN"
      }
      if ($ips.Count -gt 0) {
        Write-Log "[$($t.Label)] '$($t.Name)' guest IP(s): $($ips -join ', ')"
        $resolved[$t.Name] = $ips
      } else { $stillPending.Add($t) }
    }
    $pending = $stillPending
    if ($pending.Count -gt 0) {
      Write-Log "Waiting on guest IPs for: $(@($pending | ForEach-Object { $_.Name }) -join ', ')"
      Start-Sleep -Seconds $PollSec
    }
  }
  if ($pending.Count -gt 0) {
    throw "Guest IP not reported within ${TimeoutSec}s for: $(@($pending | ForEach-Object { $_.Name }) -join ', ')"
  }
  return $resolved
}

# ---------------------------------------------------------------------------
# FleetOps (9.0 only)
# ---------------------------------------------------------------------------
function New-FleetOpsAuthHeaderValue {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string]$Username, [Parameter(Mandatory)] [string]$Password)
  $bytes  = [System.Text.Encoding]::UTF8.GetBytes(('{0}:{1}' -f $Username, $Password))
  return "Basic " + [System.Convert]::ToBase64String($bytes)
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
  $handler = $null; $client = $null
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    try { $handler.CheckCertificateRevocationList = $false } catch {}
    try {
      $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12 -bor
                              [System.Security.Authentication.SslProtocols]::Tls13
    } catch { try { $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12 } catch {} }
    if ($SkipCertificateCheck) {
      $handler.ServerCertificateCustomValidationCallback =
        [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
    }
    $client         = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($RestMethod), $fullUrl)
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
    if ($raw) { try { $content = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $content = $raw } }
    return [pscustomobject]@{
      Success           = $response.IsSuccessStatusCode
      StatusCode        = [int]$response.StatusCode
      StatusDescription = [string]$response.ReasonPhrase
      Content           = $content
      RawContent        = $raw
      Url               = $fullUrl
      ExceptionMessage  = $null
    }
  } catch {
    $ex = $_.Exception; $inner = $ex.InnerException
    return [pscustomobject]@{
      Success=$false; StatusCode=$null; StatusDescription=$null; Content=$null; RawContent=$null; Url=$fullUrl
      ExceptionMessage = @(
        "EX: $($ex.GetType().FullName): $($ex.Message)"
        $(if ($inner) { "INNER: $($inner.GetType().FullName): $($inner.Message)" })
      ) -join " | "
    }
  } finally {
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
    $response = Invoke-FleetOpsRestCall -FleetOpsFqdn $FleetOpsFqdn -FleetOpsApiUrl $apiPath `
      -AuthorizationHeaderValue $AuthorizationHeaderValue -RestMethod "GET" -SkipCertificateCheck
    if ($response.Success -and $response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $response.Content) {
      Write-Log "[FleetOps] Retrieved environments. HTTP $($response.StatusCode)"
      return $response
    }
    $statusCode = $response.StatusCode
    if ($statusCode -eq 401) { throw "[FleetOps] Authentication failed (401) retrieving environments." }
    if ($statusCode -eq 403) { throw "[FleetOps] Authorization failed (403) retrieving environments." }
    if ($null -ne $statusCode) {
      Write-Log "[FleetOps] HTTP $statusCode. Retrying in ${RetryIntervalSec}s..." "WARN"
    } else {
      Write-Log "[FleetOps] Request failed pre-HTTP: $($response.ExceptionMessage). Retrying in ${RetryIntervalSec}s..." "WARN"
    }
    Start-Sleep -Seconds $RetryIntervalSec
  }
  throw "[FleetOps] Timed out after ${TimeoutSec}s waiting for GET /environments."
}

# ---------------------------------------------------------------------------
# VCF Installer probe (9.0 only)
# ---------------------------------------------------------------------------
function Test-VcfInstallerOnline {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string] $Fqdn, [Parameter(Mandatory)] [string] $Path, [int] $TimeoutSec = 10)
  $url = "https://$Fqdn$Path"; $handler = $null; $client = $null
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    try { $handler.CheckCertificateRevocationList = $false } catch {}
    try {
      $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12 -bor
                              [System.Security.Authentication.SslProtocols]::Tls13
    } catch { try { $handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12 } catch {} }
    $handler.ServerCertificateCustomValidationCallback =
      [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $url)
    try {
      $request.Version = [System.Version]::new(1,1)
      $request.VersionPolicy = [System.Net.Http.HttpVersionPolicy]::RequestVersionOrLower
    } catch {}
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $statusCode = [int]$response.StatusCode
    $is2xx = ($statusCode -ge 200 -and $statusCode -lt 300)
    Write-Log "[Test-VcfInstallerOnline] GET $url -> HTTP $statusCode (2xx=$is2xx)"
    return $is2xx
  } catch {
    $ex = $_.Exception; $msg = $ex.Message; if ($ex.InnerException) { $msg += " | $($ex.InnerException.Message)" }
    Write-Log "[Test-VcfInstallerOnline] GET $url failed: $msg" "WARN"
    return $false
  } finally {
    try { if ($client)  { $client.Dispose()  } } catch {}
    try { if ($handler) { $handler.Dispose() } } catch {}
  }
}

function Wait-ForVcfInstallerOnline {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $Fqdn, [Parameter(Mandatory)] [string] $Path,
    [int] $TimeoutSec = 30, [int] $PollSec = 5, [int] $HttpTimeout = 10
  )
  Write-Log "[VcfInstaller] Probing https://$Fqdn$Path for HTTP 2xx (timebox=${TimeoutSec}s)..."
  if (-not (Test-TcpPort -ServerName $Fqdn -Port 443 -TimeoutSec 3)) {
    Write-Log "[VcfInstaller] TCP/443 not reachable on '$Fqdn'. Treating as absent." "WARN"
    return $false
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-VcfInstallerOnline -Fqdn $Fqdn -Path $Path -TimeoutSec $HttpTimeout) {
      Write-Log "[VcfInstaller] VCF Installer endpoint is ONLINE."
      return $true
    }
    $remaining = [int](($deadline - (Get-Date)).TotalSeconds)
    Write-Log "[VcfInstaller] Not yet reachable. Retrying... (${remaining}s remaining)" "WARN"
    Start-Sleep -Seconds $PollSec
  }
  Write-Log "[VcfInstaller] No HTTP 2xx within ${TimeoutSec}s. Treating as absent." "WARN"
  return $false
}

# ---------------------------------------------------------------------------
# Completion marker (generic; caller supplies content lines)
# ---------------------------------------------------------------------------
function Write-CompletionMarker {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string[]] $Lines)
  $all = @("Completed: $(Get-Date -Format o)") + $Lines
  Set-Content -Path $Path -Value ($all -join [Environment]::NewLine) -Encoding UTF8 -Force
  Write-Log "Created completion marker: $Path"
}

# ---------------------------------------------------------------------------
# Scheduled-task teardown (success-only; called by version scripts)
# ---------------------------------------------------------------------------
function Remove-LabScheduledTask {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string] $TaskName)
  try {
    schtasks /Delete /TN $TaskName /F | Out-Null
    Write-Log "Removed scheduled task: $TaskName"
  } catch {
    Write-Log "Failed to remove scheduled task '$TaskName': $($_.Exception.Message)" "WARN"
  }
}

Export-ModuleMember -Function `
  Import-LabPowerCLI, Initialize-LabBringUp, New-LabCredential, Write-Log, Test-TcpPort, Wait-ForNetwork,
  Connect-EsxiHostOnce, Connect-RequiredEsxiHosts, Try-ConnectOptionalEsxiHost, Get-EsxiVersionFromAnyHost,
  Wait-ForVcenterReady, Find-ClusterByNameContains, Bring-VsanClusterOnline, Assert-VsanClusterOnline,
  Get-VMExactOnServer, Find-VMByAnyName, Refresh-VMExactOnServer, Get-BootStepVMs, Wait-ForAllGuestIps,
  New-FleetOpsAuthHeaderValue, Invoke-FleetOpsRestCall, Get-FleetOpsEnvironmentsWithRetry,
  Test-VcfInstallerOnline, Wait-ForVcfInstallerOnline, Write-CompletionMarker, Remove-LabScheduledTask
