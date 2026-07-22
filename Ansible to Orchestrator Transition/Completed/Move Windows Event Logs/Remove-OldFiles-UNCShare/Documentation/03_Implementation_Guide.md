# Remove Old Files (UNC Share) — Implementation Guide

**Deliverable:** Remove-OldFiles-UNCShare
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Step 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan · WindowsLogManagement-Config_definition
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

> Follow the Steps in order. Later Steps depend on earlier ones.

---

## Prerequisites

- **PowerShell (PS) host** built and registered in Orchestrator — full procedure
  (WinRM HTTPS listener 5986, certificate, authentication, Kerberos/`krb5.conf`,
  host registration) is in the shared **"How to Build a PowerShell Host"** guide.
- **Updated `cvs_functions.ps1`** deployed on the PS host (included in this deliverable)
- **UNC archive share** reachable from the PS host with **write/delete** access for
  the service account.
- **VCF Orchestrator 9** with the PowerShell plug-in and administrative access.
- Network: Orchestrator → PS host **TCP 5986**; PS host → the UNC share (SMB 445).

---

## Step 1 — Build and register the PS host

Build the PS host (RSAT AD tools, WinRM HTTPS listener on 5986, certificate, service account into *Remote Management Users*, script directory) per the shared **"How to Build a PowerShell Host"** guide. Confirm the 5986 listener actually came up before proceeding.

> Defer all host-build detail to the PS-Host guide. Do not repeat it here.

## Step 2 — Deploy the PowerShell script

- Copy the **updated** `cvs_functions.ps1` (changes S-1…S-5 — Change-Register, shared) to the script directory, e.g. `C:\PSO\Scripts\cvs_functions.ps1`.
- Confirm the Move-relevant behavior is present:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern `
  "move-archived-logs-ByCN","ErrorAction Stop","skipping disabled computer"
```
All patterns must be found (confirms the action and the S-2…S-4 resilient behavior).

> **Set the mail domain to yours.** `cvs_functions.ps1` hardcodes an email domain: the FROM address is derived as `<PSHOST>_Do_Not_Reply@<domain>` in `$Global:MailFrom`, and the default `-MailToString` / `-MailCcString` are `admin@<domain>`. The delivered copy uses `vcf.lab`. If this action emails a report in your environment, update the `@<domain>` in `cvs_functions.ps1` (and the workflow's mail inputs) to match your AD/SMTP domain before deploying.

## Step 3 — Certificate trust in Orchestrator

If the PS host cert is self-signed or from a CA not already trusted by Orchestrator, import it (Base-64/PEM) via **Library > Configuration > SSL Trust Manager**. Full procedure in the PS-Host guide.

> 1–3 line summary only — defer to the PS-Host guide.

## Step 4 — Authentication

Choose Basic-over-HTTPS (lab) or Kerberos (production). **This choice determines whether the second hop (PS host → remote UNC) works — validate it in Step 7.** Kerberos additionally requires **constrained delegation** on the PS host's AD computer account for the second hop. Full Kerberos setup (`krb5.conf` format, realm case, salt/name-length, the bring-up error sequence) is in the PS-Host guide.

> Defer Kerberos / krb5.conf detail to the PS-Host guide.

## Step 5 — Register the PS host in Orchestrator

Register via **Library > PowerShell > Configuration > Add a PowerShell host** (Host = FQDN, Port 5986, Transport HTTPS, Auth Basic or Kerberos, Shared Session, Username in UPN form). Expect **Completed**. Auth errors map to the PS-Host guide.

---

## Step 6 — Import action and build the workflow

1. **Orchestrator Package** :
   - import the Orchestrator package com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove into Orchestrator

2. **Workflow** `Remove-OldFiles-UNCShare` (folder `Production > Servers > Windows > Event Log Management`); 
   - update the psHost variable to be the value of the PowerShell host object created as a result of Step 5

---

## Step 7 — Validation gate

Run the plan in `05_Validation_and_Testing_Plan.md`. Minimum gate:

- **`-ReportOnly` deployed** (A11) confirmed on the PS host.
- **UNC write/delete** access from the PS host under the service account (A8).
- **Report-only run** (D3): `whatIf='yes'` completes non-interactively, lists
  `[ReportOnly] WouldDelete:` lines, deletes nothing, Deletion Summary = 0.
- **Live delete** (D2): only after a reviewed preview, `whatIf='no'` against a
  non-production share deletes exactly the aged test files.

---

## Rollback considerations

- **Workflow / action / Config Element:** all items are new — disable or delete the
  imported Orchestrator objects; no existing vRO content is modified. The OOTB
  *Invoke a PowerShell script* workflow is not modified.
- **PS host script:** retain the previous `cvs_functions.ps1`; redeploy to revert
  (note: reverting S-1 restores the blocking `Read-Host` prompt under vRO).
- **Data — deletions are permanent.** There is **no automated recovery** for files
  deleted with `whatIf='no'`. Mitigation: always run report-only and review the
  `WouldDelete` list before any live delete. Ansible remains available as a fallback
  until cutover is confirmed.
