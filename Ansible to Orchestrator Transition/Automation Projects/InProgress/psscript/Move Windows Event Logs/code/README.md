# VCF Orchestrator Implementation Package
## Windows Archive Log Management — Phase 1

---

## Package Contents

```
vcf-windows-log-mgmt/
│
├── README.md                                        ← This file
├── Ansible-to-vRO-MappingTable.txt                  ← Full conversion mapping reference
├── Validation-and-Testing-Plan.txt                  ← Pre-checks, tests, success criteria, rollback
│
├── actions/
│   ├── buildMoveByADGroupInvocation.js              ← Action: builds PS invocation for AD-group move
│   ├── buildRemoveFilesInvocation.js                ← Action: builds PS invocation for UNC cleanup
│   └── parseScriptOutput.js                         ← Action: parses PSObject into structured Properties
│
├── workflows/
│   ├── Move-ArchivedLogs-ByADGroup_spec.js          ← Workflow 1: schema, bindings, end-state tasks
│   ├── Remove-OldFiles-UNCShare_spec.js             ← Workflow 2: schema, bindings, end-state tasks
│   └── handlePSFailure_scriptableTask.js            ← Shared scriptable task (exception path)
│
└── config/
    └── WindowsLogManagement-Config_definition.txt   ← Configuration Element attributes and binding guide
```

> **Consolidation note (Phase 1 update):** The package previously shipped four
> workflows (LocalHost, ByADGroupName, ByADGroupCN, Remove). The two move
> workflows that targeted by AD group are now merged into a single
> **Move-ArchivedLogs-ByADGroup** built on the recursive + Enabled-only
> resolution path (`Get-ListOfServers-ByCN`). The **LocalHost** workflow is
> removed: the Windows servers that formerly executed the scripts locally under
> Ansible are members of the AD group in the Orchestrator model and are covered
> by Move-ArchivedLogs-ByADGroup. Every `-Action` invoked already exists in the
> deployed script; the only `cvs_functions.ps1` changes are S-1 (report-only) and
> S-2…S-4 (parameterised file filter/age + resilient, logged per-server failure
> handling for the AD-group move). See `Change-Register.md`.

---

## Deployment Order

Follow this sequence exactly to avoid dependency failures.

### Step 1 — Deploy the updated PowerShell script

This package requires the **updated `cvs_functions.ps1`** (changes S-1…S-4, see
`Change-Register.md`) deployed on the PS host. Both workflows invoke `-Action`
values that already exist in the script — `move-archived-logs-ByCN` and
`Delete-OldFiles-UNC-Share` — but the AD-group move now relies on the S-2…S-4
behaviour (parameterised `-FilterOn` / `-NumberOfDays`, AD-module guard, and
resilient/logged per-server failure handling).

Verify the script is present, the actions resolve, and the updates are in place:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'  # should return True
# Confirm the action values exist in the script's [ValidateSet] on $Action:
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern "move-archived-logs-ByCN","Delete-OldFiles-UNC-Share"
# Confirm S-1 (report-only) and S-2…S-4 (resilience) are deployed:
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern "ReportOnly","ErrorAction Stop","skipping disabled computer"
# Expected: patterns found in the switch block and the Move-files / Get-ListOfServers-ByCN functions
```

### Step 2 — Create Configuration Element in vRO (Remove workflow only)

See `config/WindowsLogManagement-Config_definition.txt` for full instructions.

This element is used **only by Remove-OldFiles-UNCShare**. Move-ArchivedLogs-ByADGroup
uses plain input parameters with defaults set directly on each input — it has no
Configuration Element dependency.

- Path: `VCF/WindowsLogManagement/WindowsLogManagement-Config`
- Attributes:

| Attribute | Type | Example |
|---|---|---|
| `defaultScriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` |
| `defaultLogRetentionDays` | number | `370` |

### Step 3 — Deploy Actions

Module path: `broadcom.pso.vc.vm.guestOps.files.windows.logs`

Deploy in this order (no inter-action dependencies, but logical order helps):
1. `buildMoveByADGroupInvocation`
2. `buildRemoveFilesInvocation`
3. `parseScriptOutput`

Each `.js` file in `actions/` contains the complete action code.
Copy the code into a new action in the vRO Action editor.

**Action return types:**

| Action | Return Type |
|---|---|
| `buildMoveByADGroupInvocation` | string |
| `buildRemoveFilesInvocation` | string |
| `parseScriptOutput` | Properties |

### Step 4 — Deploy Workflows

Workflow folder: `Production >> Servers >> Windows >> Event Log Management`

- Lab/dev location: `Workflows >> Customer >> <Customer Name> >> Production >> Servers >> Windows >> Event Log Management`
  (where `Workflows` is a folder at the same level as the default `Library`).
- The **actions** stay in their module namespace
  `broadcom.pso.vc.vm.guestOps.files.windows.logs` (Step 3) — only the workflows
  use the folder path above.

Create each workflow using its `_spec.js` file as the implementation reference.
Each spec file contains:
- Full schema diagram (ASCII)
- Input/attribute/output definitions
- Action node bindings
- OOTB workflow binding
- End-state scriptable task code

**Workflow build checklist (repeat for each of the 2 workflows):**

1. Create new workflow in the correct folder
2. Add inputs as defined in the spec
3. Add attributes as defined in the spec
4. Add outputs as defined in the spec
5. Build schema:
   - Add Action node → bind to `build*Invocation` action → bind inputs and output
   - Add Exception path from Action node → End (Failed: Bad Inputs)
   - Add Workflow element → bind OOTB `Library/PowerShell/Invoke a PowerShell script`
     - Bind `host` input to `psHost`
     - Bind `script` input to `invocationString`
     - Bind `output` output to `psRawOutput`
   - Add Exception path from OOTB workflow → Scriptable Task: `handlePSFailure`
     (use code from `workflows/handlePSFailure_scriptableTask.js`)
     → End (Failed: PS Execution)
   - Add Action node → bind to `parseScriptOutput` action → bind inputs and output
   - Add Decision node → condition: `parsedResult.get("success") === true`
   - True path → Scriptable Task (success end-state code from spec) → End (Completed Successfully)
   - False path → Scriptable Task (error end-state code from spec) → End (Completed with Errors)
6. Set input defaults:
   - **Move-ArchivedLogs-ByADGroup:** set each input's default value **directly on
     the input** (no Config Element) — see the INPUTS table in its spec
     (`scriptPath`, `domainName`, `fileShareTarget`, `fileFilter`, `fileAgeDays`;
     `groupDN` has no default). Adjust environment-specific values.
   - **Remove-OldFiles-UNCShare:** bind `scriptPath` → `defaultScriptPath` and
     `olderThanDays` → `defaultLogRetentionDays` from the Config Element.
7. Configure custom form:
   - Mark all inputs mandatory
   - Add dropdown constraint on `whatIf` (Remove-OldFiles-UNCShare only): `yes` / `no`
   - Add minimum value = 1 constraint on `olderThanDays` (Remove-OldFiles-UNCShare only)
8. Save and version the workflow

---

## Critical Validation Items

Before running any workflow in production, confirm these items against your environment.
See `Validation-and-Testing-Plan.txt` for full details.

| Item | What to Confirm | Where |
|---|---|---|
| `PowerShellRemotePSObject` method names | `getRootObject()` exists and is callable | vRO Scripting API Browser |
| Script parameter names | Match what build* actions construct (`-SecurityGroup_CN`, `-UNC_SharePath` underscores) | `cvs_functions.ps1` param block |
| Script Action values | `move-archived-logs-ByCN` and `Delete-OldFiles-UNC-Share` exist in switch block | `cvs_functions.ps1` switch |
| UNC read access | PS host SA can read `\\server\C$\Windows\System32\winevt\Logs` | Test-Path from PS host |
| UNC write access | PS host SA can write to archive share | New-Item from PS host |
| Kerberos constrained delegation | PS host configured for double-hop delegation | AD delegation settings |
| RSAT AD Tools | Active Directory module available on PS host | Get-Module on PS host |

---

## Key Architectural Decisions (Summary)

| Decision | Rationale |
|---|---|
| Script reused, minimally changed (S-1…S-4) | Every invoked `-Action` already exists; changes are limited to the report-only fix (S-1) and, for the AD-group move, parameterised filter/age + resilient logged per-server failure handling (S-2…S-4) |
| Single AD-group move workflow | Consolidated from two; uses the recursive + Enabled-only path (`Get-ListOfServers-ByCN`) — the most comprehensive server-discovery method |
| LocalHost workflow removed | Former local-execution hosts are AD group members in the Orchestrator model; covered by Move-ArchivedLogs-ByADGroup |
| PS host plugin — not WinRM | vRO executes via configured PS host plugin; script handles remote access via UNC |
| UNC source paths everywhere | Standardizes all source access; eliminates need for local `C:\` path handling |
| Script handles AD resolution | Get-ListOfServers-ByCN already tested; no benefit in replicating in vRO |
| No per-server vRO loop | One workflow = one script invocation; script iterates internally |
| Form-based validation only | All input constraints enforced by custom form; no validation action nodes in schema |
| OOTB PS workflow consumed | `Library/PowerShell/Invoke a PowerShell script` used directly; no custom PS execution action |
| Actions placed directly in schema | Eliminates single-action scriptable task wrappers; ensures actions are included in package export |
| `whatIf` defaults to `yes` | Prevents accidental deletion on first scheduled run or new deployment |

---

## Phase 2 Deferred Items

| Item | Reason Deferred |
|---|---|
| Optimize `cvs_functions.ps1` logic | Out of scope for delivery replacement effort |
| Email reporting on workflow completion | Not confirmed as in-scope requirement |
| AD query within vRO natively | Script handles AD; no benefit in Phase 1 |
| Per-server status reporting in vRO | Script outputs aggregate; per-server breakdown requires script changes (Phase 2) |

> **Resolved in this update** (see `Change-Register.md`):
> - "Standardize to a single computer targeting method" — the three targeting
>   patterns are consolidated to one AD-group workflow (process changes P-2…P-4).
> - "Fix `Remove-OldFiles-UNCPath` `Read-Host` prompt" — replaced with a
>   non-interactive `-ReportOnly` mode so `whatIf='yes'` is a true report-only
>   preview (script change S-1). Requires the updated script deployed; see
>   Validation Plan A11.
