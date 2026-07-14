# Move Archived Logs (By AD Group) — Implementation Guide

**Deliverable:** Move-ArchivedLogs-ByADGroup
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

> Follow the phases in order. Later phases depend on earlier ones.

---

## Prerequisites

- Domain-joined Windows Server for the **PS host**, local admin access.
- Service account (domain, UPN form) for Orchestrator → PS host. For Kerberos/AES the account name must satisfy `UPPERCASE_REALM + sAMAccountName ≥ 16 chars` (salt length) — defer detail to the PS-Host guide, but plan the name accordingly.
- **RSAT ActiveDirectory module** on the PS host (`Get-ADGroupMember` / `Get-ADComputer`).
- **AD group(s)** whose members are the servers to process (identify by **DN**).
- **Archive file share** (UNC) writable by the service account.
- **VCF Orchestrator 9** with the PowerShell plug-in and administrative access.
- Network: Orchestrator → PS host **TCP 5986**; PS host → targets **`C$`/SMB 445** and → archive share.

## Phase 1 — Build and register the PS host

Build the PS host (RSAT AD tools, WinRM HTTPS listener on 5986, certificate, service account into *Remote Management Users*, script directory) per the shared **"How to Build a PowerShell Host"** guide. Confirm the 5986 listener actually came up before proceeding.

> Defer all host-build detail to the PS-Host guide. Do not repeat it here.

## Phase 2 — Deploy the PowerShell script

- Copy the **updated** `cvs_functions.ps1` (changes S-1…S-5 — Change-Register, shared) to the script directory, e.g. `C:\PSO\Scripts\cvs_functions.ps1`.
- Confirm the Move-relevant behavior is present:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern `
  "move-archived-logs-ByCN","ErrorAction Stop","skipping disabled computer"
```
All patterns must be found (confirms the action and the S-2…S-4 resilient behavior).

## Phase 3 — Certificate trust in Orchestrator

If the PS host cert is self-signed or from a CA not already trusted by Orchestrator, import it (Base-64/PEM) via **Library > Configuration > SSL Trust Manager**. Full procedure in the PS-Host guide.

> 1–3 line summary only — defer to the PS-Host guide.

## Phase 4 — Authentication

Choose Basic-over-HTTPS (lab) or Kerberos (production). **This choice determines whether the second hop (PS host → remote UNC) works — validate it in Phase 7.** Kerberos additionally requires **constrained delegation** on the PS host's AD computer account for the second hop. Full Kerberos setup (`krb5.conf` format, realm case, salt/name-length, the bring-up error sequence) is in the PS-Host guide.

> Defer Kerberos / krb5.conf detail to the PS-Host guide.

## Phase 5 — Register the PS host in Orchestrator

Register via **Library > PowerShell > Configuration > Add a PowerShell host** (Host = FQDN, Port 5986, Transport HTTPS, Auth Basic or Kerberos, Shared Session, Username in UPN form). Expect **Completed**. Auth errors map to the PS-Host guide.

## Phase 6 — Import action and build the workflow

1. **Action** (module `broadcom.pso.vc.vm.guestOps.files.windows.logs`):
   - `buildMoveByADGroupInvocation` — return type **string**. Copy the action body from `Code/buildMoveByADGroupInvocation.js`.
   - `parseScriptOutput` — shared (return type Properties). See Shared-Components.md; import if not already present.

2. **Workflow** `Move-ArchivedLogs-ByADGroup` (folder `Production > Servers > Windows > Event Log Management`; lab/dev under `Workflows > Customer > <Customer Name> > …`), built per `Code/Move-ArchivedLogs-ByADGroup_spec.js`:

   **Inputs** — plain workflow parameters; set each default **directly on the input** (no Configuration Element):

   | Name | Type | Default (on the input) | Form |
   |---|---|---|---|
   | `psHost` | `PowerShell:PowerShellHost` | (none) | Mandatory |
   | `scriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` | Mandatory |
   | `groupDN` | string | **(none — per run)** | Mandatory |
   | `domainName` | string | `corp.local` (adjust) | Mandatory |
   | `fileShareTarget` | string | `\\fileserver\mdcarchivelog$\Windows` (adjust) | Mandatory |
   | `fileFilter` | string | `Archive-*.evtx` | Mandatory |
   | `fileAgeDays` | number | `-1` | Mandatory |

   **Attributes:** `invocationString` (string), `psRawOutput` (`PowerShell:PowerShellRemotePSObject`), `parsedResult` (Properties).
   **Outputs:** `executionSuccess` (boolean), `executionOutput` (string).

   **Schema (wire per the `_spec.js`):**
   - `Start` → **Action `buildMoveByADGroupInvocation`** (IN: scriptPath, groupDN, domainName, fileShareTarget, fileFilter, fileAgeDays; OUT: `invocationString`). Exception → **End - Failed: Bad Inputs**.
   - → **OOTB `Invoke a PowerShell script`** (IN: host ← `psHost`, script ← `invocationString`; OUT: `psRawOutput`). Exception → **Scriptable task `handlePSFailure`** → **End - Failed: PS Execution**.
   - → **Action `parseScriptOutput`** (IN: psOutput ← `psRawOutput`, executionContext ← inline `groupDN + " @ " + domainName`; OUT: `parsedResult`).
   - → **Decision `parsedResult.get("success") === true`**: true → **End - Completed Successfully**; false → **End - Completed with Errors**.
   - End-state scriptable tasks set `executionSuccess` / `executionOutput` per the `_spec.js` (success = `outputText`; errors = message + `errorText`).

3. **Custom form:** mark all inputs mandatory; input defaults are set directly on the inputs (no Config Element binding for this workflow). `groupDN` has no default and must be supplied per run.

## Phase 7 — Validation gate

Run the plan in `05_Validation_and_Testing_Plan.md`. Minimum gate:

- **Second-hop check** (decides auth viability) via *Invoke a PowerShell script* on the registered host:
  ```powershell
  Test-Path '\\fileserver.vcf.lab\mdcarchivelog$\Windows'
  Get-ChildItem '\\<group-member>\C$\Windows\System32\winevt\Logs' -Filter 'Archive*.evtx' | Select -First 1
  ```
  Both succeed → auth carries the hop. Access-denied → fix auth/delegation first.
- **Move dry validation:** small non-critical AD group (1–2 servers); confirm files land in `<share>\<server-short-name>\`; confirm a disabled member is skipped (log) and an enabled-but-unreachable member is logged but non-fatal (tests D1a/D1b).

## Rollback

- **Workflow/action:** disable or delete the imported Orchestrator objects; no external state is changed by their removal.
- **PS host script:** retain the previous `cvs_functions.ps1`; redeploy to revert S-1…S-5 (reverting removes the filter/age inputs and the resilient failure handling).
- **Moved files:** moves are not automatically reversible — files are moved, not deleted; match server short name to the per-server destination to move them back manually. Validate on a small scope first.
- **PS host config / Kerberos:** revert per the PS-Host guide (remove HTTPS listener, firewall rule, Basic-auth setting; remove `krb5.conf` from the pod).
- Ansible remains available as a fallback until cutover is confirmed.
