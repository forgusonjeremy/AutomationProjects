/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Remove-OldFiles-UNCShare
 * Folder:   PSO >> VC >> VM >> GuestOps >> Files >> Windows >> Logs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Deletes files older than a configurable retention threshold from a UNC
 *   share path.  When whatIf = 'yes' (default) the script performs a
 *   report-only scan with no deletions.  Set whatIf = 'no' to perform real
 *   deletions.  Default is 'yes' to prevent accidental deletion on first run
 *   or when triggered by a new schedule.
 *
 * Maps from:
 *   - remove-OldFiles-UNCPath
 *
 * Script action invoked: Delete-OldFiles-UNC-Share
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildRemoveFilesInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs
 *     IN:  scriptPath   ← workflow input: scriptPath
 *          uncSharePath ← workflow input: uncSharePath
 *          olderThanDays← workflow input: olderThanDays
 *          whatIf       ← workflow input: whatIf
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
 *          executionContext ← workflow input: uncSharePath
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
 *   ─────────────── ──────────────────────────── ───────────────────────────────────── ──────────────────────────────
 *   psHost          PowerShell:PowerShellHost    (none)                                Mandatory
 *   scriptPath      string                       defaultScriptPath (Config Element)    Mandatory
 *   uncSharePath    string                       (none)                                Mandatory
 *   olderThanDays   number                       defaultLogRetentionDays (Config Elem) Mandatory, min value = 1
 *   whatIf          string                       yes                                   Mandatory, dropdown: yes / no
 *
 * Configuration Element defaults:
 *   Path: VCF/WindowsLogManagement/WindowsLogManagement-Config
 *   Attribute: defaultScriptPath        → scriptPath default
 *   Attribute: defaultLogRetentionDays  → olderThanDays default
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   invocationString  string                               - Built by buildRemoveFilesInvocation
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
 * CUSTOM FORM NOTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   whatIf dropdown values:
 *     Display: "Yes - Report only (no deletions)"  Value: yes
 *     Display: "No  - Delete files for real"       Value: no
 *
 *   olderThanDays constraint:
 *     Minimum value: 1
 *     Add a form description: "Files older than this many days will be removed (or reported
 *     if whatIf=yes).  Default is 370 days (~13 months)."
 *
 * ───────────────────────────────────────────────────────────────────────────
 * END-STATE SCRIPTABLE TASKS
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── End state: Completed Successfully ────────────────────────────────────────
// Place before [End - Completed Successfully]
// Inputs: parsedResult, uncSharePath, olderThanDays, whatIf
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Remove-OldFiles-UNCShare | Completed successfully." +
    " | uncSharePath=" + uncSharePath +
    " | olderThanDays=" + olderThanDays +
    " | whatIf=" + whatIf +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, uncSharePath, whatIf
// Outputs: executionSuccess, executionOutput

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Remove-OldFiles-UNCShare | Completed with errors." +
    " | uncSharePath=" + uncSharePath +
    " | whatIf=" + whatIf +
    " | errorText=" + parsedResult.get("errorText")
);
