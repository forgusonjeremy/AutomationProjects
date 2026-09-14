/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Invoke Server Reboot
 * Folder:   Production >> Servers >> Windows >> Server Reboot Management
 *           (lab/dev: Workflows >> Customer >> <Customer Name> >> Production >>
 *            Servers >> Windows >> Server Reboot Management)
 * Module:   com.broadcom.pso.windows.servers.reboot
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Reboots the Windows servers that are DIRECT members of an AD security group
 *   AND are reporting a pending reboot. Supports BOTH physical and virtual
 *   servers: every operation is OS-level (remote WMI/registry for the pending
 *   check, `shutdown /r /f /m \\server` for the reboot, LastBootUpTime for the
 *   return check). Nothing touches vCenter, so hardware and VMs are identical.
 *
 * Replaces (Ansible):
 *   servers_reboot.yml  (+ vars.txt: var_ADGroupMember / var_RebootIt /
 *   var_RebootIt_DelayBetweenServer / var_eMailReport / the mail vars)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW THIS DIFFERS FROM THE EARLIER DESIGN  (supersedes P-9, P-10 and P-13)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   The first cut of this package followed the Ansible shape: cvs_functions.ps1
 *   was PRE-STAGED on the PowerShell host, Orchestrator built a long invocation
 *   string against a `scriptPath` input, called the OOTB "Invoke a PowerShell
 *   script" workflow, and scraped the transcript. AD resolution, iteration,
 *   timing, verification and reporting all stayed inside the 3,356-line shared
 *   toolbox; Orchestrator passed values through and classified the output.
 *
 *   It now follows the Move Archived Logs pattern instead:
 *
 *     Script storage    a purpose-built Invoke-ServerReboot.ps1 held in
 *                       Orchestrator as a Resource Element, copied to the host at
 *                       run time, run, and deleted. Nothing is pre-staged, so
 *                       there is no staged copy to drift out of date with the
 *                       version Orchestrator holds, and the run record shows
 *                       exactly which script ran.
 *
 *     Execution         the shared runPowerShellScript action, which is the only
 *                       component that knows anything about the PowerShell
 *                       plug-in. Parameters go in as a Properties bag rather than
 *                       a hand-built command line, so no quoting is done by hand.
 *
 *     AD resolution     Orchestrator's AD plug-in, via getGroupComputersDirect.
 *                       The script no longer talks to Active Directory at all --
 *                       it is handed -ComputerNames. This removes the
 *                       ActiveDirectory-module dependency from the PS host and
 *                       puts the target list in the run record, where it can be
 *                       read before anything is rebooted.
 *
 *     Result contract   the script writes ONE line, PSO_RESULT={json}. The old
 *                       design inferred success by scanning the transcript for
 *                       "Error:" text, so a reworded log line could change the
 *                       workflow's end state.
 *
 *   What did NOT change is the targeting rule. S-7 stands: DIRECT members only,
 *   computer objects only, enabled only. It is now enforced in
 *   getGroupComputersDirect rather than in Get-ListOfServers-Direct.
 *
 *   P-13 (deriving the report header from the group) is superseded in mechanism
 *   but kept in intent: the header is now taken from the RESOLVED group object,
 *   which is a stronger guarantee than parsing it out of an operator's string.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE DEPENDENCY -- read before building
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Five components are SHARED with the Move Archived Logs / Remove Old Archived
 *   Logs packages and are delivered here so this package can be installed on its
 *   own:
 *
 *       runPowerShellScript.js    selectPowerShellHost.js
 *       resolveAdGroup.js         findAdHostForDn.js
 *       probeAdPlugin.js
 *
 *   If either of those packages is already installed in this Orchestrator, these
 *   actions ALREADY EXIST. Create each one ONCE and let all three workflows call
 *   it. A second copy under a different name drifts silently from the first.
 *   Their module is com.broadcom.pso.windows.logs.
 *
 *   Everything else below is this package's own, in
 *   com.broadcom.pso.windows.servers.reboot.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BEFORE ANYTHING ELSE
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Run the probeAdPlugin action once. It changes nothing and prints exactly what
 *   this Orchestrator's plug-ins offer -- which AD endpoints are registered, how
 *   this plug-in version reports group membership, how many PowerShell hosts
 *   exist, and whether Invoke-ServerReboot.ps1 has been imported. It is the
 *   fastest way to find out whether the environment is set up the way this
 *   workflow expects.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     │
 *     ▼
 * [Decision: adGroup !== null]
 *     │ true ─────────────────────────────────────┐
 *     │ false                                     │
 *     ▼                                           │
 * [Action: findAdHostForDn]                       │
 *     Module: com.broadcom.pso.windows.logs       │   (shared)
 *     IN:  distinguishedName ← input: adGroupDn   │
 *     OUT: adHost → attribute: adHost             │
 *     │                                           │
 *     ▼                                           │
 * [Action: resolveAdGroup]                        │
 *     Module: com.broadcom.pso.windows.logs       │   (shared)
 *     IN:  adGroupDn ← input: adGroupDn           │
 *          adHost    ← attribute: adHost          │
 *     OUT: group → attribute: group               │
 *     │                                           │
 *     ├───────────────────────────────────────────┘
 *     ▼          (the true branch binds adGroup straight to attribute: group)
 * [Action: getGroupComputersDirect]
 *     Module: com.broadcom.pso.windows.servers.reboot
 *     IN:  adGroup ← attribute: group
 *     OUT: computerNames → attribute: computerNames
 *     ── DIRECT members only. Nested groups are NOT expanded (S-7).
 *     │
 *     ├─[Exception]──────────────────────────────► [End - Failed: AD Resolution]
 *     │
 *     ▼
 * [Action: selectPowerShellHost]
 *     Module: com.broadcom.pso.windows.logs            (shared)
 *     IN:  psHost ← workflow input: psHost  (may be empty)
 *     OUT: host → attribute: resolvedHost
 *     │
 *     ▼
 * [Scriptable Task: Create Script Parameters]     ← task_CreateScriptParameters.js
 *     IN:  computerNames          ← attribute: computerNames
 *          groupName              ← (inline expression) group.name
 *          rebootMode             ← workflow input
 *          delayBetweenServersSec ← workflow input
 *          verifyTimeoutSec       ← workflow input
 *          verifyPollSec          ← workflow input
 *          runPreRebootScript     ← workflow input
 *          preRebootScriptPath    ← workflow input
 *          emailReport            ← workflow input
 *          smtpServer             ← workflow input
 *          mailTo                 ← workflow input
 *          mailCc                 ← workflow input
 *          mailSubject            ← workflow input
 *     OUT: scriptParameters → attribute: scriptParameters
 *     │
 *     ├─[Exception]──────────────────────────────► [End - Failed: Bad Inputs]
 *     │
 *     ▼
 * [Action: runPowerShellScript]
 *     Module: com.broadcom.pso.windows.logs            (shared)
 *     IN:  psHost     ← attribute: resolvedHost
 *          script     ← attribute: rebootScript   (the Resource Element)
 *          parameters ← attribute: scriptParameters
 *     OUT: scriptRunResult → attribute: scriptRunResult
 *     │
 *     ├─[Exception]──────────────────────────────► [End - Failed: PS Execution]
 *     │
 *     ▼
 * [Scriptable Task: Parse Result]                 ← task_ParseResult.js
 *     IN:  scriptRunResult ← attribute: scriptRunResult
 *          groupName       ← (inline expression) group.name
 *     OUT: executionSuccess, executionOutput, serversChecked,
 *          serversRebooted, serversPending, transcript → workflow outputs
 *     │
 *     ▼
 * [Decision: executionSuccess === true]
 *     │ true  ───────────────────────────────────► [End - Completed Successfully]
 *     │ false
 *     ▼
 * [End - Completed with Errors]
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   All inputs are plain workflow parameters with defaults set DIRECTLY on the
 *   input (process change P-8 -- no Configuration Element dependency).
 *
 *   Name                    Type                       Default                                Form
 *   ─────────────────────── ────────────────────────── ────────────────────────────────────── ─────────
 *   adGroup                 AD:UserGroup               (none)                                 Optional
 *   adGroupDn               string                     (none)                                 Optional
 *   psHost                  PowerShell:PowerShellHost  (none)                                 Optional
 *   rebootMode              string                     no                                     Mandatory
 *   delayBetweenServersSec  number                     10                                     Mandatory
 *   verifyTimeoutSec        number                     600                                    Mandatory
 *   verifyPollSec           number                     15                                     Mandatory
 *   runPreRebootScript      boolean                    false                                  Mandatory
 *   preRebootScriptPath     string                     (none)                                 Optional
 *   emailReport             boolean                    true                                   Mandatory
 *   smtpServer              string                     mailrelay.vcf.lab                      Optional
 *   mailTo                  Array/string               (set to real recipients)               Optional
 *   mailCc                  Array/string               (set to real recipients)               Optional
 *   mailSubject             string                     VCF Orchestrator: Server Reboot status Optional
 *
 *   ── adGroup / adGroupDn: ONE of the two is required. An operator picks a group
 *      from the tree (adGroup) and types nothing. Scheduled and API runs have
 *      nobody to click, so they pass the distinguishedName as text (adGroupDn) and
 *      the workflow resolves it. When both are set, adGroup wins.
 *
 *      Present adGroup first in the form. Everything a person needs is a picker.
 *
 *   ── psHost: leave empty when one PowerShell host is registered --
 *      selectPowerShellHost finds it. It only has to be answered when there is a
 *      genuine choice to make.
 *
 *   ── rebootMode is THE SAFETY GATE. 'simpleMode' actually reboots. ANY other
 *      value (default 'no') is a report-only run: pending servers are detected
 *      and reported but NOT rebooted. The default is deliberately 'no' so an
 *      accidental run cannot reboot production.
 *
 *      Present it as a predefined-answers list of exactly 'no' and 'simpleMode'.
 *      It is CASE-SENSITIVE, and a typo silently means "do nothing" -- the run
 *      still looks entirely successful. A free-text box here is a trap; the list
 *      is what removes it.
 *
 *   ── Only DIRECT members are targeted. Nested sub-groups are NEVER expanded
 *      (S-7). getGroupComputersDirect names any it found in a warning, so a group
 *      nested here cannot quietly go unrebooted for months.
 *
 *   ── verifyTimeoutSec is the per-server budget for a rebooted server to come
 *      back -- LastBootUpTime must ADVANCE past its pre-reboot value. Servers that
 *      do not return in time are reported NotReturned and counted as errors, so
 *      the run lands on Completed with Errors.
 *
 *   ── runPreRebootScript (S-13) defaults to FALSE and should stay that way unless
 *      security has reviewed it. It runs preRebootScriptPath on each server before
 *      rebooting it. Historically that is ownership_w2k.ps1, which takes ownership
 *      of and loosens the ACLs on c:\windows\inf\usbstor.inf (the USB mass-storage
 *      driver INF -- a common hardening DENY target) and
 *      c:\windows\system32\termsrv.dll (Terminal Services). Because of defect S-6
 *      this step has NEVER actually executed, so turning it on is a
 *      security-posture CHANGE, not a restoration of previous behaviour. When
 *      enabled, a failure is logged as an ERROR and the server is still rebooted.
 *
 *   ── mailTo / mailCc are arrays of addresses, joined with ',' for the script.
 *      The FROM address is derived by the script from the host it runs on.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   rebootScript      ResourceElement  Invoke-ServerReboot.ps1. Set when the
 *                                      workflow is built. Bound as an attribute,
 *                                      not looked up by name at run time, so the
 *                                      run record shows which script ran.
 *   adHost            AD:AdHost        Only used on the adGroupDn path
 *   group             AD:UserGroup     The resolved group
 *   computerNames     Array/string     From getGroupComputersDirect
 *   resolvedHost      PowerShell:PowerShellHost
 *   scriptParameters  Properties
 *   scriptRunResult   Properties
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUTPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   executionSuccess  boolean  true = the script reported no errors at all
 *   executionOutput   string   one-line summary
 *   serversChecked    number   how many servers were interrogated
 *   serversRebooted   number   rebooted AND verified back online
 *   serversPending    number   how many reported a pending reboot
 *   transcript        string   the full run log, for the record
 *
 * ───────────────────────────────────────────────────────────────────────────
 * RUNTIME / TIMEOUT NOTE  (read before first production run)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   A real run takes roughly:
 *       (pending servers x delayBetweenServersSec) + up to verifyTimeoutSec
 *   because reboots are issued sequentially and then verified in a SINGLE pass
 *   (all servers reboot concurrently in reality). Example: 20 pending servers at
 *   10s delay + 600s verify ≈ 200s + ≤600s ≈ 13 minutes.
 *
 *   This is one synchronous PowerShell invocation, so the WinRM/PSRP operation
 *   timeout on the PS host must exceed that worst case. Create Script Parameters
 *   logs the worst case on every run and warns past 30 minutes.
 *
 *   If runs are cut off mid-transcript, RAISE the PS host's MaxTimeoutms and the
 *   plug-in timeout. Do not shorten verifyTimeoutSec to fit: that does not make
 *   the run shorter, it just gives up on servers that were going to come back.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE-HANDLING CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   Condition                                          End state
 *   ────────────────────────────────────────────────── ────────────────────────────
 *   No AD endpoint for the group's domain              Failed: AD Resolution
 *   Group not found on that endpoint                   Failed: AD Resolution
 *   Plug-in will not report group membership           Failed: AD Resolution
 *   Zero enabled DIRECT computer members               Failed: Bad Inputs
 *   Nested sub-group in the group                      ignored + Warn: → continues
 *   Disabled AD member                                 skipped + logged → continues
 *   Bad number / missing mail recipient                Failed: Bad Inputs
 *   runPreRebootScript on, path missing on host        Failed: PS Execution
 *   No PowerShell host registered                      Failed: PS Execution
 *   PS host unreachable / script did not complete      Failed: PS Execution
 *   Server with no pending reboot                      Skipped-NoRebootRequired → continues
 *   Server whose pending state cannot be read          Skipped-StatusUnknown + ERROR → Completed with Errors
 *   shutdown command rejected                          RebootFailed + ERROR   → Completed with Errors
 *   Server does not return within verifyTimeoutSec     NotReturned + ERROR    → Completed with Errors
 *   Report could not be emailed                        ERROR                  → Completed with Errors
 *   All servers handled, nothing pending               → Completed Successfully
 *
 *   "Completed with Errors" is NOT a hard failure. Per-server problems are logged
 *   as ERROR lines, the script still reports a PSO_RESULT, the remaining servers
 *   are still processed and the report is still produced. Only a TERMINATING
 *   failure -- bad inputs, AD resolution, or the script never completing -- routes
 *   to a Failed end state.
 *
 *   Zero direct members is deliberately a FAILURE rather than a clean exit. Under
 *   the old design it was a warning and a successful run, which is the same
 *   outcome an operator sees when every server is up to date -- so picking the
 *   wrong group looked exactly like having nothing to do.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * END-STATE SCRIPTABLE TASKS
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── End state: Completed Successfully ────────────────────────────────────────
// Place before [End - Completed Successfully]
// Inputs: executionOutput, group, rebootMode

System.log(
    "Invoke Server Reboot | Completed successfully." +
    " | group=" + group.name +
    " | rebootMode=" + rebootMode +
    " | " + executionOutput
);


// ── End state: Completed with Errors ─────────────────────────────────────────
// Place before [End - Completed with Errors]
// Inputs: executionOutput, group, rebootMode
//
// Parse Result has already logged the per-category breakdown and every error line.
// This only records the end state itself, so the two do not print the same thing
// twice -- a log that repeats itself is one an operator stops reading.

System.warn(
    "Invoke Server Reboot | Completed with errors." +
    " | group=" + group.name +
    " | rebootMode=" + rebootMode +
    " | " + executionOutput +
    " | See the warnings above and the emailed report for the per-server detail."
);
