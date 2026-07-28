# Implementation Guide — Windows Server Clean Disks

This guide covers staging the PowerShell script, importing/building the Orchestrator
content, re-pointing environment-specific values (PS host, domain, script path, target
folders), and configuring the custom form. Steps assume VCF Operations Orchestrator 9
(Orchestrator Client HTML UI).

---

## 1. Prerequisites

Complete these before importing:

- [ ] **PowerShell host built and added to Orchestrator.** A Windows Server reachable
      over WinRM/HTTPS (5986) with Kerberos, added under *Library → PowerShell → hosts*
      (or the plug-in inventory). See the cross-project *How to Build a PowerShell
      Host* reference, including its Kerberos and certificate notes.
- [ ] **Kerberos constrained delegation** configured for the PS host so it can make the
      second hop to AD and to each target server's `C$` admin share.
- [ ] **ActiveDirectory module (RSAT)** installed on the PS host (the script resolves
      the group with `Get-ADGroupMember` / `Get-ADComputer`).
- [ ] **`cvs_functions.ps1` staged** on the PS host at the path you will pass as
      `scriptPath` (default `C:\PSO\Scripts\cvs_functions.ps1`). Use the current version
      containing changes **S-14 and S-15** (from `InProgress/psscript/files/cvs_functions.ps1`).
- [ ] **PS host service account permissions:** **local admin on each target server**
      (this is what grants `\\server\C$` access *and* delete rights under
      `c:\Windows\ccmcache`), plus read access to the AD group.
- [ ] **Shared actions present** — `parseScriptOutput` and `handlePSFailure`, reused
      from the Windows guest-ops logs module
      (`broadcom.pso.vcf.vm.guestOps.files.windows.logs`, delivered with the Move
      Windows Event Logs package). If that package is not installed, import it first or
      include the shared actions in this package.

> **Critical:** the `whatIf` safety gate lives **in the script (S-14/S-15)**. If the PS
> host is running an older `cvs_functions.ps1`, `-WhatIf` is accepted but **ignored**,
> and a "report-only" run will delete for real. Verify the staged script before use.

Verify the staged script on the PS host:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch `
  -Pattern 'Get-ListOfServers-Direct','[ReportOnly] WouldDelete','invalid WhatIf value','ReportOnly'
# All should match (confirms S-14 and S-15 are present).
```

---

## 2. Import / build the Orchestrator content

1. In the **Orchestrator Client**, go to **Assets → Packages**, click **Import**, and
   select the delivered `com.broadcom.pso…diskcleanup.package`.
   *(If no package has been exported yet, create the action and workflow manually per
   §3–§5 using `Code/buildCleanDisksInvocation.js` and
   `Code/Clean-ServerDisks-ByADGroup_spec.js`.)*
2. On the import dialog:
   - Review the content list (the workflow, the `buildCleanDisksInvocation` action, and
     any bundled shared actions).
   - **Certificate:** accept/trust the signing certificate if prompted.
   - Overwrite the server version only if you intend to replace an existing copy.
3. Confirm the workflow **`Clean-ServerDisks-ByADGroup`** and the action
   **`buildCleanDisksInvocation`** appear in the library.

> If `parseScriptOutput` shows as missing after import, the logs module is not present
> — import the Event Log package (or the shared actions) first, then re-open the
> workflow.

---

## 3. Create the action (if building manually)

1. **Library → Actions → New Action.**
2. Module: **`broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup`**
   Name: **`buildCleanDisksInvocation`**  Return type: **string**
3. Add inputs (all used by the script content):
   `scriptPath` (string), `groupDN` (string), `domainName` (string),
   `folderTarget` (string), `fileFilter` (string), `olderThanDays` (number),
   `folderIncluded` (boolean), `forceEnable` (boolean), `whatIf` (string).
4. Paste the contents of `Code/buildCleanDisksInvocation.js` and save.

---

## 4. Build the workflow

Workflow folder: **`Production > Servers > Windows > Disk Cleanup`**
(lab/dev: under `Workflows > Customer > <Customer Name> > …`).

**Schema** (per `Code/Clean-ServerDisks-ByADGroup_spec.js`):

1. **Action** `buildCleanDisksInvocation` → OUT `invocationString` (attribute).
   Exception path → **End - Failed: Bad Inputs**.
2. **Workflow** `Library/PowerShell/Invoke a PowerShell script`
   IN `host = psHost`, `script = invocationString`; OUT `output = psRawOutput`.
   Exception path → scriptable task **`handlePSFailure`** → **End - Failed: PS Execution**.
3. **Action** `parseScriptOutput`
   IN `psOutput = psRawOutput`, `executionContext = groupDN + " @ " + domainName + " (whatIf=" + whatIf + ")"`;
   OUT `parsedResult` (attribute, Properties).
4. **Decision** `parsedResult.get("success") === true`
   → true: **End - Completed Successfully**; false: **End - Completed with Errors**.
5. End-state scriptable tasks: use the two blocks at the bottom of the spec file to set
   `executionSuccess` / `executionOutput`.

**Attributes:**

| Attribute | Type | Value |
|---|---|---|
| **`fileFilter`** | string | **`*.*`** (fixed — see §5) |
| `invocationString` | string | (set by the build action) |
| `psRawOutput` | PowerShell:PowerShellRemotePSObject | (set by the OOTB workflow) |
| `parsedResult` | Properties | (set by `parseScriptOutput`) |

**Outputs:** `executionSuccess` (boolean), `executionOutput` (string).

---

## 5. Set the fixed file filter (do not skip)

Bind the build action's `fileFilter` input to the **workflow attribute** `fileFilter`
= `*.*`, and **leave `fileFilter` off the custom form**.

`-FilterOn` is applied to **directory names as well as files**. `*.*` matches every
file *and* every folder, so `folderIncluded = yes` actually deletes folders. A
restrictive filter such as `*.txt` matches no folders, so folders would be silently
skipped. All eight production templates use `*.*`.

---

## 6. Set environment-specific input defaults

These live on the **custom form** (workflow → **Version/Edit → Custom Form**) and/or as
input defaults:

| Field | Change to | Notes |
|---|---|---|
| `scriptPath` | Your staged path | Default `C:\PSO\Scripts\cvs_functions.ps1` |
| `domainName` | **Your AD domain** | Default is the lab value `vcf.lab` — **must** be changed |
| `groupDN` | (leave blank; operators/schedule supply it) | e.g. `CN=Security-Servers,OU=Servers,DC=vcf,DC=lab` |
| `folderTarget` | Your target path(s) | Default `c:\Windows\ccmcache`; comma-separate multiple paths |
| `olderThanDays` | `1` (cache) or `0` (profiles) | Positive: "delete items older than N days" |
| `folderIncluded` | `true` | Allows folder deletion |
| `forceEnable` | `false` (cache) / `true` (profiles) | Deletes read-only files when true |
| `whatIf` | **`yes`** | Keep report-only as the default |

### Production template values

| Use case | `folderTarget` | `olderThanDays` | `folderIncluded` | `forceEnable` |
|---|---|---|---|---|
| **Cache cleanup** (6 templates) | `c:\Windows\ccmcache` | `1` | `true` | `false` |
| **User-profile cleanup** (2 templates) | `c:\users` | `0` | `true` | `true` |

### Custom form notes
- **`whatIf`** should be a **yes/no dropdown**, defaulting to **`yes` (Report Only)**, so
  a live delete is a deliberate choice. The build action logs a loud `System.warn` when
  `whatIf = no`.
- **`olderThanDays`** is a positive number. Label it *"Delete items older than N days"*.
  Negative values are rejected by the build action.
- **`fileFilter` must not appear on the form** (see §5).

---

## 7. Validate the deployment

Run in order (full plan in `05_Validation_and_Testing_Plan.md`):

1. **Seed test data** on non-production servers:
   `lab\New-DiskCleanTestData.ps1 -ADGroup '<test group>' -DomainName <domain>`
   (add `-GrantModifyTo '<svc account>'` if the clean runs as a non-admin domain account).
2. **Report-only run** (`whatIf = yes`) against the test group. Expect
   `ReportOnly=True` and `[ReportOnly] WouldDelete: …` lines, and **nothing deleted**.
3. **Live run** (`whatIf = no`) against the test group. Confirm aged items are deleted
   and the preserved items remain (see §5 of the Design Document).
4. **Negative checks:** a powered-off/unreachable member should log an `Error:` and the
   run should end *Completed with Errors* while other servers still process.

---

## 8. Rollback

- The workflow performs no persistent change in Orchestrator; deleting the workflow and
  the `buildCleanDisksInvocation` action removes the content. Do **not** delete the
  shared `parseScriptOutput` / `handlePSFailure` actions — other packages use them.
- To revert the PowerShell behaviour, restore the previously released
  `cvs_functions.ps1` on the PS host (the pre-S-14 baseline is preserved in source
  control — see the Change Register). **Note this removes the `whatIf` safety gate** and
  reintroduces unfiltered targeting and silent failures.
- **Deleted files are not recoverable** by this automation. There is no undo — restore
  from backup/VSS if required. This is why `whatIf` defaults to report-only.
- Removing a server from the target AD group (or disabling its account) makes it
  ineligible on the next run without any workflow change.
