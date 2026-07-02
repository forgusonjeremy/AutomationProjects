/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Move-ArchivedLogs-ByADGroup
 * Folder:   PSO >> VC >> VM >> GuestOps >> Files >> Windows >> Logs
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
 *          adGroup         ← workflow input: adGroup
 *          domainName      ← workflow input: domainName
 *          fileShareTarget ← workflow input: fileShareTarget
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
 *          executionContext ← (inline expression) adGroup + " @ " + domainName
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
 *   Name            Type                         Default                               Form
 *   ─────────────── ──────────────────────────── ───────────────────────────────────── ─────────────
 *   psHost          PowerShell:PowerShellHost    (none)                                Mandatory
 *   scriptPath      string                       defaultScriptPath (Config Element)    Mandatory
 *   adGroup         string                       (none)                                Mandatory
 *   domainName      string                       defaultDomainName (Config Element)    Mandatory
 *   fileShareTarget string                       defaultFileShareTarget (Config Elem.) Mandatory
 *
 *   adGroup accepts any unambiguous AD group identifier (sAMAccountName, CN,
 *   distinguishedName, GUID, or SID).  Passed to the script as -SecurityGroup_CN.
 *
 * Configuration Element defaults:
 *   Path: VCF/WindowsLogManagement/WindowsLogManagement-Config
 *   Attribute: defaultScriptPath      → scriptPath default
 *   Attribute: defaultDomainName      → domainName default
 *   Attribute: defaultFileShareTarget → fileShareTarget default
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
// Inputs: parsedResult, adGroup, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Move-ArchivedLogs-ByADGroup | Completed successfully." +
    " | adGroup=" + adGroup + " | domain=" + domainName +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, adGroup, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Move-ArchivedLogs-ByADGroup | Completed with errors." +
    " | adGroup=" + adGroup + " | domain=" + domainName +
    " | errorText=" + parsedResult.get("errorText")
);
