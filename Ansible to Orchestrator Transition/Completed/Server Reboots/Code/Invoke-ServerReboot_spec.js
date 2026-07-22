/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Invoke-ServerReboot
 * Folder:   Production >> Servers >> Windows >> Server Reboot Management
 *           (lab/dev: Workflows >> Customer >> <Customer Name> >> Production >> Servers >> Windows >> Server Reboot Management)
 *           NOTE: the build action lives in the module namespace declared in its
 *           action .js file (broadcom.pso.vc.vm.guestOps.windows.servers.reboot) -
 *           only the WORKFLOW folder uses the path above.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Reboots the Windows servers that are direct members of an AD security group
 *   AND are reporting a pending reboot.  Supports BOTH physical and virtual
 *   servers: every operation is OS-level (remote WMI/registry for the pending
 *   check, `shutdown /r /f /m \\server` for the reboot, LastBootUpTime for the
 *   return check).  Nothing touches vCenter, so hardware and VMs are treated
 *   identically.
 *
 *   AD resolution, the pending-reboot check, per-server iteration, the
 *   inter-server delay, post-reboot verification and the HTML report/mail are ALL
 *   handled inside cvs_functions.ps1.  Orchestrator builds the invocation, runs it
 *   on the PS host, and classifies the transcript — it owns no loop and no timing.
 *
 * Script action invoked: Invoke-ServerReboot
 *
 * Maps from (Ansible):
 *   - servers_reboot.yml  (+ vars.txt: var_ADGroupMember / var_RebootIt /
 *     var_RebootIt_DelayBetweenServer / var_eMailReport / mail vars)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE DEPENDENCY  (important)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   parseScriptOutput and handlePSFailure are REUSED from the Event Log package's
 *   module:  broadcom.pso.vc.vm.guestOps.files.windows.logs
 *   This package therefore depends on that package being installed. If the two are
 *   ever shipped independently, move those two shared components into a common
 *   module first.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Action: buildServerRebootInvocation]
 *     Module: broadcom.pso.vc.vm.guestOps.windows.servers.reboot
 *     IN:  scriptPath             ← workflow input: scriptPath
 *          groupDN                ← workflow input: groupDN
 *          domainName             ← workflow input: domainName
 *          rebootMode             ← workflow input: rebootMode
 *          delayBetweenServersSec ← workflow input: delayBetweenServersSec
 *          verifyTimeoutSec       ← workflow input: verifyTimeoutSec
 *          verifyPollSec          ← workflow input: verifyPollSec
 *          runPreRebootScript     ← workflow input: runPreRebootScript
 *          emailReport            ← workflow input: emailReport
 *          smtpServer             ← workflow input: smtpServer
 *          mailTo                 ← workflow input: mailTo
 *          mailCc                 ← workflow input: mailCc
 *          mailSubject            ← workflow input: mailSubject
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
 *   Name                    Type                         Default                                  Form
 *   ─────────────────────── ──────────────────────────── ──────────────────────────────────────── ──────────
 *   psHost                  PowerShell:PowerShellHost    (none)                                   Mandatory
 *   scriptPath              string                       C:\PSO\Scripts\cvs_functions.ps1         Mandatory
 *   groupDN                 string                       (none)                                   Mandatory
 *   domainName              string                       vcf.lab                               Mandatory
 *   rebootMode              string                       no                                       Mandatory
 *   delayBetweenServersSec  number                       10                                       Mandatory
 *   verifyTimeoutSec        number                       600                                      Mandatory
 *   verifyPollSec           number                       15                                       Mandatory
 *   runPreRebootScript      boolean                      false                                    Mandatory
 *   emailReport             boolean                      true                                     Mandatory
 *   smtpServer              string                       mailrelay.vcf.lab                     Optional
 *   mailTo                  Array/string                 (set to real recipients)                 Optional
 *   mailCc                  Array/string                 (set to real recipients)                 Optional
 *   mailSubject             string                       VCF Orchestrator: Server Reboot status   Optional
 *
 *   (removed) headerNote — the report-header group label is now derived from
 *   groupDN inside buildServerRebootInvocation, so there is no separate input.
 *
 *   ── rebootMode is the SAFETY GATE. It maps to the script's -RebootIt parameter:
 *      'simpleMode' = actually reboot.  ANY other value (default 'no') = report
 *      only: pending servers are detected and reported but NOT rebooted.
 *      The default is deliberately 'no' so an accidental run cannot reboot
 *      production. Recommended presentation: a predefined-answers list of
 *      exactly 'no' and 'simpleMode'.
 *
 *   ── groupDN is the AD group distinguishedName (preferred, unambiguous), e.g.
 *      CN=Security-Reboot-Servers,OU=Groups,DC=vcf,DC=lab. CN / sAMAccountName
 *      / GUID / SID also resolve. Passed to the script as -ADGroupMember.
 *      Only DIRECT (non-recursive) enabled COMPUTER members are targeted; nested
 *      sub-groups are never expanded.
 *
 *   ── verifyTimeoutSec is the per-server budget for a rebooted server to come
 *      back (LastBootUpTime must advance). Servers that do not return in time are
 *      reported NotReturned, which surfaces as an Error: line → Completed with Errors.
 *
 *   ── runPreRebootScript (S-13) defaults to FALSE and should stay that way unless
 *      security has reviewed it. It runs ownership_w2k.ps1 on each server before
 *      rebooting it; that script takes ownership of and loosens the ACLs on
 *      c:\windows\inf\usbstor.inf (the USB mass-storage driver INF — a common
 *      hardening DENY target) and c:\windows\system32\termsrv.dll (Terminal
 *      Services). Because of defect S-6 this step has NEVER actually executed, so
 *      turning it on is a security-posture CHANGE, not a restoration of previous
 *      behaviour. When enabled, a failure is logged as an Error: and the server is
 *      still rebooted.
 *
 *   ── mailTo / mailCc are arrays of addresses; the action joins them with ',' for
 *      the script's -MailToString / -MailCcString (the script splits on ',').
 *      The FROM address is derived by the script itself
 *      ($env:COMPUTERNAME + '_Do_Not_Reply@vcf.lab') — there is no from input.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   invocationString  string                               - Built by buildServerRebootInvocation
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
 * RUNTIME / TIMEOUT NOTE  (read before first production run)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   A real run takes roughly:
 *       (pending servers x delayBetweenServersSec) + up to verifyTimeoutSec
 *   because reboots are issued sequentially and then verified in a SINGLE pass
 *   (all servers reboot concurrently in reality). Example: 20 pending servers at
 *   10s delay + 600s verify ≈ 200s + <=600s ≈ 13 minutes.
 *
 *   This is one synchronous PowerShell invocation, so the WinRM/PSRP operation
 *   timeout on the PS host must exceed that worst case. If runs are cut off
 *   mid-transcript, raise the PS host's MaxTimeoutms / the plug-in timeout rather
 *   than shortening verifyTimeoutSec.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE-HANDLING CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Condition                                            End state
 *   ──────────────────────────────────────────────────── ───────────────────────────
 *   Input validation fails in buildServerRebootInvocation  Failed: Bad Inputs
 *   Disabled AD member                                     skipped + Info: logged → continues
 *   Sub-group / user object in the group                   ignored (never expanded) → continues
 *   Server with no pending reboot                          Skipped-NoRebootRequired → continues
 *   Server whose pending state cannot be read              Skipped-StatusUnknown + Error: → Completed with Errors
 *   shutdown command rejected                              RebootFailed + Error:     → Completed with Errors
 *   Server does not return within verifyTimeoutSec         NotReturned + Error:      → Completed with Errors
 *   Zero enabled direct members                            Warn: + clean exit        → Completed Successfully
 *   AD module missing / group or domain unresolvable       script throws → handlePSFailure → Failed: PS Execution
 *   PS host unreachable                                    OOTB raises   → handlePSFailure → Failed: PS Execution
 *
 * ───────────────────────────────────────────────────────────────────────────
 * END-STATE SCRIPTABLE TASKS
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── End state: Completed Successfully ────────────────────────────────────────
// Place before [End - Completed Successfully]
// Inputs: parsedResult, groupDN, domainName, rebootMode
// Outputs: executionSuccess, executionOutput

executionSuccess = true;
executionOutput  = parsedResult.get("outputText");

System.log(
    "Invoke-ServerReboot | Completed successfully." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | rebootMode=" + rebootMode +
    " | output=" + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: parsedResult, groupDN, domainName, rebootMode
// Outputs: executionSuccess, executionOutput
//
// NOTE: This is the "completed with errors" end state, NOT a hard failure.
// Per-server problems inside the script — a server whose pending state could not
// be read (skipped, never force-rebooted), a rejected shutdown command, or a
// server that did not return within verifyTimeoutSec — are logged as "Error:"
// lines; parseScriptOutput flags success=false and the run lands here. The
// remaining servers were still processed and the HTML report was still produced
// and mailed. Only a TERMINATING failure (bad inputs, or a total failure such as
// the AD module missing / group resolution failing) routes to a Failed end state.

executionSuccess = false;
executionOutput  = "Script completed with errors. See workflow log and the emailed report for details. Error: " +
                   parsedResult.get("errorText");

System.warn(
    "Invoke-ServerReboot | Completed with errors." +
    " | groupDN=" + groupDN + " | domain=" + domainName +
    " | rebootMode=" + rebootMode +
    " | errorText=" + parsedResult.get("errorText")
);
