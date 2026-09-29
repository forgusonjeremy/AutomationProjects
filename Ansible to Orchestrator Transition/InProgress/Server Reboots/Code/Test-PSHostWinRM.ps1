<#
.SYNOPSIS
    Diagnoses a PowerShell host that Orchestrator can no longer open a shell on.

.DESCRIPTION
    Run this ON the PowerShell host (pshost.vcf.lab) when the vRO PowerShell plug-in
    fails with:

        send message on https://<host>:5986/wsman error ,
        document in <...Action>.../transfer/Create</Action>
                    <...ResourceURI>.../windows/shell/cmd</ResourceURI>...>,
        document out [EMPTY]

    That error is a WinRS *shell Create* being refused. The request carries none of
    the script being run, so it is not about script size or content -- the host
    declined to open a shell at all. When it affects EVERY workflow rather than one,
    the cause is on this host.

    This script changes nothing. It reports the four things that cause it, in the
    order they are worth checking.

.NOTES
    Needs an elevated PowerShell on the host.
#>

[CmdletBinding()]
param()

function Section { param([string]$Text) Write-Host ""; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Good    { param([string]$Text) Write-Host "  OK    $Text" -ForegroundColor Green }
function Bad     { param([string]$Text) Write-Host "  FAIL  $Text" -ForegroundColor Red }
function Note    { param([string]$Text) Write-Host "        $Text" -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# 1. Is the service even up, and is anything listening on 5986?
# ---------------------------------------------------------------------------
Section "1. WinRM service and listeners"

$svc = Get-Service WinRM -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Good "WinRM service is Running (startup: $((Get-Service WinRM).StartType))" }
else { Bad "WinRM service is '$($svc.Status)'. Start it: Start-Service WinRM" }

$listeners = @()
try { $listeners = @(Get-ChildItem WSMan:\localhost\Listener -ErrorAction Stop) } catch { Bad "Cannot read listeners: $($_.Exception.Message)" }

if ($listeners.Count -eq 0) {
    Bad "NO WinRM listeners are configured. Nothing is accepting 5986."
    Note "Recreate with: winrm quickconfig -transport:https"
}
foreach ($l in $listeners) {
    $props = Get-ChildItem "WSMan:\localhost\Listener\$($l.Name)"
    $transport = ($props | Where-Object Name -eq 'Transport').Value
    $port      = ($props | Where-Object Name -eq 'Port').Value
    $thumb     = ($props | Where-Object Name -eq 'CertificateThumbprint').Value
    $enabled   = ($props | Where-Object Name -eq 'Enabled').Value
    Write-Host "  listener: $transport on port $port (Enabled=$enabled)"
    if ($transport -eq 'HTTPS') { $script:HttpsThumb = $thumb; Note "cert thumbprint: $thumb" }
}

$tcp = Test-NetConnection -ComputerName localhost -Port 5986 -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) { Good "5986 is accepting connections locally" } else { Bad "Nothing is listening on 5986" }

# ---------------------------------------------------------------------------
# 2. The listener certificate
#
# An expired or replaced certificate is the classic cause of a fast, EMPTY
# response: the TLS handshake fails, so no SOAP ever comes back for the plug-in
# to parse. It breaks every workflow at once, and it breaks a host that worked
# fine yesterday -- which is exactly the shape of this failure.
# ---------------------------------------------------------------------------
Section "2. Listener certificate"

if (-not $script:HttpsThumb) {
    Bad "No HTTPS listener, so no certificate to check."
}
else {
    $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq $script:HttpsThumb
    if (-not $cert) {
        Bad "The listener references thumbprint $($script:HttpsThumb) but NO such certificate is in LocalMachine\My."
        Note "The cert was replaced or removed and the listener still points at the old one."
        Note "This alone will produce 'document out [EMPTY]'."
    }
    else {
        Write-Host "  subject : $($cert.Subject)"
        Write-Host "  issuer  : $($cert.Issuer)"
        Write-Host "  valid   : $($cert.NotBefore) -> $($cert.NotAfter)"
        Write-Host "  signed  : $($cert.SignatureAlgorithm.FriendlyName) [$($cert.SignatureAlgorithm.Value)]"

        # THE ONE THAT COST US A DAY.
        #
        # VCF Automation 9.1.1 runs its JVM with BouncyCastle in FIPS approved-only
        # mode (FIPS_MODE=strict) and REFUSES a SHA-1 signed certificate. The TLS
        # handshake fails, and the only thing vRO reports is "document out [EMPTY]"
        # on the WS-Man Shell Create -- which names neither TLS nor the certificate.
        #
        # Importing it does not help. The SSL Trust Manager reports "Certificate is
        # already trusted" while the handshake still refuses it, because trust and
        # algorithm policy are separate gates. That pair of messages is the tell.
        $weakOids = @('1.2.840.113549.1.1.2','1.2.840.113549.1.1.3','1.2.840.113549.1.1.4',
                      '1.2.840.113549.1.1.5','1.2.840.10040.4.3','1.2.840.10045.4.1','1.3.14.3.2.29')
        if ($weakOids -contains $cert.SignatureAlgorithm.Value) {
            Bad "WEAK SIGNATURE -- Orchestrator will refuse this certificate under FIPS."
            Note "This is almost certainly your failure. Re-issue with SHA-256:"
            Note "  Configure-vROPSHost.ps1 -Fqdn <fqdn> -ServiceAccount <acct> ``"
            Note "                          -ForceNewCertificate -HashAlgorithm SHA256"
            Note "Then re-import it into the vRO SSL Trust Manager and re-run"
            Note "'Update a PowerShell host'."
        }
        else {
            Good "Signature algorithm is FIPS-acceptable"
        }
        $now = Get-Date
        if ($now -gt $cert.NotAfter)      { Bad "CERTIFICATE HAS EXPIRED ($([int]($now - $cert.NotAfter).TotalDays) days ago)." }
        elseif ($now -lt $cert.NotBefore) { Bad "Certificate is not valid yet (NotBefore is in the future)." }
        else {
            $left = [int]($cert.NotAfter - $now).TotalDays
            if ($left -lt 14) { Bad "Certificate expires in $left day(s)." } else { Good "Certificate is valid for another $left day(s)" }
        }
        if (-not $cert.HasPrivateKey) { Bad "Certificate has NO private key -- the listener cannot complete a handshake." }
    }
}

# ---------------------------------------------------------------------------
# 3. Shell limits and leftover shells
#
# Every failed run can leak a shell. Once MaxShellsPerUser is reached, Create is
# refused for everyone until they time out or the service is restarted -- which
# is why a host that worked earlier in the day stops working after a few failed
# iterations.
# ---------------------------------------------------------------------------
Section "3. Shell limits and leftover shells"

$winrs = @{}
try { winrm get winrm/config/winrs 2>&1 | ForEach-Object {
        if ($_ -match '^\s*(\w+)\s*=\s*(.+?)\s*$') { $winrs[$Matches[1]] = $Matches[2] }
      } } catch { Bad "Could not read winrm/config/winrs" }

foreach ($k in 'AllowRemoteShellAccess','MaxShellsPerUser','MaxConcurrentUsers','MaxMemoryPerShellMB','MaxShellRunTime','IdleTimeout') {
    if ($winrs.ContainsKey($k)) { Write-Host ("  {0,-24} {1}" -f $k, $winrs[$k]) }
}

if ($winrs['AllowRemoteShellAccess'] -eq 'false') {
    Bad "AllowRemoteShellAccess is FALSE. WinRS shells are refused outright."
    Note "This is a common hardening/STIG setting. The plug-in opens a .../shell/cmd shell,"
    Note "so this breaks every PowerShell workflow while leaving other WinRM use working."
    Note "Re-enable: Set-Item WSMan:\localhost\Shell\AllowRemoteShellAccess -Value `$true"
}
elseif ($winrs.ContainsKey('AllowRemoteShellAccess')) { Good "AllowRemoteShellAccess is true" }

$open = @()
try { $open = @(Get-WSManInstance -ResourceURI shell -Enumerate -ErrorAction Stop) } catch { }
Write-Host "  open shells right now : $($open.Count)"
if ($winrs['MaxShellsPerUser'] -and $open.Count -ge [int]$winrs['MaxShellsPerUser']) {
    Bad "At or over MaxShellsPerUser ($($winrs['MaxShellsPerUser'])). New shells WILL be refused."
    Note "Clear them all with: Restart-Service WinRM"
}
elseif ($open.Count -gt 5) {
    Write-Host "  NOTE: $($open.Count) shells are open. Leaked shells from failed runs accumulate." -ForegroundColor Yellow
    Note "Restart-Service WinRM clears them without touching configuration."
}

# ---------------------------------------------------------------------------
# 4. Envelope and timeout ceilings
#
# Not the cause of a refused Create, but the next thing to bite: a live reboot
# run is one synchronous call lasting (servers x delay) + verify timeout.
# ---------------------------------------------------------------------------
Section "4. Envelope and timeout ceilings"

$cfg = @{}
try { winrm get winrm/config 2>&1 | ForEach-Object {
        if ($_ -match '^\s*(\w+)\s*=\s*(.+?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
      } } catch { }
foreach ($k in 'MaxEnvelopeSizekb','MaxTimeoutms','MaxBatchItems') {
    if ($cfg.ContainsKey($k)) { Write-Host ("  {0,-24} {1}" -f $k, $cfg[$k]) }
}
if ($cfg['MaxTimeoutms'] -and [int]$cfg['MaxTimeoutms'] -lt 1800000) {
    Write-Host "  NOTE: MaxTimeoutms is $($cfg['MaxTimeoutms'])ms. A live reboot run needs" -ForegroundColor Yellow
    Note "(servers x delayBetweenServersSec) + verifyTimeoutSec. Raise it before a real run."
}

# ---------------------------------------------------------------------------
# 5. Prove a shell can actually be created, locally
# ---------------------------------------------------------------------------
Section "5. Can a shell be created at all?"

try {
    $r = Invoke-Command -ComputerName localhost -ScriptBlock { $env:COMPUTERNAME } -ErrorAction Stop
    Good "Loopback Invoke-Command succeeded (answered '$r')"
    Note "The WinRM stack works locally. If vRO still cannot connect, the problem is"
    Note "the listener certificate, the network path, or the account vRO authenticates as."
}
catch {
    Bad "Loopback Invoke-Command failed: $($_.Exception.Message)"
    Note "WinRM cannot open a shell even for itself -- this is the same failure vRO sees."
}

Write-Host ""
Write-Host "Done. Nothing was changed." -ForegroundColor Green
Write-Host ""
