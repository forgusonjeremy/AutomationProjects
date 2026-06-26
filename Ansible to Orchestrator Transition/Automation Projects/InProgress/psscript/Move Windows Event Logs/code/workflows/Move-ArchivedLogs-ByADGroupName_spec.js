/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Move-ArchivedLogs-ByADGroupName
 * Folder:   PSO >> VC >> VM >> GuestOps >> Files >> Windows >> Logs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Moves archived .evtx log files from servers that are members of an AD
 *   security group, resolved by sAMAccountName.  AD resolution and per-server
 *   iteration are handled entirely inside cvs_functions.ps1 via Get-ListOfServers.
 *
 * Maps from:
 *   - move-win-archived-logs
 *   - file-move_with-UNCPath_AD-Group
 *   - file-move_with-LocalPath_AD-Group
 *
 * Script action invoked: move-archived-logs
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildMoveByGroupNameInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  scriptPath      ← workflow input: scriptPath
 *          adGroupMember   ← workflow input: adGroupMember
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
 *          executionContext ← (inline expression) adGroupMember + " @ " + domainName
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
 *   adGroupMember   string                       (none)                                Mandatory
 *   domainName      string                       defaultDomainName (Config Element)    Mandatory
 *   fileShareTarget string                       defaultFileShareTarget (Config Elem.) Mandatory
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
 *   invocationString  string                               - Built by buildMoveByGroupNameInvocation
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
// Inputs: parsedResult, adGroupMember, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Move-ArchivedLogs-ByADGroupName | Completed successfully." +
    " | group=" + adGroupMember + " | domain=" + domainName +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, adGroupMember, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Move-ArchivedLogs-ByADGroupName | Completed with errors." +
    " | group=" + adGroupMember + " | domain=" + domainName +
    " | errorText=" + parsedResult.get("errorText")
);
