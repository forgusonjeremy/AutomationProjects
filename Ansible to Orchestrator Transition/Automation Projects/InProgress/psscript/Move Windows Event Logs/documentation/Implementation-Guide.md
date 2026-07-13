# Windows Archive Log Management — Implementation Guide

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Draft — Phase 1
**Companion documents:** Design Document · User Guide · PS-Host-Build-Guide.txt ·
WindowsLogManagement-Config_definition.txt · Validation-and-Testing-Plan.txt · Change-Register.md

> Follow the phases in order. Later phases depend on earlier ones.

---

## Prerequisites

- Domain-joined Windows Server for the **PowerShell (PS) host**, local admin access.
- Service account (domain) for Orchestrator → PS host, e.g. `vcf_svc_ps@vcf.lab`.
  **For Kerberos/AES the account's sAMAccountName must be long enough that
  `UPPERCASE_REALM + sAMAccountName ≥ 16 characters`** — the JDK derives the AES
  key with that string as the salt and rejects a salt under 128 bits. Realm
  `VCF.LAB` (7 chars) therefore needs a name of **≥ 9 chars** (`vcf_svc` = 7 fails;
  `vcf_svc_ps` = 10 works). Supply the username in **UPN form** (`user@vcf.lab`),
  not `DOMAIN\user`.
- **AD group(s)** whose members are the servers to process (identify by **DN**).
- **Archive file share** (UNC) writable by the service account.
- **VCF Orchestrator 9** with PowerShell plug-in and administrative access.
- Network: Orchestrator → PS host **TCP 5986**; PS host → targets **`C$`/SMB 445**
  and → archive share.
- The PS host account can read `\\<target>\C$\Windows\System32\winevt\Logs` and
  write to the archive share (validate before go-live).

---

## Phase 1 — Build the PowerShell host

Run `code/Configure-vROPSHost.ps1` as Administrator on the PS host:

```powershell
.\Configure-vROPSHost.ps1 -Fqdn "pshost.vcf.lab" -ServiceAccount "VCF\vcf_svc_ps"
```

It performs: RSAT AD tools, WinRM base config (Kerberos auth, memory limit),
certificate (self-signed by default), **WinRM HTTPS listener on 5986** (created
via the WSMan provider — change T-2), firewall rule, service account into
*Remote Management Users*, execution policy, script directory + NTFS, and a
Base-64/PEM certificate export (change T-1).

**Validate the listener actually came up** (the previous common failure point):
```powershell
winrm enumerate winrm/config/listener            # expect a Transport = HTTPS / Port 5986 block
Get-NetTCPConnection -LocalPort 5986 -State Listen
```
If 5986 is absent, re-run Step 4 logic manually (see PS-Host-Build-Guide.txt) —
do **not** use the `winrm create … @{…}` form in PowerShell (it silently fails).

---

## Phase 2 — Deploy the PowerShell script

- Copy the **updated** `cvs_functions.ps1` (changes S-1…S-5) to the script
  directory, e.g. `C:\PSO\Scripts\cvs_functions.ps1`.
- Verify:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern `
  "move-archived-logs-ByCN","Delete-OldFiles-UNC-Share","ReportOnly","ErrorAction Stop","skipping disabled computer"
```
All patterns must be found (confirms the required actions and the S-1…S-4 behavior).

---

## Phase 3 — Certificate trust in Orchestrator

- If the cert is self-signed or from a CA not already trusted by Orchestrator,
  import it: **Library > Configuration > SSL Trust Manager > Import a trusted
  certificate from a file** (Base-64/PEM export from Phase 1), or from URL
  `https://pshost.vcf.lab:5986`.
- If the signing CA is already trusted, no import is needed.

---

## Phase 4 — Authentication

Choose one. **This determines whether the second hop (PS host → remote UNC)
works — validate it in Phase 7.**

### Option A — Basic over HTTPS (fastest; lab)
On the PS host:
```powershell
Set-Item -Path WSMan:\localhost\Service\Auth\Basic -Value $true
winrm get winrm/config/service/auth     # Basic = true; AllowUnencrypted stays false
```
- Credentials are passed to the host, so the second hop generally works without
  delegation. HTTPS only.

### Option B — Kerberos (production-hardening)
1. WinRM service Kerberos auth is enabled by Phase 1. Verify:
   `winrm get winrm/config/service/auth` → `Kerberos = true`.
2. **Place `krb5.conf` in the Orchestrator pod** (VCF Orchestrator 9 is
   containerized). From the VCFA appliance:
   ```bash
   sudo -i
   export KUBECONFIG=/etc/kubernetes/admin.conf
   kubectl -n prelude exec -it vco-app-0 -c vco-server-app -- bash
   cat > /usr/lib/vco/app-server/conf/krb5.conf <<'EOF'
   [libdefaults]
       default_realm = VCF.LAB
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
   - Realm must be **UPPERCASE**. Replace `<your-dc-fqdn>`.
   - **The `[realms]` block format is critical.** Orchestrator's Kerberos parser is
     Java's `sun.security.krb5.Config`, NOT MIT krb5: the realm block must be
     **multi-line** — `{` as the last token on its line, **one key per line**, `}`
     on its own line, and **no `;` separators**. The single-line
     `VCF.LAB = { kdc = …; default_domain = … }` form throws
     `java.util.Vector cannot be cast to … Hashtable` at host-add. Save the file with
     **LF line endings and no BOM**.
   - `dns_lookup_kdc = false` because the KDC is pinned above. Set it `true` only if
     you publish `_kerberos._tcp.VCF.LAB` SRV records instead of a fixed `kdc`.
   - This path is on a **PVC-backed volume** (`/usr/lib/vco`), so it **persists**
     across pod restarts/reschedules. Re-verify after major upgrades.
   - Clustered Orchestrator: repeat on each `vco-app-N`.
3. Delete and recreate the vco pod and confirm the krb5.conf file contents
   - kubectl -n prelude delete pod vco-app-0          # controller recreates it
   - kubectl -n prelude get pods | grep vco-app       # wait for all pods to be online
   - kubectl -n prelude exec -it vco-app-0 -c vco-server-app -- cat /usr/lib/vco/app-server/conf/krb5.conf

3. **Second hop** to `\\server\C$` / `\\fileshare` additionally requires
   **Kerberos constrained delegation** on the PS host's AD computer account
   (AD-admin task; PS-Host-Build-Guide Step 1.6). Adding the host does not need
   it; the move does.

> **Known error mapping (Kerberos)** — the failures hit during initial bring-up,
> in the order they surface as each layer is fixed:
>
> - **`java.util.Vector cannot be cast to java.util.Hashtable`** → the `[realms]`
>   block in `krb5.conf` is on one line and/or uses `;` separators. Java's krb5
>   parser needs it multi-line with one key per line (see the format note in the
>   krb5.conf step). This is a **parsing** error, not auth.
> - **`salt must be at least 128 bits`** → the **service account's sAMAccountName is
>   too short**. The Kerberos AES salt = `UPPERCASE_REALM + sAMAccountName`; the
>   hardened JDK (17/21) rejects a salt under 16 chars. Realm `VCF.LAB` (7) needs a
>   name ≥ 9 chars — `vcf_svc` (7) fails, `vcf_svc_ps` (10) works. **This is NOT a
>   krb5.conf problem.** (Diagnostic: forcing `rc4-hmac` only — no salt — bypasses it
>   and confirms the cause; don't leave RC4 on.)
> - **`Pre-authentication information was invalid (24)`** (KDC_ERR_PREAUTH_FAILED) →
>   the account was found but the password-derived key didn't match: **wrong/mistyped
>   password** in ~90% of cases. Also check the account isn't "must change password at
>   next logon" or "smartcard required," and use the **UPN** username (`user@vcf.lab`),
>   not `DOMAIN\user`. Verify creds independently: `kinit user@VCF.LAB` or
>   `runas /user:user@vcf.lab cmd`. (A bad *username* gives error 6, not 24.)
> - **`Cannot locate default realm` / `Null realm name (601)`** →
>   `default_realm`/`[domain_realm]` missing or wrong in `krb5.conf`.
> - **`Clock skew too great` (37)** → appliance/DC NTP out of sync.
> - **`KDC has no support for encryption type`** → the account's
>   `msDS-SupportedEncryptionTypes` doesn't include the enctypes in
>   `default_tkt_enctypes`.

---

## Phase 5 — Register the PS host in Orchestrator

Run **Library > PowerShell > Configuration > Add a PowerShell host**:

| Field | Value |
|---|---|
| Host / IP | `pshost.vcf.lab` (FQDN — required for Kerberos) |
| Port | `5986` |
| Transport | HTTPS |
| Authentication | Basic **or** Kerberos (Phase 4) |
| Session mode | Shared Session |
| Username | `vcf_svc_ps@vcf.lab` (UPN — not `DOMAIN\user`; see salt/name note in Prerequisites) |
| Accept all certificates | as appropriate (or rely on imported trust) |

Expect the run to reach **Completed**. Auth errors map to Phase 4.

---

## Phase 6 — Import actions, Configuration Element, and workflows

1. **Configuration Element** `VCF/WindowsLogManagement/WindowsLogManagement-Config`
   — required for **Remove-OldFiles-UNCShare only** (see
   WindowsLogManagement-Config_definition.txt). Move-ArchivedLogs-ByADGroup does
   **not** use a Configuration Element:

   | Attribute | Type | Example |
   |---|---|---|
   | `defaultScriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` |
   | `defaultLogRetentionDays` | number | `370` |

2. **Actions** (module `broadcom.pso.vc.vm.guestOps.files.windows.logs`):
   `buildMoveByADGroupInvocation` (string), `buildRemoveFilesInvocation` (string),
   `parseScriptOutput` (Properties). Copy each `code/actions/*.js` body.

3. **Workflows** (folder `Production > Servers > Windows > Event Log Management`;
   lab/dev: `Workflows > Customer > <Customer Name> > Production > Servers > Windows > Event Log Management`)
   built per the `_spec.js` files:
   - **Move-ArchivedLogs-ByADGroup** inputs: `psHost`, `scriptPath`, `groupDN`,
     `domainName`, `fileShareTarget`, `fileFilter`, `fileAgeDays`. Set each input's
     default **directly on the input** (no Config Element) — values in the spec's
     INPUTS table; adjust environment-specific ones. `groupDN` has no default.
   - **Remove-OldFiles-UNCShare** inputs: `psHost`, `scriptPath`, `uncSharePath`,
     `olderThanDays`, `whatIf`. Bind `scriptPath`/`olderThanDays` to the Config
     Element attributes.
   - Wire: Action → OOTB *Invoke a PowerShell script* → `parseScriptOutput` →
     Decision (`parsedResult.get("success") === true`) → end states. Add the
     exception paths to `handlePSFailure` and to *Failed: Bad Inputs*.

4. **Custom forms:** mark inputs mandatory; for Move, set input defaults directly;
   for Remove, bind the two Config Element defaults; add the `whatIf` dropdown
   (`yes`/`no`) and `olderThanDays` minimum = 1 on the Remove workflow.

---

## Phase 7 — Validation

Run the full plan in `Validation-and-Testing-Plan.txt`. Minimum gate:

- **Second-hop check** (decides auth viability): via *Invoke a PowerShell script*
  on the registered host:
  ```powershell
  Test-Path '\\fileserver.vcf.lab\mdcarchivelog$\Windows'
  Get-ChildItem '\\<group-member>\C$\Windows\System32\winevt\Logs' -Filter 'Archive*.evtx' | Select -First 1
  ```
  Both succeed → auth carries the hop. Access-denied → fix auth/delegation before proceeding.
- **Move dry validation:** small non-critical AD group (1–2 servers); confirm
  files land in `<share>\<server-short-name>\`; confirm disabled members are
  skipped (log) and an unreachable member is logged but non-fatal (tests D1a/D1b).
- **Cleanup preview:** run Remove workflow with `whatIf='yes'`; confirm
  `[ReportOnly] WouldDelete` lines and zero deletions.

---

## Rollback considerations

- **Workflows/actions:** disable or delete the imported Orchestrator objects; no
  external state is changed by their removal.
- **PS host script:** retain the previous `cvs_functions.ps1`; redeploy it to
  revert S-1…S-5 (note: reverting removes the filter/age inputs and the resilient
  failure handling).
- **PS host config:** the WinRM HTTPS listener, firewall rule, and Basic-auth
  setting can be removed (`Remove-Item WSMan:\localhost\Listener\…`,
  `Remove-NetFirewallRule -Name WinRM-HTTPS-vRO`,
  `Set-Item WSMan:\localhost\Service\Auth\Basic $false`).
- **Kerberos:** removing `krb5.conf` from the pod reverts Kerberos config.
- **Data:** moves and deletions are not automatically reversible — validate with
  report-only / small scope first. Ansible remains available as a fallback until
  cutover is confirmed.
