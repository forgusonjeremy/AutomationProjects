/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Get-ServerRebootReport
 * Folder:   Production >> Servers >> Windows >> Server Reboot Management
 *           (lab/dev: Workflows >> Customer >> <Customer Name> >> Production >> Servers >> Windows >> Server Reboot Management)
 *           NOTE: the build action lives in the module namespace declared in its
 *           action .js file (broadcom.pso.vc.vm.guestOps.windows.servers.reboot) -
 *           only the WORKFLOW folder uses the path above.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   REPORT-ONLY companion to Invoke-ServerReboot. Queries every Windows server
 *   that is a member of an AD security group for its pending-reboot state and
 *   produces an HTML report (optionally emailed). NOTHING is ever rebooted.
 *   Supports BOTH physical and virtual servers: the pending check is OS-level
 *   (remote WMI/registry/SCCM), so nothing touches vCenter and hardware and VMs
 *   are treated identically.
 *
 *   AD resolution, the pending-reboot check, the pending count and the HTML
 *   report/mail are ALL handled inside cvs_functions.ps1. Orchestrator builds the
 *   invocation, runs it on the PS host, and classifies the transcript — it owns
 *   no loop and no per-server logic.
 *
 * Script action invoked: Get-ServerRebootReportStatus-ByCN
 *
 * Maps from (Ansible):
 *   - servers_reboot_report-ByCN.yml     (+ variables.txt: var_SecurityGroup_CN /
 *     var_eMailReport / mail vars)          → Get-ServerRebootReportStatus-ByCN
 *   - servers_pending_reboot_report.yml  (+ vars.txt: var_ADGroupMember / mail vars)
 *                                            → Get-ServerPendingRebootStatus (LEGACY)
 *
 *   Both Ansible variants are CONSOLIDATED onto the single hardened ByCN action in
 *   vRO (see Change-Register R-1). The legacy Get-ServerPendingRebootStatus action
 *   (raw, non-recursive Get-ADGroupMember, no Enabled/computer-class filter) is NOT
 *   invoked by this workflow; the customer's former -ADGroupMember report now runs
 *   through the recursive, Enabled-filtered, per-object-isolated ByCN resolver.
 *   For a read-only report this is a strict improvement (more complete, less noise);
 *   it is called out as a behaviour change in Change-Register R-1.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE DEPENDENCY  (important)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   parseScriptOutput and handlePSFailure are REUSED from the Event Log package's
 *   module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *   This package therefore depends on that package being installed. If the two are
 *   ever shipped independently, move those two shared components into a common
 *   module first. (Same dependency as the Invoke-ServerReboot package.)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildServerRebootReportInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.windows.servers.reboot
 *     IN:  scriptPath   ← workflow input: scriptPath
 *          groupDN      ← workflow input: groupDN
 *          domainName   ← workflow input: domainName
 *          emailReport  ← workflow input: emailReport
 *          smtpServer   ← workflow input: smtpServer
 *          mailTo       ← workflow input: mailTo
 *          mailCc       ← workflow input: mailCc
 *          mailSubject  ← workflow input: mailSubject
 *     OUT: invocationString → workflow attribute: invocationString
 *          (the script's -HeaderNotesSubstr is DERIVED from groupDN inside the
 *           action — it is a report-header label only — so it is NOT an input)
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
 *     Module: broadcom.pso.vc.vm.guestOps.files.windows.logs   (reused — see dependency note)
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
 *   All inputs are plain workflow parameters with defaults set DIRECTLY on the
 *   input (per process change P-8 — no Configuration Element dependency).
 *
 *   Name          Type                         Default                                   Form
 *   ───────────── ──────────────────────────── ───────────────────────────────────────── ──────────
 *   psHost        PowerShell:PowerShellHost    (none)                                    Mandatory
 *   scriptPath    string                       C:\PSO\Scripts\cvs_functions.ps1          Mandatory
 *   groupDN       string                       (none)                                    Mandatory
 *   domainName    string                       corp.local                                Mandatory
 *   emailReport   boolean                      true                                      Mandatory
 *   smtpServer    string                       mailrelay.corp.local                      Optional
 *   mailTo        Array/string                 (set to real recipients)                  Optional
 *   mailCc        Array/string                 (set to real recipients)                  Optional
 *   mailSubject   string                       VCF Orchestrator: Monitoring Servers Reboot status   Optional
 *
 *   (removed) headerNote — the report-header group label is now derived from
 *   groupDN inside buildServerRebootReportInvocation, so there is no separate input.
 *
 *   NO SAFETY GATE: unlike Invoke-ServerReboot there is no rebootMode input. This
 *   workflow only reads pending state and reports it; it can never reboot a server,
 *   so there is nothing to gate. There are likewise no delay / verify inputs.
 *
 *   ── groupDN is the AD group distinguishedName (preferred, unambiguous), e.g.
 *      CN=Monitoring-Servers,OU=Groups,DC=corp,DC=local. CN / sAMAccountName /
 *      GUID / SID also resolve. Passed to the script as -SecurityGroup_CN.
 *      Resolution is RECURSIVE and returns only ENABLED COMPUTER members; nested
 *      sub-groups ARE expanded, disabled accounts are skipped and logged. Recursion
 *      is correct here precisely because the run is read-only (see R-1); the reboot
 *      workflow deliberately does the opposite (non-recursive, S-7).
 *
 *   ── mailTo / mailCc are arrays of addresses; the action joins them with ',' for
 *      the script's -MailToString / -MailCcString (the script splits on ',').
 *      The FROM address is derived by the script itself
 *      ($env:COMPUTERNAME + '_Do_Not_Reply@corp.local') — there is no from input.
 *
 *   ── mailSubject is a stem; the script appends " - N of M server might required
 *      reboot" before sending, so the operator does not set the count.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   invocationString  string                               - Built by buildServerRebootReportInvocation
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
 * RUNTIME / TIMEOUT NOTE
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   A report run is a single synchronous PowerShell invocation that does one
 *   remote WMI/registry/SCCM query per resolved server, sequentially. Runtime
 *   scales roughly linearly with the group size and with how many servers are slow
 *   or unreachable (each unreachable server waits out its own RPC/WMI timeout).
 *   There is no reboot and no post-reboot wait, so runs are far shorter than
 *   Invoke-ServerReboot — but for a large group the WinRM/PSRP operation timeout on
 *   the PS host must still exceed the total query time. If runs are cut off
 *   mid-transcript, raise the PS host's MaxTimeoutms / the plug-in timeout.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE-HANDLING CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Condition                                                End state
 *   ──────────────────────────────────────────────────────── ───────────────────────────
 *   Input validation fails in buildServerRebootReportInvocation Failed: Bad Inputs
 *   Disabled AD member                                         skipped + Info: logged → continues
 *   Nested sub-group                                           expanded (recursive) → continues
 *   Unresolvable single computer object                        skipped + Warn: logged → continues
 *   Server whose pending state cannot be read                  reported "Error Accessing Server" + Error: → Completed with Errors
 *   Zero enabled members                                       empty report → Completed Successfully
 *   AD module missing / group or domain unresolvable           script throws → handlePSFailure → Failed: PS Execution
 *   PS host unreachable                                        OOTB raises   → handlePSFailure → Failed: PS Execution
 *
 *   NOTE: this workflow issues no reboots, so the RebootFailed / NotReturned
 *   conditions from Invoke-ServerReboot do not exist here. A server that cannot be
 *   queried (Get-RebootStatus catch → Write-Log "Error: ...") is the only
 *   per-server condition that drives "Completed with Errors".
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
    "Get-ServerRebootReport | Completed successfully." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, groupDN, domainName
// Outputs: executionSuccess, executionOutput
//
// NOTE: This is the "completed with errors" end state, NOT a hard failure.
// The only per-server problem a report run can hit is a server whose pending
// state could not be read (reported as "Error Accessing Server"); parseScriptOutput
// flags success=false on the resulting "Error:" line and the run lands here. Every
// other server was still queried and the HTML report was still produced and mailed.
// Only a TERMINATING failure (bad inputs, or a total failure such as the AD module
// missing / group resolution failing) routes to a Failed end state.

executionSuccess = false;
executionOutput  = "Report completed with errors — one or more servers could not be queried. " +
                   "See workflow log and the emailed report for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Get-ServerRebootReport | Completed with errors." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | errorText=" + parsedResult.get("errorText")
);
