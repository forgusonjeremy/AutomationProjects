#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Configures a Windows Server as a VCF Operations Orchestrator PowerShell host.

.DESCRIPTION
    Performs all Windows-side configuration steps required to register this server
    as a PowerShell host in VCF Operations Orchestrator 9 using HTTPS and Kerberos.

    Steps performed:
      1. Installs RSAT Active Directory PowerShell tools
      2. Configures WinRM base settings (quickconfig, Kerberos auth, memory limit)
      3. Generates a self-signed certificate OR locates an existing CA-issued cert
      4. Creates the WinRM HTTPS listener on port 5986
      5. Opens Windows Firewall for port 5986
      6. Adds the service account to the Remote Management Users local group
      7. Sets PowerShell execution policy to RemoteSigned
      8. Exports the certificate for import into VCF Orchestrator
      9. Prints a post-run summary with next steps

    This script does NOT:
      - Configure Kerberos constrained delegation (requires AD admin access)
      - Import the certificate into VCF Orchestrator (performed in vRO UI)
      - Add the PS host to VCF Orchestrator (performed in vRO UI)
      - Deploy cvs_functions.ps1 (must be staged separately)

.PARAMETER Fqdn
    The fully qualified domain name of this server.
    Must match the DNS name that VCF Orchestrator will use to connect.
    Must be included in the certificate CN or SAN.
    Example: pshost.corp.local

.PARAMETER ServiceAccount
    The domain service account that vRO will use to connect to this PS host.
    Format: DOMAIN\username or username@domain.com
    Example: CORP\svc-vro-ps

.PARAMETER CertificateMode
    How to obtain the HTTPS certificate.
    SelfSigned  : Generate a new self-signed certificate (default).
                  The exported .cer file must be imported into vRO trust store.
    ExistingCA  : Locate an existing certificate in LocalMachine\My that matches
                  the Fqdn.  Use when a CA-issued certificate is already installed.
    Example: SelfSigned

.PARAMETER CertValidityYears
    Validity period in years for the self-signed certificate.
    Only used when CertificateMode = SelfSigned.
    Default: 5

.PARAMETER CertExportPath
    Directory where the exported certificate (.cer) file will be written.
    Default: C:\PSO\Certs\

.PARAMETER ScriptDeployPath
    Directory where cvs_functions.ps1 will be deployed.
    This script creates the directory and sets NTFS permissions for the
    service account.  It does not copy the script file itself.
    Default: C:\PSO\Scripts\

.PARAMETER WinRmMemoryLimitMB
    WinRM shell memory limit in MB.
    Default: 2048

.EXAMPLE
    # Self-signed certificate (most common)
    .\Configure-vROPSHost.ps1 `
        -Fqdn "pshost.corp.local" `
        -ServiceAccount "CORP\svc-vro-ps"

.EXAMPLE
    # Existing CA-issued certificate already installed
    .\Configure-vROPSHost.ps1 `
        -Fqdn "pshost.corp.local" `
        -ServiceAccount "CORP\svc-vro-ps" `
        -CertificateMode ExistingCA

.EXAMPLE
    # Custom export path and 3-year self-signed cert
    .\Configure-vROPSHost.ps1 `
        -Fqdn "pshost.corp.local" `
        -ServiceAccount "CORP\svc-vro-ps" `
        -CertValidityYears 3 `
        -CertExportPath "C:\Temp\Certs\"

.NOTES
    Run as local Administrator or Domain Admin.
    Server must be domain-joined before running this script.
    After this script completes, perform the following in VCF Orchestrator:
      1. Import the exported certificate into vRO trust store (if self-signed
         or internal CA not already trusted by vRO)
      2. Run "Add a PowerShell host" workflow (Library > PowerShell > Configuration)
         using: HTTPS, port 5986, Kerberos authentication, Shared Session
    See PS-Host-Build-Guide.txt for full details.
#>

[CmdletBinding(SupportsShouldProcess)]
param (
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Fqdn,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ServiceAccount,

    [Parameter(Mandatory = $false)]
    [ValidateSet('SelfSigned', 'ExistingCA')]
    [string]$CertificateMode = 'SelfSigned',

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 20)]
    [int]$CertValidityYears = 5,

    [Parameter(Mandatory = $false)]
    [string]$CertExportPath = 'C:\PSO\Certs\',

    [Parameter(Mandatory = $false)]
    [string]$ScriptDeployPath = 'C:\PSO\Scripts\',

    [Parameter(Mandatory = $false)]
    [ValidateRange(512, 8192)]
    [int]$WinRmMemoryLimitMB = 2048
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Logging helpers ───────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Message)
    Write-Host "`n[$([System.DateTime]::Now.ToString('HH:mm:ss'))] STEP: $Message" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$Message)
    Write-Host "  [OK]  $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  [FAIL] $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "        $Message"
}

# ── Track results for summary ─────────────────────────────────────────────────

$Results  = [System.Collections.Generic.List[PSCustomObject]]::new()
$Warnings = [System.Collections.Generic.List[string]]::new()

function Add-Result {
    param([string]$Step, [string]$Status, [string]$Detail = '')
    $Results.Add([PSCustomObject]@{ Step = $Step; Status = $Status; Detail = $Detail })
}

# ═════════════════════════════════════════════════════════════════════════════
# PRE-FLIGHT CHECKS
# ═════════════════════════════════════════════════════════════════════════════

Write-Host "`n═══════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  VCF Orchestrator PowerShell Host Configuration" -ForegroundColor White
Write-Host "  Target FQDN    : $Fqdn" -ForegroundColor White
Write-Host "  Service Account: $ServiceAccount" -ForegroundColor White
Write-Host "  Cert Mode      : $CertificateMode" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════════`n" -ForegroundColor White

# Verify running as Administrator
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail "This script must be run as Administrator."
    exit 1
}

# Verify domain-joined
$domainStatus = (Get-WmiObject Win32_ComputerSystem).PartOfDomain
if (-not $domainStatus) {
    Write-Fail "This server is not domain-joined.  Join the domain before running this script."
    exit 1
}
Write-OK "Running as Administrator on domain-joined server."

# Derive short name from FQDN for certificate SAN
$shortName = $Fqdn.Split('.')[0]

# ═════════════════════════════════════════════════════════════════════════════
# STEP 1 - RSAT Active Directory PowerShell Tools
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Installing RSAT Active Directory PowerShell tools"

try {
    $adModule = Get-Module -ListAvailable ActiveDirectory -ErrorAction SilentlyContinue
    if ($adModule) {
        Write-OK "RSAT AD PowerShell module already installed."
        Add-Result "RSAT AD Tools" "Already installed"
    } else {
        Write-Info "Installing RSAT-AD-PowerShell feature..."
        $result = Add-WindowsFeature RSAT-AD-PowerShell -ErrorAction Stop
        if ($result.Success) {
            Write-OK "RSAT AD PowerShell module installed."
            Add-Result "RSAT AD Tools" "Installed"
            if ($result.RestartNeeded -eq 'Yes') {
                $Warnings.Add("RSAT installation indicates a restart may be needed. Verify AD module loads correctly after completing this script.")
            }
        } else {
            throw "Add-WindowsFeature returned Success=False"
        }
    }
} catch {
    Write-Fail "Failed to install RSAT AD PowerShell tools: $($_.Exception.Message)"
    Write-Warn "Continuing - install manually with: Add-WindowsFeature RSAT-AD-PowerShell"
    Add-Result "RSAT AD Tools" "FAILED" $_.Exception.Message
    $Warnings.Add("RSAT AD PowerShell tools not installed. Required for ByADGroupName and ByADGroupCN workflows.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 2 - WinRM Base Configuration
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Configuring WinRM base settings"

try {
    Write-Info "Running winrm quickconfig..."
    $quickconfig = winrm quickconfig -force 2>&1
    Write-OK "winrm quickconfig completed."
    Write-Info $quickconfig
    Add-Result "WinRM quickconfig" "OK"
} catch {
    Write-Fail "winrm quickconfig failed: $($_.Exception.Message)"
    Add-Result "WinRM quickconfig" "FAILED" $_.Exception.Message
}

try {
    Write-Info "Enabling Kerberos authentication on WinRM service..."
    winrm set winrm/config/service/auth '@{Kerberos="true"}' | Out-Null
    Write-OK "Kerberos authentication enabled on WinRM service."
    Add-Result "WinRM Kerberos auth" "Enabled"
} catch {
    Write-Fail "Failed to enable Kerberos: $($_.Exception.Message)"
    Add-Result "WinRM Kerberos auth" "FAILED" $_.Exception.Message
    $Warnings.Add("WinRM Kerberos auth not enabled. Required for Kerberos session mode in vRO.")
}

try {
    Write-Info "Setting WinRM shell memory limit to ${WinRmMemoryLimitMB} MB..."
    winrm set winrm/config/winrs "@{MaxMemoryPerShellMB=`"$WinRmMemoryLimitMB`"}" | Out-Null
    Write-OK "WinRM shell memory limit set to ${WinRmMemoryLimitMB} MB."
    Add-Result "WinRM memory limit" "${WinRmMemoryLimitMB} MB"
} catch {
    Write-Fail "Failed to set memory limit: $($_.Exception.Message)"
    Add-Result "WinRM memory limit" "FAILED" $_.Exception.Message
    $Warnings.Add("WinRM shell memory limit not set. Large script operations may fail.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 3 - Certificate
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Obtaining HTTPS certificate (mode: $CertificateMode)"

$certThumbprint = $null
$certSubject    = $null

if ($CertificateMode -eq 'SelfSigned') {

    try {
        Write-Info "Generating self-signed certificate for $Fqdn (validity: $CertValidityYears year(s))..."

        $cert = New-SelfSignedCertificate `
            -CertStoreLocation 'cert:\LocalMachine\My' `
            -DnsName ($Fqdn, $shortName) `
            -NotAfter (Get-Date).AddYears($CertValidityYears) `
            -Provider 'Microsoft RSA SChannel Cryptographic Provider' `
            -KeyLength 2048

        $certThumbprint = $cert.Thumbprint
        $certSubject    = $cert.Subject

        Write-OK "Self-signed certificate generated."
        Write-Info "  Thumbprint : $certThumbprint"
        Write-Info "  Subject    : $certSubject"
        Write-Info "  Expires    : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
        Write-Warn "This certificate is self-signed. It MUST be imported into the VCF"
        Write-Warn "Orchestrator trust store before adding this PS host. See next steps."
        Add-Result "Certificate" "Self-signed generated" "Thumbprint: $certThumbprint | Expires: $($cert.NotAfter.ToString('yyyy-MM-dd'))"

    } catch {
        Write-Fail "Failed to generate self-signed certificate: $($_.Exception.Message)"
        Add-Result "Certificate" "FAILED" $_.Exception.Message
        Write-Fail "Cannot continue without a certificate. Resolve and re-run."
        exit 1
    }

} elseif ($CertificateMode -eq 'ExistingCA') {

    Write-Info "Searching LocalMachine\My for a certificate matching FQDN: $Fqdn ..."

    $certs = Get-ChildItem 'cert:\LocalMachine\My' |
        Where-Object {
            ($_.Subject -like "*$Fqdn*" -or $_.DnsNameList.Unicode -contains $Fqdn) -and
            $_.NotAfter -gt (Get-Date) -and
            $_.HasPrivateKey
        } |
        Sort-Object NotAfter -Descending

    if (-not $certs) {
        Write-Fail "No valid certificate found in LocalMachine\My matching '$Fqdn'."
        Write-Fail "Install the CA-issued certificate first, then re-run with -CertificateMode ExistingCA."
        Add-Result "Certificate" "FAILED" "No matching cert found for $Fqdn"
        exit 1
    }

    $cert           = $certs[0]
    $certThumbprint = $cert.Thumbprint
    $certSubject    = $cert.Subject

    Write-OK "Found existing certificate."
    Write-Info "  Thumbprint : $certThumbprint"
    Write-Info "  Subject    : $certSubject"
    Write-Info "  Expires    : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
    Write-Info "  Issuer     : $($cert.Issuer)"

    if ($certs.Count -gt 1) {
        Write-Warn "$($certs.Count) matching certificates found. Using the one with the latest expiry."
        Write-Warn "If this is incorrect, remove unwanted certificates and re-run."
    }

    Add-Result "Certificate" "Existing CA cert selected" "Thumbprint: $certThumbprint | Expires: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 4 - WinRM HTTPS Listener
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Configuring WinRM HTTPS listener on port 5986"

try {
    # Check for an existing HTTPS listener
    $existingListener = winrm enumerate winrm/config/listener 2>&1 |
        Select-String 'Transport = HTTPS'

    if ($existingListener) {
        Write-Warn "An existing HTTPS WinRM listener was found."
        Write-Info "Removing existing HTTPS listener to replace with updated certificate..."
        winrm delete 'winrm/config/listener?Address=*+Transport=HTTPS' 2>&1 | Out-Null
        Write-OK "Existing HTTPS listener removed."
    }

    Write-Info "Creating HTTPS listener with thumbprint $certThumbprint ..."
    $listenerCmd = "winrm create winrm/config/listener?Address=*+Transport=HTTPS " +
                   "@{Hostname=`"$Fqdn`";CertificateThumbprint=`"$certThumbprint`"}"
    Invoke-Expression $listenerCmd | Out-Null

    Write-OK "WinRM HTTPS listener created on port 5986."
    Add-Result "WinRM HTTPS listener" "Created" "Port 5986 | Cert: $certThumbprint"

} catch {
    Write-Fail "Failed to create WinRM HTTPS listener: $($_.Exception.Message)"
    Add-Result "WinRM HTTPS listener" "FAILED" $_.Exception.Message
    $Warnings.Add("WinRM HTTPS listener not created. vRO will not be able to connect.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 5 - Windows Firewall Rule
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Configuring Windows Firewall for WinRM HTTPS (port 5986)"

try {
    $existingRule = Get-NetFirewallRule -Name 'WinRM-HTTPS-vRO' -ErrorAction SilentlyContinue
    if ($existingRule) {
        Write-Warn "Firewall rule 'WinRM-HTTPS-vRO' already exists. Updating..."
        Set-NetFirewallRule `
            -Name        'WinRM-HTTPS-vRO' `
            -DisplayName 'WinRM HTTPS for VCF Orchestrator (port 5986)' `
            -Protocol    TCP `
            -LocalPort   5986 `
            -Action      Allow `
            -Direction   Inbound `
            -Enabled     True
        Write-OK "Firewall rule updated."
    } else {
        New-NetFirewallRule `
            -Name        'WinRM-HTTPS-vRO' `
            -DisplayName 'WinRM HTTPS for VCF Orchestrator (port 5986)' `
            -Protocol    TCP `
            -LocalPort   5986 `
            -Action      Allow `
            -Direction   Inbound `
            -Enabled     True | Out-Null
        Write-OK "Firewall rule 'WinRM-HTTPS-vRO' created - TCP inbound port 5986 allowed."
    }
    Add-Result "Firewall rule" "TCP 5986 inbound allowed"

} catch {
    Write-Fail "Failed to configure firewall rule: $($_.Exception.Message)"
    Add-Result "Firewall rule" "FAILED" $_.Exception.Message
    $Warnings.Add("Firewall rule for port 5986 not created. vRO will not be able to reach this host.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 6 - Service Account - Remote Management Users
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Adding service account to Remote Management Users group"

try {
    $groupMembers = Get-LocalGroupMember -Group 'Remote Management Users' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ieq $ServiceAccount }

    if ($groupMembers) {
        Write-OK "$ServiceAccount is already a member of Remote Management Users."
        Add-Result "Remote Mgmt Users" "Already a member"
    } else {
        Add-LocalGroupMember -Group 'Remote Management Users' -Member $ServiceAccount -ErrorAction Stop
        Write-OK "$ServiceAccount added to Remote Management Users."
        Add-Result "Remote Mgmt Users" "Added"
    }
} catch {
    Write-Fail "Failed to add $ServiceAccount to Remote Management Users: $($_.Exception.Message)"
    Add-Result "Remote Mgmt Users" "FAILED" $_.Exception.Message
    $Warnings.Add("Service account '$ServiceAccount' not added to Remote Management Users. WinRM authentication will fail.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 7 - PowerShell Execution Policy
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Setting PowerShell execution policy to RemoteSigned"

try {
    $currentPolicy = Get-ExecutionPolicy -Scope LocalMachine
    if ($currentPolicy -in @('RemoteSigned', 'Unrestricted', 'Bypass')) {
        Write-OK "Execution policy is already '$currentPolicy' - no change needed."
        Add-Result "Execution policy" "Already $currentPolicy"
    } else {
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force
        Write-OK "Execution policy set to RemoteSigned."
        Add-Result "Execution policy" "Set to RemoteSigned"
    }
} catch {
    Write-Fail "Failed to set execution policy: $($_.Exception.Message)"
    Add-Result "Execution policy" "FAILED" $_.Exception.Message
    $Warnings.Add("Execution policy not set. Script execution via vRO may fail.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 8 - Script Deploy Directory
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Creating script deployment directory: $ScriptDeployPath"

try {
    if (-not (Test-Path $ScriptDeployPath)) {
        New-Item -ItemType Directory -Path $ScriptDeployPath -Force | Out-Null
        Write-OK "Directory created: $ScriptDeployPath"
    } else {
        Write-OK "Directory already exists: $ScriptDeployPath"
    }

    # Grant service account Read & Execute on the Scripts directory
    Write-Info "Setting NTFS permissions for $ServiceAccount on $ScriptDeployPath ..."
    $acl    = Get-Acl $ScriptDeployPath
    $rule   = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $ServiceAccount,
        [System.Security.AccessControl.FileSystemRights]'ReadAndExecute',
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]'None',
        [System.Security.AccessControl.AccessControlType]'Allow'
    )
    $acl.SetAccessRule($rule)
    Set-Acl -Path $ScriptDeployPath -AclObject $acl
    Write-OK "Read & Execute granted to $ServiceAccount on $ScriptDeployPath"
    Add-Result "Script directory" "Created with NTFS permissions" $ScriptDeployPath
    $Warnings.Add("cvs_functions.ps1 must be manually copied to $ScriptDeployPath - this script does not deploy it.")

} catch {
    Write-Fail "Failed to configure script directory: $($_.Exception.Message)"
    Add-Result "Script directory" "FAILED" $_.Exception.Message
    $Warnings.Add("Script deployment directory not configured. Deploy cvs_functions.ps1 manually.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 9 - Export Certificate
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Exporting certificate for import into VCF Orchestrator"

$certExportFile = $null

try {
    if (-not (Test-Path $CertExportPath)) {
        New-Item -ItemType Directory -Path $CertExportPath -Force | Out-Null
    }

    $certExportFile = Join-Path $CertExportPath "$($shortName)-vro-cert.cer"

    Export-Certificate `
        -Cert "cert:\LocalMachine\My\$certThumbprint" `
        -FilePath $certExportFile `
        -Type CERT `
        -Force | Out-Null

    Write-OK "Certificate exported to: $certExportFile"
    Write-Info "Transfer this file to a machine with browser access to VCF Orchestrator"
    Write-Info "for import via: Library > Configuration > SSL Trust Manager >"
    Write-Info "  'Import a trusted certificate from a file'"
    Add-Result "Cert export" "Exported" $certExportFile

    if ($CertificateMode -eq 'ExistingCA') {
        Write-Warn "CertificateMode is ExistingCA.  If the signing CA is already trusted by"
        Write-Warn "VCF Orchestrator, importing the leaf certificate is not required."
        Write-Warn "Import the CA certificate instead if vRO does not already trust your CA."
    }

} catch {
    Write-Fail "Failed to export certificate: $($_.Exception.Message)"
    Add-Result "Cert export" "FAILED" $_.Exception.Message
    $Warnings.Add("Certificate export failed. Export manually from certmgr.msc before adding PS host to vRO.")
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 10 - Verification
# ═════════════════════════════════════════════════════════════════════════════

Write-Step "Verifying configuration"

# WinRM service running
$winrmSvc = Get-Service WinRM -ErrorAction SilentlyContinue
if ($winrmSvc -and $winrmSvc.Status -eq 'Running') {
    Write-OK "WinRM service is running."
} else {
    Write-Warn "WinRM service is not running."
    $Warnings.Add("WinRM service is not running. Start it with: Start-Service WinRM")
}

# HTTPS listener present
$httpsListener = winrm enumerate winrm/config/listener 2>&1 | Select-String 'Transport = HTTPS'
if ($httpsListener) {
    Write-OK "HTTPS listener is present."
} else {
    Write-Warn "HTTPS listener not found."
    $Warnings.Add("HTTPS WinRM listener not found after configuration. Review Step 4 output.")
}

# Port 5986 listening
$port5986 = Get-NetTCPConnection -LocalPort 5986 -State Listen -ErrorAction SilentlyContinue
if ($port5986) {
    Write-OK "Port 5986 is listening."
} else {
    Write-Warn "Port 5986 is not yet listening. WinRM service may need a restart."
    $Warnings.Add("Port 5986 not listening. Restart WinRM: Restart-Service WinRM")
}

# Certificate in store
$certInStore = Get-ChildItem "cert:\LocalMachine\My\$certThumbprint" -ErrorAction SilentlyContinue
if ($certInStore) {
    Write-OK "Certificate is in LocalMachine\My store. Thumbprint: $certThumbprint"
} else {
    Write-Warn "Certificate not found in store."
}

# ═════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════════════════════════

Write-Host "`n═══════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  CONFIGURATION SUMMARY" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor White

foreach ($r in $Results) {
    $statusColor = switch ($r.Status) {
        { $_ -like '*FAILED*' }          { 'Red'    }
        { $_ -like '*Already*' }         { 'Gray'   }
        default                           { 'Green'  }
    }
    $line = "  {0,-28} {1}" -f $r.Step, $r.Status
    if ($r.Detail) { $line += " - $($r.Detail)" }
    Write-Host $line -ForegroundColor $statusColor
}

if ($Warnings.Count -gt 0) {
    Write-Host "`n  WARNINGS:" -ForegroundColor Yellow
    foreach ($w in $Warnings) {
        Write-Host "  [!] $w" -ForegroundColor Yellow
    }
}

$failedSteps = $Results | Where-Object { $_.Status -like '*FAILED*' }

Write-Host "`n═══════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  NEXT STEPS" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor White

if ($failedSteps) {
    Write-Host "  One or more steps FAILED.  Resolve the issues above before" -ForegroundColor Red
    Write-Host "  proceeding to VCF Orchestrator configuration." -ForegroundColor Red
} else {
    Write-Host "  Windows Server configuration is complete." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Remaining manual steps:" -ForegroundColor White
Write-Host ""

$stepNum = 1

if ($CertificateMode -eq 'SelfSigned' -or $CertificateMode -eq 'ExistingCA') {
    Write-Host "  $stepNum. Configure Kerberos constrained delegation (if double-hop UNC required)" -ForegroundColor White
    Write-Host "     Requires AD admin.  See PS-Host-Build-Guide.txt Step 1.6." -ForegroundColor Gray
    $stepNum++
}

Write-Host "  $stepNum. Deploy cvs_functions.ps1 to: $ScriptDeployPath" -ForegroundColor White
Write-Host "     Verify: Test-Path '$($ScriptDeployPath)cvs_functions.ps1'" -ForegroundColor Gray
$stepNum++

if ($certExportFile) {
    Write-Host "  $stepNum. Import certificate into VCF Orchestrator trust store" -ForegroundColor White
    Write-Host "     File : $certExportFile" -ForegroundColor Gray
    Write-Host "     Path : vRO > Library > Configuration > SSL Trust Manager" -ForegroundColor Gray
    Write-Host "            > 'Import a trusted certificate from a file'" -ForegroundColor Gray
    Write-Host "     OR   : Run 'Import a trusted certificate from a URL'" -ForegroundColor Gray
    Write-Host "            with URL: https://$($Fqdn):5986" -ForegroundColor Gray
    if ($CertificateMode -eq 'ExistingCA') {
        Write-Host "     NOTE : Skip if your CA is already trusted by VCF Orchestrator." -ForegroundColor Yellow
    }
    $stepNum++
}

Write-Host "  $stepNum. Add PS host in VCF Orchestrator" -ForegroundColor White
Write-Host "     Workflow : Library > PowerShell > Configuration > Add a PowerShell host" -ForegroundColor Gray
Write-Host "     Host     : $Fqdn" -ForegroundColor Gray
Write-Host "     Port     : 5986" -ForegroundColor Gray
Write-Host "     Transport: HTTPS" -ForegroundColor Gray
Write-Host "     Auth     : Kerberos" -ForegroundColor Gray
Write-Host "     Session  : Shared Session" -ForegroundColor Gray
Write-Host "     Account  : $ServiceAccount" -ForegroundColor Gray
$stepNum++

Write-Host "  $stepNum. Run smoke test in vRO" -ForegroundColor White
Write-Host "     Workflow : Library > PowerShell > Invoke a PowerShell script" -ForegroundColor Gray
Write-Host "     Script   : Write-Host 'PS host connectivity test OK'" -ForegroundColor Gray
Write-Host "     Expected : Workflow completes with output containing the test string" -ForegroundColor Gray

Write-Host ""
Write-Host "  See PS-Host-Build-Guide.txt for full instructions on all steps above." -ForegroundColor Gray
Write-Host "═══════════════════════════════════════════════════════════════`n" -ForegroundColor White
