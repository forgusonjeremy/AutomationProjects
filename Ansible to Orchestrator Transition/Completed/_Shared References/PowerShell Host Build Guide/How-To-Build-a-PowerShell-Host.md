# How to Build a PowerShell Host for VCF Operations Orchestrator 9

**Type:** Shared reference (cross-project library)
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Applies to:** Any project that executes PowerShell on a Windows host from VCF Orchestrator via the PowerShell plug-in (WinRM over HTTPS).

> **How to use this document.** This is a reusable appendix. Any deliverable that
> requires a registered PowerShell (PS) host references this guide instead of
> repeating the build steps. It covers Windows-side configuration, certificate
> trust, authentication (Basic and Kerberos), host registration, and the common
> bring-up failures. The companion automation script `Configure-vROPSHost.ps1`
> performs the Windows-side steps and is embedded in full in **Appendix A**.

**Broadcom TechDocs references**
- Configuring WinRM: `https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/configuration-of-vmware-cloud-foundation-operations-orchestrator/vcf-ochestrator-plugins-overview/using-the-powershell-plug-in/configuring-the-powershell-plug-in/configuring-winrm.html`
- Add a PowerShell host: `https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/configuration-of-vmware-cloud-foundation-operations-orchestrator/vcf-ochestrator-plugins-overview/using-the-powershell-plug-in/configuring-the-powershell-plug-in/add-a-powershell-host.html`
- Manage Orchestrator certificates: `https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/configuration-of-vmware-cloud-foundation-operations-orchestrator/types-of-orchestrator-instances/configuring-vcf-operations-orchestrator/manage-orchestrator-certificates.html`
- Kerberos shared-session troubleshooting: `https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/configuration-of-vmware-cloud-foundation-operations-orchestrator/vcf-ochestrator-plugins-overview/using-the-powershell-plug-in/troubleshooting/kerberos-authentication-shared-session-fails.html`

---

## 1. Overview

This guide makes a domain-joined Windows Server usable as a VCF Orchestrator
PowerShell host over **HTTPS (WinRM 5986)**. The host:

- Runs PowerShell (a project's toolbox script, e.g. `cvs_functions.ps1`) on behalf
  of Orchestrator workflows.
- Optionally reaches other systems (AD, remote `\\server\C$`, file shares) — a
  **second hop** that has its own authentication requirement (see §6).

### The two-hop model (read this first)

```
Orchestrator (PS plug-in)  ──hop 1: WinRM/HTTPS 5986──►  PS host  ──hop 2──►  AD / \\server\C$ / \\fileshare
        (Basic or Kerberos)                                  (needs delegated credential)
```

- **Hop 1** (Orchestrator → PS host) is authenticated by the plug-in with **Basic**
  or **Kerberos**. This is all that is needed for a script that runs *locally* on
  the PS host and touches nothing remote.
- **Hop 2** (PS host → any remote resource) requires the PS host to present a
  usable credential to the second system. Over WinRM this does **not** happen
  automatically — see §6. Any project whose script queries AD (`Get-ADGroupMember`)
  or reads/writes remote UNC paths depends on hop 2 working.

Assumptions for this guide: the Windows Server OS is installed, domain-joined, has
a stable FQDN that resolves from the Orchestrator appliance, and you have local
Administrator (or Domain Admin) access.

---

## 2. Prerequisites

- [ ] Windows Server 2019 or 2022 (recommended).
- [ ] Domain-joined to the target AD domain.
- [ ] Static IP / stable DNS hostname; FQDN resolves from the Orchestrator appliance.
- [ ] Local Administrator or Domain Admin for configuration.
- [ ] A CA-issued certificate **or** ability to create a self-signed certificate.
- [ ] A **domain service account** for the Orchestrator execution context.
- [ ] (Project-specific) Any modules the project's script needs — e.g. the **RSAT
      ActiveDirectory** module for scripts that call `Get-ADGroupMember` / `Get-ADComputer`.

> **Kerberos service-account naming constraint (critical).** For Kerberos/AES the
> account's `sAMAccountName` must be long enough that
> **`UPPERCASE_REALM + sAMAccountName ≥ 16 characters`** — the JDK derives the AES
> key with that string as the salt and rejects a salt under 128 bits. Realm
> `VCF.LAB` (7 chars) therefore needs an account name of **≥ 9 chars**
> (`vcf_svc` = 7 **fails**; `vcf_svc_ps` = 10 **works**). Supply the username in
> **UPN form** (`user@domain`), never `DOMAIN\user`, for Kerberos.

---

## 3. Two ways to run the Windows-side build

### Option 1 — Automated: `Configure-vROPSHost.ps1` (recommended)

Run the embedded script (Appendix A) as Administrator on the PS host:

```powershell
.\Configure-vROPSHost.ps1 -Fqdn "pshost.vcf.lab" -ServiceAccount "VCF\vcf_svc_ps"
```

It performs, in order: RSAT AD tools, WinRM base config (Kerberos auth, memory
limit), certificate (self-signed by default, or locate an existing CA cert),
**WinRM HTTPS listener on 5986** (created via the WSMan provider), firewall rule,
service account into *Remote Management Users*, execution policy `RemoteSigned`,
script directory + NTFS permissions, and a **Base-64/PEM** certificate export for
import into Orchestrator. It prints a summary and next steps.

Common parameters (see Appendix A for the full param block):

| Parameter | Purpose | Default |
|---|---|---|
| `-Fqdn` (required) | FQDN Orchestrator will connect to; must match cert CN/SAN | — |
| `-ServiceAccount` (required) | Domain account Orchestrator uses (`DOMAIN\user`) | — |
| `-CertificateMode` | `SelfSigned` or `ExistingCA` | `SelfSigned` |
| `-CertValidityYears` | Self-signed validity | `5` |
| `-CertExportPath` | Where the PEM cert is written | `C:\PSO\Certs\` |
| `-ScriptDeployPath` | Script directory created + ACL'd | `C:\PSO\Scripts\` |
| `-WinRmMemoryLimitMB` | WinRM shell memory limit | `2048` |

The script **does not**: configure Kerberos constrained delegation (§6, AD-admin
task), import the cert into Orchestrator (§7), add the host to Orchestrator (§8),
or deploy the project's toolbox script.

**Validate the listener actually came up** (historically the top failure point):

```powershell
winrm enumerate winrm/config/listener              # expect a Transport = HTTPS / Port 5986 block
Get-NetTCPConnection -LocalPort 5986 -State Listen  # confirm 5986 is listening
```

If 5986 is absent, do **not** use the `winrm create … @{…}` form in PowerShell —
it silently fails (see Option 2, Step 4). Use the WSMan provider / `New-WSManInstance`.

### Option 2 — Manual step-by-step

Use this if you cannot run the script, or to understand/repair a single step.

#### Step 1 — Install RSAT Active Directory tools (project-dependent)

Required for scripts that use `Get-ADGroupMember` / `Get-ADComputer`.

```powershell
Add-WindowsFeature RSAT-AD-PowerShell
Get-Module -ListAvailable ActiveDirectory   # expect the ActiveDirectory module listed
```

#### Step 2 — WinRM base settings

```powershell
winrm quickconfig
winrm set winrm/config/service/auth '@{Kerberos="true"}'      # enable Kerberos on the WinRM service
winrm set winrm/config/winrs @{MaxMemoryPerShellMB="2048"}    # larger shell memory for big operations
Get-Service WinRM                                             # expect Status = Running
```

#### Step 3 — Certificate for HTTPS

- **Option A (preferred):** a certificate signed by a CA already trusted by
  Orchestrator, with the PS host FQDN as CN or SAN. No extra Orchestrator config.
- **Option B:** self-signed — must be imported into the Orchestrator trust store
  before the host is added (§7).

Generate a self-signed cert and export it as **Base-64 (PEM)**:

```powershell
$cert = New-SelfSignedCertificate `
    -CertStoreLocation cert:\localmachine\my `
    -DnsName ("pshost.vcf.lab", "pshost") `
    -NotAfter (Get-Date).AddYears(5) `
    -Provider "Microsoft RSA SChannel Cryptographic Provider" `
    -KeyLength 2048
$cert.Thumbprint     # note for Step 4

# vRO's "Import a trusted certificate from a file" requires Base-64 (PEM).
# Export-Certificate -Type CERT writes DER (binary), which vRO REJECTS. Write PEM:
@(
    '-----BEGIN CERTIFICATE-----'
    [System.Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
    '-----END CERTIFICATE-----'
) | Set-Content -Path "C:\PSO\pshost-cert.cer" -Encoding Ascii

# (Convert an existing DER cert instead:  certutil -encode der.cer base64.cer )
```

> `-NotAfter` sets a 5-year expiry; if omitted the cert expires in 1 year. An
> expired certificate breaks **every** workflow using this host — track the expiry.

#### Step 4 — WinRM HTTPS listener (port 5986)

```powershell
$thumbprint = "<paste thumbprint from Step 3>"
New-WSManInstance `
    -ResourceURI winrm/config/listener `
    -SelectorSet @{Address="*"; Transport="HTTPS"} `
    -ValueSet @{ Hostname = "pshost.vcf.lab"; CertificateThumbprint = $thumbprint }

Restart-Service WinRM -Force
winrm enumerate winrm/config/listener                 # expect Transport = HTTPS, Port 5986
Get-NetTCPConnection -LocalPort 5986 -State Listen     # confirm 5986 is listening
```

> **Do not** paste `winrm create winrm/config/listener?... @{...}` into PowerShell.
> That syntax is cmd.exe-only: PowerShell parses the unquoted `@{…}` as a hashtable
> and stringifies it before it reaches `winrm.exe`, so the listener is **silently
> not created** (only HTTP/5985 ends up listening) and no exception is raised. Use
> `New-WSManInstance` above, or run the `winrm create` form from `cmd.exe`.

#### Step 5 — Firewall

```powershell
New-NetFirewallRule -Name "WinRM-HTTPS" -DisplayName "WinRM HTTPS (port 5986)" `
    -Protocol TCP -LocalPort 5986 -Action Allow -Direction Inbound -Enabled True
```

#### Step 6 — Service account

The Orchestrator service account must:

- a) Log on via WinRM — add it to the local **Remote Management Users** group:
  ```powershell
  Add-LocalGroupMember -Group "Remote Management Users" -Member "vcf\vcf_svc_ps"
  ```
- b) Have any remote access the project needs (e.g. read `\\target\C$\...`, write the archive share).
- c) Be configured for **Kerberos constrained delegation** if the script performs a
  double-hop to remote UNC or AD (see §6).
- d) (Kerberos) Satisfy the `UPPERCASE_REALM + sAMAccountName ≥ 16` salt rule (§2).

#### Step 7 — Deploy the project's script + execution policy

```powershell
# Create the script directory, copy the project's toolbox script, set NTFS Read & Execute for the SA
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine
```

#### Step 8 — Connectivity check from the Orchestrator appliance

```bash
# From the Orchestrator appliance (SSH):
curl -v -k https://pshost.vcf.lab:5986/wsman     # expect the TCP connection to succeed (5986 open)
```

---

## 4. Certificate trust in Orchestrator

**Import the certificate BEFORE adding the host.** When HTTPS is selected, the
*Add a PowerShell host* workflow validates the server certificate against the
Orchestrator trust store immediately and offers **no** "trust anyway" option. If
the cert is untrusted the workflow fails with an SSL error.

- **Skip** if the cert is signed by a CA already trusted by Orchestrator.
- Otherwise import via **Library → Configuration → SSL Trust Manager**:
  - **Import a trusted certificate from a URL** — `https://pshost.vcf.lab:5986`
    (simplest if reachable).
    > **Proxy caveat:** if the appliance has an HTTP proxy, this outbound call is
    > routed through it and may fail with *"Unable to tunnel through proxy … 503"*
    > or *"Read timed out"*. Add the PS host FQDN / internal domain to the appliance
    > proxy bypass list, or use the file method (no outbound call).
  - **Import a trusted certificate from a file** — the Base-64/PEM `.cer` from §3.
- If the cert is signed by an **internal CA**, import the **root CA** (and any
  intermediates), not just the leaf — then every future host on that CA is trusted.

---

## 5. Kerberos configuration on the containerized Orchestrator

VCF Orchestrator 9 is containerized; Kerberos requires a `krb5.conf` **on the
Orchestrator pod** (not the PS host). Skip this section if you use Basic-over-HTTPS.

From the VCFA appliance:

```bash
sudo -i
export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl -n prelude exec -it vco-app-0 -c vco-server-app -- bash
cat > /usr/lib/vco/app-server/conf/krb5.conf <<'EOF'
[libdefaults]
    default_realm = VCF.LAB
    forwardable = true
    default_tkt_enctypes = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96 rc4-hmac
    default_tgs_enctypes = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96 rc4-hmac
    permitted_enctypes   = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96 rc4-hmac
    udp_preference_limit = 1
    dns_lookup_kdc = false
    dns_lookup_realm = false
[realms]
    VCF.LAB = {
        kdc = <your-dc-fqdn>
        default_domain = vcf.lab
    }
[domain_realm]
    .vcf.lab = VCF.LAB
    vcf.lab  = VCF.LAB
EOF
chmod 644 /usr/lib/vco/app-server/conf/krb5.conf
exit
```

Then recreate the pod and confirm the file persisted:

```bash
kubectl -n prelude delete pod vco-app-0                                                   # controller recreates it
kubectl -n prelude get pods | grep vco-app                                                # wait for all pods Ready
kubectl -n prelude exec -it vco-app-0 -c vco-server-app -- cat /usr/lib/vco/app-server/conf/krb5.conf
```

**Format rules that matter (Orchestrator uses Java's `sun.security.krb5.Config`, not MIT krb5):**

- Realm must be **UPPERCASE**. Replace `<your-dc-fqdn>`.
- The `[realms]` block must be **multi-line** — `{` as the last token on its line,
  **one key per line**, `}` on its own line, and **no `;` separators**. The
  single-line `VCF.LAB = { kdc = …; default_domain = … }` form throws
  `java.util.Vector cannot be cast to … Hashtable` at host-add.
- Save with **LF line endings, no BOM**.
- **`forwardable = true` is required for any second hop** (e.g. `Get-ADGroupMember`,
  remote UNC). Without it the ticket Orchestrator obtains is not delegatable, so the
  PS host has nothing to forward and the second hop fails even when AD delegation is
  configured on the computer account.
- `dns_lookup_kdc = false` because the KDC is pinned; set `true` only if you publish
  `_kerberos._tcp.<REALM>` SRV records instead of a fixed `kdc`.
- The path `/usr/lib/vco` is **PVC-backed**, so the file persists across pod
  restarts. Re-verify after major upgrades. Clustered Orchestrator: repeat on each `vco-app-N`.

---

## 6. The second hop (delegation) — for scripts that touch remote resources

If the project's script only runs locally on the PS host, skip this. If it queries
AD or reads/writes remote UNC, the second hop **must** be enabled — three things
must all be true:

1. **The PS host AD computer account is trusted for delegation** (AD-admin task):
   *AD Users and Computers → PS host computer account → Delegation tab →* either
   "Trust this computer for delegation to specified services only" (constrained;
   add the target `cifs` / `HOST` SPNs) or, in a lab, "…to any service."
2. **Orchestrator issues a forwardable ticket** — `forwardable = true` in `krb5.conf`
   `[libdefaults]` (§5). This is the piece most often missed.
3. **Hop 1 is genuinely Kerberos, not NTLM** — the WinRM SPN
   (`HTTP/pshost.<domain>`) must exist and Orchestrator must connect by the FQDN.
   NTLM cannot delegate at all.

After changing delegation or krb5.conf, **reboot the PS host** and **recreate the
Orchestrator PS host (shared) session** so both sides pick up fresh tickets.

**Alternative — CredSSP.** If Kerberos delegation is troublesome, enable CredSSP on
the PS host (`Enable-WSManCredSSP -Role Server`) and set the Orchestrator PS host
connection to CredSSP. CredSSP forwards the actual credential to the second hop,
sidestepping the forwardable-ticket requirement.

**Diagnostic.** RDP to the PS host, log on **as the service account**, and run the
exact command the script runs (e.g. `Get-ADGroupMember -Identity '<DN>' -Server <domain>`).
Works locally but fails from Orchestrator → it is the double-hop; fix items 2 and 3.
A second-hop failure typically surfaces as `ADServerDownException` / a socket reset
during the `NegotiateStream` handshake — an **auth** failure, not "server down".

**Lab shortcut — Basic over HTTPS.** Basic passes the credential to the PS host, so
the second hop generally works without delegation. HTTPS only; never Basic over HTTP.

```powershell
Set-Item -Path WSMan:\localhost\Service\Auth\Basic -Value $true
winrm get winrm/config/service/auth        # Basic = true; AllowUnencrypted stays false
```

---

## 7. Add the PowerShell host to Orchestrator

**Library → PowerShell → Configuration → Add a PowerShell host**:

| Field | Value |
|---|---|
| Name | descriptive, e.g. `PSO-WinRM-Host-01` |
| Host | `pshost.vcf.lab` (FQDN — must match cert CN/SAN and the WinRM SPN) |
| Port | `5986` |
| Transport | HTTPS |
| Host type | WinRM |
| Authentication | Kerberos (preferred) or Basic |
| Session mode | Shared Session (standard for service-account automation) |
| Username | `vcf_svc_ps@vcf.lab` (**UPN** for Kerberos — not `DOMAIN\user`) |
| Password | service account password |

Expect the run to reach **Completed**. Then verify **Inventory → PowerShell** shows
the host with snap-ins/cmdlets visible.

**Smoke test** before referencing the host in any workflow — run
*Library → PowerShell → Invoke a PowerShell script* with `Write-Host 'PS host connectivity test OK'`
and confirm the output.

---

## 8. Kerberos bring-up error sequence (hardened JDK)

On first configuration these surface one at a time, each behind the last. The
`krb5.conf` referenced lives on the Orchestrator pod (§5).

| Error | Cause & fix |
|---|---|
| `java.util.Vector cannot be cast to java.util.Hashtable` | The `[realms]` block is single-line and/or uses `;`. Rewrite multi-line, one key per line, no `;`, LF/no-BOM (§5). **Parsing** error, not auth. |
| `salt must be at least 128 bits` | Service-account `sAMAccountName` too short. Salt = `UPPERCASE_REALM + sAMAccountName` must be ≥ 16 chars. `VCF.LAB` (7) needs a name ≥ 9 (`vcf_svc` fails; `vcf_svc_ps` works). **Not** a krb5.conf problem. (Forcing `rc4-hmac` — no salt — bypasses it, confirming the cause; don't leave RC4 on.) |
| `Pre-authentication information was invalid (24)` (KDC_ERR_PREAUTH_FAILED) | Account found, key mismatch — almost always a **wrong/mistyped password**. Also check "must change password at next logon" / "smartcard required," and use the **UPN** form. Verify independently: `kinit user@REALM` or `runas /user:user@domain`. (A bad *username* gives error 6, not 24.) |
| `Cannot locate default realm` / `Null realm name (601)` | `default_realm` / `[domain_realm]` missing or wrong in `krb5.conf`. |
| `Clock skew too great (37)` | Appliance/DC NTP out of sync. |
| `KDC has no support for encryption type` | The account's `msDS-SupportedEncryptionTypes` excludes the enctypes in `default_tkt_enctypes`. |
| `ADServerDownException` / socket reset in `NegotiateStream` (from a script's AD/UNC call) | Second-hop delegation not carrying the credential — see §6 (forwardable ticket, Kerberos-not-NTLM, delegation on the computer account; or use CredSSP). |

---

## 9. Post-configuration checklist

- [ ] `winrm quickconfig` completed; Kerberos enabled on the WinRM service.
- [ ] WinRM shell memory limit set (2048 MB).
- [ ] HTTPS listener on 5986 bound to the correct cert thumbprint; 5986 listening.
- [ ] Firewall allows inbound TCP 5986.
- [ ] Cert CN/SAN matches the FQDN used in Orchestrator.
- [ ] Self-signed / internal-CA cert imported into the Orchestrator trust store **before** adding the host.
- [ ] Service account in *Remote Management Users*.
- [ ] Kerberos constrained delegation configured **if** a second hop is required (§6).
- [ ] `forwardable = true` in `krb5.conf` **if** a second hop uses Kerberos (§5).
- [ ] Project modules present (e.g. RSAT AD) and toolbox script deployed with NTFS ACLs.
- [ ] Execution policy `RemoteSigned` (or per policy).
- [ ] Host added via *Add a PowerShell host* and visible in Inventory → PowerShell.
- [ ] Smoke test (`Invoke a PowerShell script` with `Write-Host`) succeeds.

---

## 10. Certificate maintenance

Self-signed certs expire (5 years if `-NotAfter` was used; 1 year otherwise). An
expired cert breaks all workflows on this host. Renewal:

1. Generate a new cert (§3).
2. Update the WinRM HTTPS listener with the new thumbprint (§4).
3. Import the new cert into the Orchestrator trust store (§4).
4. Remove the old cert from the trust store if no longer needed.
5. Smoke test (§7); re-verify dependent workflows.

CA-signed certs: renew through your PKI. If the CA is already trusted, only the
WinRM listener thumbprint needs updating.

---

## Appendix A — `Configure-vROPSHost.ps1` (full source)

The runnable copy lives beside this document
(`Configure-vROPSHost.ps1`). The complete source is embedded below for reference.

```powershell
﻿#Requires -RunAsAdministrator
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
      8. Exports the certificate as Base-64 (PEM) for import into VCF Orchestrator
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
    Example: pshost.vcf.lab

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
        -Fqdn "pshost.vcf.lab" `
        -ServiceAccount "CORP\svc-vro-ps"

.EXAMPLE
    # Existing CA-issued certificate already installed
    .\Configure-vROPSHost.ps1 `
        -Fqdn "pshost.vcf.lab" `
        -ServiceAccount "CORP\svc-vro-ps" `
        -CertificateMode ExistingCA

.EXAMPLE
    # Custom export path and 3-year self-signed cert
    .\Configure-vROPSHost.ps1 `
        -Fqdn "pshost.vcf.lab" `
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
    $Warnings.Add("RSAT AD PowerShell tools not installed. Required for the Move-ArchivedLogs-ByADGroup workflow.")
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
    # Remove any existing HTTPS listener(s) via the WSMan provider so we can
    # (re)bind the current certificate. Filtering on the listener's Keys selector
    # set avoids the unpredictable Listener_<id> node names.
    $existingHttps = Get-ChildItem WSMan:\localhost\Listener -ErrorAction SilentlyContinue |
        Where-Object { $_.Keys -contains 'Transport=HTTPS' }

    if ($existingHttps) {
        Write-Warn "An existing HTTPS WinRM listener was found."
        Write-Info "Removing it to (re)bind the current certificate..."
        $existingHttps | Remove-Item -Recurse -Force
        Write-OK "Existing HTTPS listener removed."
    }

    # Create the HTTPS listener via the WSMan provider (New-Item) rather than the
    # `winrm create ... @{...}` command syntax. That syntax is cmd.exe-only: under
    # PowerShell the unquoted @{...} is parsed as a hashtable and stringified to
    # "System.Collections.Hashtable" before it reaches winrm.exe, so the listener
    # is silently never created (and, being a native-command failure, it does not
    # raise an exception - which is why the old code printed a false [OK]). The
    # provider cmdlet binds the thumbprint correctly and raises a real terminating
    # error on failure, which the catch below handles.
    Write-Info "Creating HTTPS listener bound to thumbprint $certThumbprint ..."
    New-Item -Path WSMan:\localhost\Listener `
        -Address '*' `
        -Transport HTTPS `
        -HostName $Fqdn `
        -CertificateThumbPrint $certThumbprint `
        -Force -ErrorAction Stop | Out-Null

    # Restart WinRM so the new listener binds and begins listening on 5986.
    # Safe here: this script runs locally on the host, not over a WinRM session.
    Write-Info "Restarting WinRM to activate the listener..."
    Restart-Service WinRM -Force -ErrorAction Stop

    # Verify the listener actually exists now - never report success blindly.
    $httpsListener = Get-ChildItem WSMan:\localhost\Listener -ErrorAction SilentlyContinue |
        Where-Object { $_.Keys -contains 'Transport=HTTPS' }

    if ($httpsListener) {
        Write-OK "WinRM HTTPS listener created on port 5986."
        Add-Result "WinRM HTTPS listener" "Created" "Port 5986 | Cert: $certThumbprint"
    } else {
        throw "HTTPS listener is not present after creation - WinRM did not accept the binding."
    }

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

    # vRO's "Import a trusted certificate from a file" requires a Base-64 (PEM)
    # encoded X.509 certificate.  Export-Certificate -Type CERT writes DER
    # (binary), which vRO rejects with "Could not import the SSL certificate.
    # Check whether the file contains a valid SSL certificate".  Write PEM instead.
    $certObj = Get-Item "cert:\LocalMachine\My\$certThumbprint"
    $pemLines = @(
        '-----BEGIN CERTIFICATE-----'
        [System.Convert]::ToBase64String($certObj.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
        '-----END CERTIFICATE-----'
    )
    Set-Content -Path $certExportFile -Value $pemLines -Encoding Ascii

    Write-OK "Certificate exported (Base-64 / PEM) to: $certExportFile"
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

```
