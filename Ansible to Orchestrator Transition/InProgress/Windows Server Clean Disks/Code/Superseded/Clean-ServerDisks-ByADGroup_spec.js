/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Clean-ServerDisks-ByADGroup
 * Folder:   Production >> Servers >> Windows >> Disk Cleanup
 *           (lab/dev: Workflows >> Customer >> <Customer Name> >> Production >> Servers >> Windows >> Disk Cleanup)
 *           NOTE: the action lives in the module namespace declared in the action
 *           .js file (broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup) -
 *           only the WORKFLOW folder uses the path above.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Cleans one or more disk folders (default c:\Windows\ccmcache) on every server
 *   that is a DIRECT, ENABLED member of an AD security group - deleting items older
 *   than a given age that match a file filter.  AD resolution and per-server
 *   iteration are handled entirely inside cvs_functions.ps1 via
 *   Get-ListOfServers-Direct (non-recursive, Enabled-only), which targets a specific
 *   DC via -Server $DomainName.  Deleting files is destructive, so - unlike the
 *   recursive archive-log move - membership is deliberately explicit: nested
 *   sub-groups are never expanded.
 *
 *   The servers that previously executed these PowerShell scripts under Ansible are
 *   members of the AD group in the Orchestrator model and are covered by this
 *   workflow - no separate LocalHost workflow is required.
 *
 * Maps from (Ansible playbook):
 *   - servers_diskclean.yml   (Action: clean-ServerDisk)
 *
 * Script action invoked: clean-ServerDisk
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildCleanDisksInvocation]
 *     Module: broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup
 *     IN:  scriptPath     ← workflow input: scriptPath
 *          groupDN        ← workflow input: groupDN
 *          domainName     ← workflow input: domainName
 *          folderTarget   ← workflow input: folderTarget
 *          fileFilter     ← workflow attribute: fileFilter (constant '*.*')
 *          olderThanDays  ← workflow input: olderThanDays
 *          folderIncluded ← workflow input: folderIncluded
 *          forceEnable    ← workflow input: forceEnable
 *          whatIf         ← workflow input: whatIf
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
 *     Module: broadcom.pso.vcf.vm.guestOps.files.windows.diskcleanup
 *     IN:  psOutput         ← workflow attribute: psRawOutput
 *          executionContext ← (inline expression) groupDN + " @ " + domainName + " (whatIf=" + whatIf + ")"
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
 *   dependency - every value is an operator-visible input with its own default.
 *
 *   Name           Type                        Default (set on the input)         Form
 *   ────────────── ─────────────────────────── ────────────────────────────────── ─────────────
 *   psHost         PowerShell:PowerShellHost   (none)                             Mandatory
 *   scriptPath     string                      C:\PSO\Scripts\cvs_functions.ps1   Mandatory
 *   groupDN        string                      (none)                             Mandatory
 *   domainName     string                      vcf.lab                            Mandatory
 *   folderTarget   string                      c:\Windows\ccmcache                Mandatory
 *   olderThanDays  number                      1                                  Mandatory
 *   folderIncluded boolean                     true                               Mandatory
 *   forceEnable    boolean                     false                              Mandatory
 *   whatIf         string (yes/no dropdown)    yes                                Mandatory
 *
 *   NOTE: fileFilter is NOT an operator input. It is a fixed workflow ATTRIBUTE with
 *   the constant value '*.*' (see ATTRIBUTES). '*.*' matches every file AND every
 *   folder, so FolderIncluded='yes' actually deletes folders. A restrictive filter
 *   such as '*.txt' is also applied to directory names, so folders (rarely named
 *   '*.txt') would NOT be deleted - which is why the filter is pinned to '*.*' and
 *   kept off the form. All eight production templates use '*.*'.
 *
 *   The default values above are set once on each input when the workflow is built
 *   (environment-specific values such as scriptPath / domainName should be adjusted
 *   to match your environment). The operator can override any of them at run time.
 *
 *   groupDN is the AD group distinguishedName (preferred, unambiguous) - e.g.
 *   CN=CVS-DPT-AllServers,OU=Groups,OU=Lab,DC=vcf,DC=lab. CN / sAMAccountName /
 *   GUID / SID also resolve. Passed to the script as -ADGroupMember and resolved
 *   by Get-ListOfServers-Direct (DIRECT members only).
 *
 *   folderTarget is one or more local paths to clean, comma-separated (each c:\path
 *   is rewritten inside the script to \\server\c$\path). The fixed fileFilter '*.*'
 *   attribute is passed as -FilterOn. olderThanDays is the intuitive, POSITIVE age threshold - "delete items
 *   older than N days": 4 = 4 days old or older, 1 = older than a day (the default),
 *   0 = delete everything up to now. The build action converts it to the script's
 *   negative convention (-NumberOfDays = -olderThanDays); operators never type a
 *   negative number. Rule of thumb: "delete items older than <olderThanDays> days."
 *   (Maps from the Ansible var_NumberOfDays '-1', which is olderThanDays 1.)
 *
 *   whatIf is the SAFETY GATE and the recommended default is 'yes' (report only):
 *     - 'yes' → report-only; the script lists the items that WOULD be deleted and
 *               deletes nothing.
 *     - 'no'  → live delete.
 *   Present it as a yes/no dropdown so 'no' is a deliberate operator choice. The
 *   build action logs a loud System.warn when whatIf='no'.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   fileFilter        string ('*.*')                       - Fixed filter, NOT an operator input; bound to
 *                                                            buildCleanDisksInvocation's fileFilter → -FilterOn.
 *                                                            '*.*' matches all files AND folders.
 *   invocationString  string                               - Built by buildCleanDisksInvocation
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
// Inputs: parsedResult, groupDN, domainName, whatIf
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Clean-ServerDisks-ByADGroup | Completed successfully." +
    " | groupDN=" + groupDN + " | domain=" + domainName + " | whatIf=" + whatIf +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, groupDN, domainName, whatIf
// Outputs: executionSuccess, executionOutput
//
// NOTE: This is the "completed with errors" end state, NOT a hard failure.
// Per-server failures inside the script (an unreachable server, an inaccessible
// admin share, a file that could not be deleted) are logged as "Error:" lines;
// parseScriptOutput flags success=false and the run lands here. The remaining
// servers were still processed. Only a TERMINATING failure (bad inputs, or a total
// failure such as the AD module missing / group resolution failing - where every
// clean would fail) routes to a Failed end state via handlePSFailure.

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Clean-ServerDisks-ByADGroup | Completed with errors." +
    " | groupDN=" + groupDN + " | domain=" + domainName + " | whatIf=" + whatIf +
    " | errorText=" + parsedResult.get("errorText")
);
