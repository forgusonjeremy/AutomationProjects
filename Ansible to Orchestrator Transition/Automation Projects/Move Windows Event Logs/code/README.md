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
│   ├── buildMoveLocalHostInvocation.js              ← Action: builds PS invocation for LocalHost move
│   ├── buildMoveByGroupNameInvocation.js            ← Action: builds PS invocation for sAMAccountName move
│   ├── buildMoveByGroupCNInvocation.js              ← Action: builds PS invocation for CN-based move
│   ├── buildRemoveFilesInvocation.js                ← Action: builds PS invocation for UNC cleanup
│   └── parseScriptOutput.js                         ← Action: parses PSObject into structured Properties
│
├── workflows/
│   ├── Move-ArchivedLogs-LocalHost_spec.js          ← Workflow 1: schema, bindings, end-state tasks
│   ├── Move-ArchivedLogs-ByADGroupName_spec.js      ← Workflow 2: schema, bindings, end-state tasks
│   ├── Move-ArchivedLogs-ByADGroupCN_spec.js        ← Workflow 3: schema, bindings, end-state tasks
│   ├── Remove-OldFiles-UNCShare_spec.js             ← Workflow 4: schema, bindings, end-state tasks
│   └── handlePSFailure_scriptableTask.js            ← Shared scriptable task (exception path)
│
├── powershell/
│   └── cvs_functions_additive_changes.ps1           ← 3 additive changes to existing script (no modifications)
│
└── config/
    └── WindowsLogManagement-Config_definition.txt   ← Configuration Element attributes and binding guide
```

---

## Deployment Order

Follow this sequence exactly to avoid dependency failures.

### Step 1 — Apply PowerShell Script Changes

Open `powershell/cvs_functions_additive_changes.ps1` and apply the three changes
to the deployed `cvs_functions.ps1` on the PowerShell host:

1. Add `'move-archived-logs-ByHostList'` to the `[ValidateSet]` on `$Action`
2. Add the `$HostList` parameter to the `param()` block
3. Add the `move-archived-logs-ByHostList` switch case to the `Main` function

Verify with:
```powershell
Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'  # should return True
& 'C:\PSO\Scripts\cvs_functions.ps1' -Action 'move-archived-logs-ByHostList' -HostList '' -FileShareTarget '\\server\share'
# Expected: Write-Log error + thrown exception (HostList is required)
```

### Step 2 — Create Configuration Element in vRO

See `config/WindowsLogManagement-Config_definition.txt` for full instructions.

- Path: `VCF/WindowsLogManagement/WindowsLogManagement-Config`
- Attributes:

| Attribute | Type | Example |
|---|---|---|
| `defaultScriptPath` | string | `C:\PSO\Scripts\cvs_functions.ps1` |
| `defaultFileShareTarget` | string | `\\fileserver.corp.local\mdcarchivelog$\Windows` |
| `defaultDomainName` | string | `corp.local` |
| `defaultLogRetentionDays` | number | `370` |

### Step 3 — Deploy Actions

Module path: `broadcom.pso.vc.vm.guestOps.files.windows.logs`

Deploy in this order (no inter-action dependencies, but logical order helps):
1. `buildMoveLocalHostInvocation`
2. `buildMoveByGroupNameInvocation`
3. `buildMoveByGroupCNInvocation`
4. `buildRemoveFilesInvocation`
5. `parseScriptOutput`

Each `.js` file in `actions/` contains the complete action code.
Copy the code into a new action in the vRO Action editor.

**Action return types:**

| Action | Return Type |
|---|---|
| `buildMoveLocalHostInvocation` | string |
| `buildMoveByGroupNameInvocation` | string |
| `buildMoveByGroupCNInvocation` | string |
| `buildRemoveFilesInvocation` | string |
| `parseScriptOutput` | Properties |

### Step 4 — Deploy Workflows

Folder: `PSO >> VC >> VM >> GuestOps >> Files >> Windows >> Logs`

Create each workflow using its `_spec.js` file as the implementation reference.
Each spec file contains:
- Full schema diagram (ASCII)
- Input/attribute/output definitions
- Action node bindings
- OOTB workflow binding
- End-state scriptable task code

**Workflow build checklist (repeat for each of the 4 workflows):**

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
6. Bind Config Element defaults to inputs (see spec and config definition)
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
| `PowerShellRemotePSObject` method names | `getOutputLine()`, `getErrorLine()`, `getExitCode()` exist | vRO Scripting API Browser |
| `PowerShellHost.name` property | Returns FQDN (not display name) | vRO Scripting API Browser |
| Script parameter names | Match what build* actions construct | `cvs_functions.ps1` param block |
| Script Action values | All four `-Action` values exist in switch block | `cvs_functions.ps1` switch |
| UNC read access | PS host SA can read `\\server\C$\Windows\System32\winevt\Logs` | Test-Path from PS host |
| UNC write access | PS host SA can write to archive share | New-Item from PS host |
| Kerberos constrained delegation | PS host configured for double-hop delegation | AD delegation settings |
| RSAT AD Tools | Active Directory module available on PS host | Get-Module on PS host |

---

## Key Architectural Decisions (Summary)

| Decision | Rationale |
|---|---|
| Script reused as-is (additive only) | Minimizes rewriting risk; script logic is proven in production |
| PS host plugin — not WinRM | vRO executes via configured PS host plugin; script handles remote access via UNC |
| UNC source paths everywhere | Standardizes all source access; eliminates need for local `C:\` path handling |
| Script handles AD resolution | Get-ListOfServers and Get-ListOfServers-ByCN already tested; no benefit in replicating in vRO |
| No per-server vRO loop | One workflow = one script invocation; script iterates internally |
| Form-based validation only | All input constraints enforced by custom form; no validation action nodes in schema |
| OOTB PS workflow consumed | `Library/PowerShell/Invoke a PowerShell script` used directly; no custom PS execution action |
| Actions placed directly in schema | Eliminates single-action scriptable task wrappers; ensures actions are included in package export |
| `whatIf` defaults to `yes` | Prevents accidental deletion on first scheduled run or new deployment |

---

## Phase 2 Deferred Items

| Item | Reason Deferred |
|---|---|
| Standardize to single computer targeting method | Phase 1 preserves all three patterns to avoid forcing customer environment changes |
| Optimize `cvs_functions.ps1` logic | Out of scope for delivery replacement effort |
| Email reporting on workflow completion | Not confirmed as in-scope requirement |
| AD query within vRO natively | Script handles AD; no benefit in Phase 1 |
| Per-server status reporting in vRO | Script outputs aggregate; per-server breakdown requires script changes (Phase 2) |
