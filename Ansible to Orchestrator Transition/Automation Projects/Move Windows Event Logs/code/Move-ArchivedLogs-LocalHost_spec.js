/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Move-ArchivedLogs-LocalHost
 * Folder:   PSO >> VC >> VM >> GuestOps >> Files >> Windows >> Logs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Moves archived .evtx log files off the PowerShell host itself by passing
 *   the PS host's own FQDN as the HostList parameter to cvs_functions.ps1.
 *   The script constructs the UNC source path:
 *     \\<pshostfqdn>\C$\Windows\System32\winevt\Logs
 *
 * Maps from:
 *   - file-move_with-LocalPath_Inventory
 *   - file-move_with-LocalPath_AD-Group
 *
 * Script action invoked: move-archived-logs-ByHostList
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildMoveLocalHostInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  scriptPath      ← workflow input: scriptPath
 *          psHost          ← workflow input: psHost
 *          fileShareTarget ← workflow input: fileShareTarget
 *     OUT: invocationString → workflow attribute: invocationString
 *     │
 *     ├─[Exception]──────────────────────────────────► [End - Failed: Bad Inputs]
 *     │
 *     ▼
 * [Workflow: Invoke a PowerShell script]
 *     OOTB path: Library/PowerShell/Invoke a PowerShell script
 *     IN:  host   ← workflow attribute: psHost
 *          script ← workflow attribute: invocationString
 *     OUT: output → workflow attribute: psRawOutput
 *     │
 *     ├─[Exception]──► [Scriptable Task: handlePSFailure] ──► [End - Failed: PS Execution]
 *     │
 *     ▼
 * [Action: parseScriptOutput]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  psOutput         ← workflow attribute: psRawOutput
 *          executionContext ← (inline expression) psHost.name + " (LocalHost)"
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
 *   fileShareTarget string                       defaultFileShareTarget (Config Elem.) Mandatory
 *
 * Configuration Element defaults:
 *   Path: VCF/WindowsLogManagement/WindowsLogManagement-Config
 *   Attribute: defaultScriptPath      → scriptPath default
 *   Attribute: defaultFileShareTarget → fileShareTarget default
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES (workflow-scoped, not exposed as inputs/outputs)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Name              Type                                    Description
 *   ───────────────── ─────────────────────────────────────── ─────────────────────────────
 *   invocationString  string                                  PS invocation string built by action
 *   psRawOutput       PowerShell:PowerShellRemotePSObject     Raw output from OOTB PS workflow
 *   parsedResult      Properties                              Parsed result from parseScriptOutput
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUTPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Name              Type     Description
 *   ───────────────── ──────── ────────────────────────────────────────────
 *   executionSuccess  boolean  true = completed without errors
 *   executionOutput   string   Summary message or error description
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DECISION ELEMENT BINDING
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Condition (JavaScript expression on parsedResult attribute):
 *     parsedResult.get("success") === true
 *
 *   true  → End: Completed Successfully
 *     Set before end:
 *       executionSuccess = true;
 *       executionOutput  = parsedResult.get("outputText");
 *
 *   false → End: Completed with Errors
 *     Set before end:
 *       executionSuccess = false;
 *       executionOutput  = "Script completed with errors. See log for details. "
 *                          + parsedResult.get("errorText");
 *
 * ───────────────────────────────────────────────────────────────────────────
 * END-STATE SCRIPTABLE TASKS
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Place a small scriptable task before each End node to set workflow outputs.
 * These are NOT shown as separate schema nodes in the diagram above for
 * brevity — they are inline before each End node.
 */

// ── End state: Completed Successfully ────────────────────────────────────────
// Scriptable task placed immediately before [End - Completed Successfully]
// Inputs bound: parsedResult (Properties)
// Outputs bound: executionSuccess (boolean), executionOutput (string)

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Move-ArchivedLogs-LocalHost | Completed successfully." +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Scriptable task placed immediately before [End - Completed with Errors]
// Inputs bound: parsedResult (Properties)
// Outputs bound: executionSuccess (boolean), executionOutput (string)

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Move-ArchivedLogs-LocalHost | Completed with errors." +
    " | errorText=" + parsedResult.get("errorText")
);
