/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Move-ArchivedLogs-ByADGroup
 * Folder:   Production >> Servers >> Windows >> Event Log Management
 *           (lab/dev: Workflows >> Customer >> <Customer Name> >> Production >> Servers >> Windows >> Event Log Management)
 *           NOTE: the actions live in the module namespace declared in each
 *           action .js file (broadcom.pso.vc.vm.guestOps.files.windows.logs) -
 *           only the WORKFLOW folder uses the path above.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Moves archived .evtx log files from every server that is a member of an AD
 *   security group.  This is the single, consolidated move workflow for the
 *   package.  AD resolution and per-server iteration are handled entirely inside
 *   cvs_functions.ps1 via Get-ListOfServers-ByCN, which expands nested groups
 *   recursively, filters to enabled computer objects only, and targets a specific
 *   DC via -Server $DomainName.  This is the most comprehensive resolution path:
 *   it finds all computers requiring archive-log cleanup while skipping
 *   disabled/decommissioned accounts.
 *
 *   The servers that previously executed these PowerShell scripts under Ansible
 *   (the former "LocalHost" use case) are members of the AD group in the
 *   Orchestrator model and are covered by this workflow — no separate LocalHost
 *   workflow is required.
 *
 * Maps from (Ansible playbooks):
 *   - file-move_with-UNCPath_AD-Group
 *   - file-move_with-UNCPath_AD-Group-TEST
 *   - file-move_with-UNCPath_AD-Group-TEST(1)
 *   - move-win-archived-logs
 *   - file-move_with-LocalPath_AD-Group     (local execution hosts now covered as AD group members)
 *   - file-move_with-LocalPath_Inventory    (former local execution hosts now covered as AD group members)
 *
 * Script action invoked: move-archived-logs-ByCN
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildMoveByADGroupInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  scriptPath      ← workflow input: scriptPath
 *          groupDN         ← workflow input: groupDN
 *          domainName      ← workflow input: domainName
 *          fileShareTarget ← workflow input: fileShareTarget
 *          fileFilter      ← workflow input: fileFilter
 *          fileAgeDays     ← workflow input: fileAgeDays
 *     OUT: invocationString → workflow attribute: invocationString
 *     │
 *     ├─[Exception]──────────────────────────────────► [End - Failed: Bad Inputs]
 *     │
 *     ▼
 * [Workflow: Invoke a PowerShell script]
 *     OOTB path: Library/PowerShell/Invoke a PowerShell script
 *     IN:  host   ← workflow input: psHost
 *          script ← workflow attribute: invocationString
 *     OUT: output → workflow attribute: psRawOutput
 *     │
 *     ├─[Exception]──► [Scriptable Task: handlePSFailure] ──► [End - Failed: PS Execution]
 *     │
 *     ▼
 * [Action: parseScriptOutput]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  psOutput         ← workflow attribute: psRawOutput
 *          executionContext ← (inline expression) groupDN + " @ " + domainName
 *     OUT: parsedResult → workflow attribute: parsedResult
 *     │
 *     ▼
 * [Decision: parsedResult.get("success") === true]
 *     │ true  ──────────────────────────────────────► [End - Completed Successfully]
 *     │ false
 *     ▼
 * [End - Completed with Errors]
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   All inputs are plain workflow parameters. Their defaults are set DIRECTLY on
 *   the input (a constant default value on the workflow presentation), NOT bound
 *   to a Configuration Element. This workflow has no Configuration Element
 *   dependency — every value is an operator-visible input with its own default.
 *
 *   Name            Type                         Default (set on the input)            Form
 *   ─────────────── ──────────────────────────── ───────────────────────────────────── ─────────────
 *   psHost          PowerShell:PowerShellHost    (none)                                Mandatory
 *   scriptPath      string                       C:\PSO\Scripts\cvs_functions.ps1      Mandatory
 *   groupDN         string                       (none)                                Mandatory
 *   domainName      string                       corp.local                            Mandatory
 *   fileShareTarget string                       \\fileserver\mdcarchivelog$\Windows   Mandatory
 *   fileFilter      string                       Archive-*.evtx                        Mandatory
 *   fileAgeDays     number                       -1                                    Mandatory
 *
 *   The default values above are set once on each input when the workflow is
 *   built (environment-specific values such as scriptPath / domainName /
 *   fileShareTarget should be adjusted to match your environment). The operator
 *   can override any of them at run time.
 *
 *   groupDN is the AD group distinguishedName (preferred, unambiguous) — e.g.
 *   CN=All-Servers,OU=Groups,OU=Lab,DC=corp,DC=local.  CN / sAMAccountName /
 *   GUID / SID also resolve.  Passed to the script as -SecurityGroup_CN.
 *   fileFilter is the file-name filter passed as -FilterOn (e.g. Archive-*.evtx).
 *   fileAgeDays is passed as -NumberOfDays; the script moves files whose
 *   LastWriteTime is older than (today + fileAgeDays), so use 0 or a negative
 *   value (e.g. -1 = files last written before yesterday).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   invocationString  string                               - Built by buildMoveByADGroupInvocation
 *   psRawOutput       PowerShell:PowerShellRemotePSObject  - Output from OOTB PS workflow
 *   parsedResult      Properties                           - Output from parseScriptOutput
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUTPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   executionSuccess  boolean  - true = completed without errors
 *   executionOutput   string   - Summary message or error description
 *
 * ───────────────────────────────────────────────────────────────────────────
 * END-STATE SCRIPTABLE TASKS
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── End state: Completed Successfully ────────────────────────────────────────
// Place before [End - Completed Successfully]
// Inputs: parsedResult, groupDN, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Move-ArchivedLogs-ByADGroup | Completed successfully." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, groupDN, domainName
// Outputs: executionSuccess, executionOutput
//
// NOTE: This is the "completed with errors" end state, NOT a hard failure.
// Per-server failures inside the script (an unreachable/disabled/skipped server)
// are logged as "Error:" lines; parseScriptOutput flags success=false and the
// run lands here. The remaining servers were still processed. Only a TERMINATING
// failure (bad inputs, or a total failure such as the AD module missing / group
// resolution failing — where every move would fail) routes to a Failed end state
// via handlePSFailure.

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Move-ArchivedLogs-ByADGroup | Completed with errors." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | errorText=" + parsedResult.get("errorText")
);
