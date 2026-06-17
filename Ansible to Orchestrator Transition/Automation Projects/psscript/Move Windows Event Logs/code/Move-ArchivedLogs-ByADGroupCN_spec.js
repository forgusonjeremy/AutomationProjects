/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Move-ArchivedLogs-ByADGroupCN
 * Folder:   PSO >> VC >> VM >> GuestOps >> Files >> Windows >> Logs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Moves archived .evtx log files from servers that are members of an AD
 *   security group, resolved by Common Name (CN) with recursive expansion and
 *   Enabled-only filter.  Uses -Server $DomainName for explicit DC targeting.
 *   AD resolution and per-server iteration are handled entirely inside
 *   cvs_functions.ps1 via Get-ListOfServers-ByCN.
 *
 * Maps from:
 *   - file-move_with-UNCPath_AD-Group-TEST
 *   - file-move_with-UNCPath_AD-Group-TEST(1)
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
 * [Action: buildMoveByGroupCNInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  scriptPath      ← workflow input: scriptPath
 *          securityGroupCN ← workflow input: securityGroupCN
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
 *          executionContext ← (inline expression) securityGroupCN + " @ " + domainName
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
 *   securityGroupCN string                       (none)                                Mandatory
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
 *   invocationString  string                               - Built by buildMoveByGroupCNInvocation
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
// Inputs: parsedResult, securityGroupCN, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Move-ArchivedLogs-ByADGroupCN | Completed successfully." +
    " | groupCN=" + securityGroupCN + " | domain=" + domainName +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, securityGroupCN, domainName
// Outputs: executionSuccess, executionOutput

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Move-ArchivedLogs-ByADGroupCN | Completed with errors." +
    " | groupCN=" + securityGroupCN + " | domain=" + domainName +
    " | errorText=" + parsedResult.get("errorText")
);
