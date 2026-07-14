# Shared Components — Windows Archive Log Management

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Used by:** Move-ArchivedLogs-ByADGroup · Remove-OldFiles-UNCShare

> Both deliverables in this project are built on the same set of components. This
> document is the single source of truth for those shared parts; each deliverable's
> Design and Implementation guides reference this file instead of repeating it.
> The PowerShell host itself is documented in the cross-project reference
> **"How to Build a PowerShell Host"** (`Automation Projects/_Shared References/`).

---

## 1. Common placement

| Item | Value |
|---|---|
| Actions module namespace | `broadcom.pso.vc.vm.guestOps.files.windows.logs` |
| Workflow folder | `Production > Servers > Windows > Event Log Management` |
| Workflow folder (lab/dev) | `Workflows > Customer > <Customer Name> > Production > Servers > Windows > Event Log Management` |

Both workflows follow the same pattern: **build an invocation string → run it on the
PS host via the OOTB workflow → parse the result → branch to an end state.** All
Active Directory resolution and per-server iteration happen **inside the PowerShell
script**, never in Orchestrator.

---

## 2. Shared components

| Component | Type | Role | Reference |
|---|---|---|---|
| **PowerShell (PS) host** | Windows Server / plug-in host | Executes `cvs_functions.ps1`; reaches targets/shares via UNC | "How to Build a PowerShell Host" (shared reference) |
| **`cvs_functions.ps1`** | PowerShell toolbox | The reused script both workflows invoke by `-Action` | `_Shared/Code/cvs_functions.ps1`; changes in Change-Register |
| **OOTB "Invoke a PowerShell script"** | Library workflow | Runs the invocation string on the PS host, returns a `PowerShellRemotePSObject` | `Library/PowerShell/Invoke a PowerShell script` |
| **`parseScriptOutput`** | Action | Parses the PS output into `Properties{success, outputText, errorText}` | `_Shared/Code/parseScriptOutput.js` |
| **`handlePSFailure`** | Scriptable task | Shared exception path for terminating PS/plug-in failures | `_Shared/Code/handlePSFailure_scriptableTask.js` |

The **`build*Invocation` actions** and the **workflow schemas** are
deliverable-specific and documented in each deliverable's own set.

---

## 3. `cvs_functions.ps1` (shared toolbox)

- A single PowerShell script staged on the PS host (default
  `C:\PSO\Scripts\cvs_functions.ps1`). Both the retiring Ansible playbooks and the
  new Orchestrator workflows call it; the workflows select behaviour with `-Action`.
- **Actions used:** `move-archived-logs-ByCN` (Move deliverable) and
  `Delete-OldFiles-UNC-Share` (Remove deliverable) — both already existed in the
  deployed script before this project.
- **Changes (S-1 … S-5)** are recorded in `Change-Register.md`. Summary:
  - **S-1** — report-only mode (`-ReportOnly`) replaces an interactive `Read-Host`
    (Remove).
  - **S-2 … S-4** — parameterised file filter/age, AD-module guard, per-server
    `try/catch`, `-ErrorAction Stop`, and `Get-ListOfServers-ByCN` per-object
    isolation with logged disabled-server skips (Move).
  - **S-5** — removed the orphaned `move-archived-logs-ByHostList` action.
- **Deploy/verify the updated script first.** Workflow behaviour depends on S-1…S-5:
  ```powershell
  Test-Path 'C:\PSO\Scripts\cvs_functions.ps1'
  Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -Pattern `
    "move-archived-logs-ByCN","Delete-OldFiles-UNC-Share","ReportOnly","ErrorAction Stop","skipping disabled computer"
  ```

The script emits **all** output through `Write-Log` → `Write-Host` (and
`Write-Warning`). It does **not** use `Write-Output` for operational messages. This
fact drives the stream-capture contract below.

---

## 4. Stream-capture contract (critical, shared by both build actions)

Each `build*Invocation` action appends **` *>&1 | Out-String -Width 4096`** to the
invocation string. This is mandatory, not cosmetic:

- The vRO PowerShell plug-in returns **only the success (pipeline) stream** via
  `getRootObject()`. `Write-Host` / `Write-Warning` output is logged by the plug-in
  but is **not** part of the returned object. Without the redirect the OOTB workflow
  hands back a **null** output object and `parseScriptOutput` has nothing to parse.
- `*>&1` merges all streams (Info/Warning/Error/Verbose) into the success stream;
  `Out-String` collapses them to a single string the plug-in returns as a String
  root object.
- `-Width 4096` prevents `Out-String` from wrapping at the default console width
  (~80 cols). Without it, a long log line (e.g. an `Error:` line containing a UNC
  path) is split across physical lines and `parseScriptOutput`'s per-line `Error:`
  scan would capture only the first fragment.

---

## 5. `parseScriptOutput` action

| Aspect | Detail |
|---|---|
| **Module** | `broadcom.pso.vc.vm.guestOps.files.windows.logs` |
| **Inputs** | `psOutput` (`PowerShell:PowerShellRemotePSObject` — the OOTB workflow's output), `executionContext` (string; a log label only) |
| **Return** | `Properties` with keys `success` (boolean), `outputText` (string, CLIXML-decoded), `errorText` (string) |

Behaviour:

1. Calls `psOutput.getRootObject()` — expects the string produced by the
   `*>&1 | Out-String -Width 4096` redirect (§4). A null result is treated as "no
   output" (a null `psOutput` object itself throws, which routes to the failure path).
2. **Decodes CLIXML character escapes.** When the single Out-String string crosses
   the WinRM/PSRP boundary the plug-in serialises control characters as literal
   `_xNNNN_` escapes (CR/LF arrive as `_x000D__x000A_`, TAB as `_x0009_`). The action
   decodes every `_xNNNN_` back to its character so the output has real newlines and
   line-based scanning works.
3. **Scans for error lines.** Any line containing `Error:` / `error:`
   (case-insensitive) marks `success = false` and is collected into `errorText`.
   `Write-Warning` lines are treated as informational, not failures.

> **Key naming:** the returned key is **`errorText`** (not `errorLines`). Both
> workflows' end-state tasks read `parsedResult.get("errorText")`.

---

## 6. `handlePSFailure` scriptable task

- **Placement:** the exception path from the OOTB *Invoke a PowerShell script*
  element in **both** workflows → **End: Failed: PS Execution**.
- **Inputs:** `errorCode`, `errorMessage` (bound from the OOTB workflow's exception outputs).
- **Outputs:** sets `executionSuccess = false` and
  `executionOutput = "PS execution failed: " + errorMessage`; logs via `System.error`.
- Handles **terminating** failures only (host unreachable, AD module missing, group
  unresolvable). Non-terminating per-server errors are classified by
  `parseScriptOutput` instead (§7).

---

## 7. Failure-handling contract & end states (shared)

| Condition | Behaviour | End state |
|---|---|---|
| Input validation fails in a `build*` action | Action throws | **Failed: Bad Inputs** |
| Disabled AD member (Move) | Skipped during resolution, logged `Info:` | continues |
| Enabled-but-unreachable target | `-ErrorAction Stop` → `Error:` line logged, loop continues | **Completed with Errors** |
| Zero enabled members (Move) | Logged `Warn:`, clean exit | **Completed Successfully** |
| Invalid `whatIf` (Remove) | `Error:` line logged | **Completed with Errors** |
| Terminating / total failure (host down, AD module missing, group/domain unresolvable) | OOTB workflow raises → `handlePSFailure` | **Failed: PS Execution** |

`parseScriptOutput` sets `success=false` whenever an `Error:` line is present, which
routes the run to **Completed with Errors** (a soft failure — other work still ran),
distinct from the hard **Failed** states above.

> **Operational note (Move):** an AD account being *enabled* is not the same as the
> host being *reachable*. A computer whose AD account is enabled will be processed
> and will error if it is offline. To exclude a host, disable its AD account or
> remove it from the group.

---

## 8. Second hop (delegation)

Both workflows perform a second hop (PS host → remote UNC; Move also → AD). This
requires Kerberos constrained delegation + a forwardable ticket, or CredSSP, or
Basic-over-HTTPS in a lab. See **"How to Build a PowerShell Host" §6** for the full
requirement and diagnostics.
