/**
 * Workflow:  Invoke Server Reboot
 * Element:   the workflow's single scriptable task
 * Module:    com.broadcom.pso.windows.servers.reboot
 *
 * REFERENCE IMPLEMENTATION
 *   This is the whole workflow written as ONE scriptable task. It is the simplest thing
 *   that works, and it is here so the sequence can be read end to end in one place.
 *
 *   The built workflow uses the multi-element schema instead -- getGroupComputersDirect,
 *   Create Script Parameters, runPowerShellScript, Parse Result -- because that puts each
 *   step, and each failure, on its own box in the schema where an operator can see which
 *   one stopped. See Invoke-ServerReboot_spec.js for that schema. Build one or the other,
 *   not both.
 *
 * WHAT THE WORKFLOW DOES
 *   Reboots the Windows servers that are direct members of an Active Directory group AND
 *   are reporting a pending reboot, one at a time with a delay between each, then
 *   verifies they came back.
 *
 *   It replaces servers_reboot.yml. See Documentation/Change-Register.md for what
 *   changed and why.
 *
 *   In order:
 *      1. work out which AD group was asked for
 *      2. ask the AD plug-in for its DIRECT member servers -- nested groups are NOT opened
 *      3. work out which PowerShell host will do the work
 *      4. run Invoke-ServerReboot.ps1 there against that list of servers
 *
 *   Steps 1 and 2 use the Active Directory plug-in, so no PowerShell runs to resolve the
 *   group and no credentials travel anywhere. Step 4 is the only part that touches a
 *   Windows host.
 *
 * PHYSICAL AND VIRTUAL ARE TREATED IDENTICALLY
 *   Every operation in the script is OS-level -- remote WMI/registry for the pending
 *   check, shutdown.exe for the reboot, LastBootUpTime for the return check. Nothing
 *   touches vCenter, so hardware and VMs are handled the same way.
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW INPUTS -- bind these to the scriptable task's IN tab
 * ---------------------------------------------------------------------------
 *   adGroup                 AD:UserGroup               The group of servers. Picked from a tree,
 *                                                      so nothing is typed. Leave empty only for
 *                                                      scheduled runs, which use adGroupDn instead.
 *   adGroupDn               string                     The group's distinguishedName. For scheduled
 *                                                      and API runs, where nobody can pick from a
 *                                                      tree. Ignored when adGroup is set.
 *   psHost                  PowerShell:PowerShellHost  Leave empty when only one is registered.
 *   rebootMode              string                     Default: no    ** THE SAFETY GATE **
 *                                                      'simpleMode' reboots; anything else is
 *                                                      report only. Present it as a predefined
 *                                                      list of exactly 'no' and 'simpleMode'.
 *   delayBetweenServersSec  number                     Default: 10
 *   verifyTimeoutSec        number                     Default: 600
 *   verifyPollSec           number                     Default: 15
 *   runPreRebootScript      boolean                    Default: false -- leave it false, see below
 *   preRebootScriptPath     string                     Only used when the above is true
 *   emailReport             boolean                    Default: true
 *   smtpServer              string                     Default: mailrelay.vcf.lab
 *   mailTo                  Array/string               Recipients
 *   mailCc                  Array/string               Optional
 *   mailSubject             string                     Default: VCF Orchestrator: Server Reboot status
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW ATTRIBUTES -- set once when the workflow is built, not by the operator
 * ---------------------------------------------------------------------------
 *   rebootScript  ResourceElement  The Resource Element holding Invoke-ServerReboot.ps1.
 *                                  Bound here so the run record shows which script ran;
 *                                  the action does not go looking for it by name.
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW OUTPUTS -- bind these to the OUT tab
 * ---------------------------------------------------------------------------
 *   executionSuccess  boolean  true when the script reported no errors
 *   executionOutput   string   one-line summary
 *   serversChecked    number
 *   serversRebooted   number   rebooted AND verified back online
 *   serversPending    number   how many reported a pending reboot
 *   transcript        string   the full run log, for the record
 *
 * ---------------------------------------------------------------------------
 * BEFORE THE FIRST PRODUCTION RUN
 * ---------------------------------------------------------------------------
 *   The whole thing is ONE synchronous PowerShell invocation lasting roughly
 *   (pending servers x delayBetweenServersSec) + up to verifyTimeoutSec. The PS host's
 *   WinRM MaxTimeoutms and the PowerShell plug-in timeout must both exceed that worst
 *   case, or the session is cut off after reboots have been issued but before anything
 *   is reported -- the one failure mode that leaves you not knowing what state the
 *   estate is in. Raise the timeouts rather than shortening verifyTimeoutSec.
 */

var reboot = System.getModule("com.broadcom.pso.windows.servers.reboot");
var shared = System.getModule("com.broadcom.pso.windows.logs");

// ---------------------------------------------------------------------------
// 1. Which group?
// ---------------------------------------------------------------------------
// A group picked from the tree arrives already resolved and already attached to its own
// endpoint, so it is used as it stands and nothing is looked up. Only a name given as
// text has to be found, and finding it needs the endpoint worked out first -- adHost is
// that step's answer, passed on rather than looked up again inside.
var group;

if (adGroup !== null && adGroup !== undefined) {
    group = adGroup;
}
else {
    var adHost = shared.findAdHostForDn(adGroupDn);
    group = shared.resolveAdGroup(adGroupDn, adHost);
}

// ---------------------------------------------------------------------------
// 2. Which servers are in it?
// ---------------------------------------------------------------------------
// DIRECT members only. getGroupComputersDirect does NOT open nested groups -- that is
// change S-7, and it is deliberate: rebooting is destructive, so the target list is what
// someone actually put in the group and nothing else. Do not swap in getGroupComputers
// from the Move Archived Logs package; it is recursive.
var computers = reboot.getGroupComputersDirect(group);

// Stop here rather than run a script against nothing. A run that rebooted nothing
// because the group was empty should not look the same as a run that rebooted nothing
// because no server had a reboot pending.
if (computers.length === 0) {
    throw new Error(
        "Group '" + group.name + "' has no enabled computer accounts as DIRECT members, so there " +
        "is nothing to do. Nested groups are deliberately not expanded for reboots -- if the " +
        "getGroupComputersDirect log reported any, that is where the servers are."
    );
}

System.log("Servers to check: " + computers.join(", "));

// ---------------------------------------------------------------------------
// 3. The safety gate
// ---------------------------------------------------------------------------
// 'simpleMode' reboots; ANY other value is report-only. A typo therefore means "do
// nothing", and the run still looks entirely successful -- so say which it is, loudly,
// before anything happens.
var mode = String(rebootMode === null || rebootMode === undefined ? "" : rebootMode).replace(/^\s+|\s+$/g, "");

if (mode === "simpleMode") {
    System.warn(
        "rebootMode='simpleMode' -- this run WILL REBOOT every one of these " + computers.length +
        " server(s) that reports a pending reboot."
    );
}
else {
    if (mode !== "no") {
        System.warn(
            "rebootMode='" + mode + "' is neither 'simpleMode' nor 'no'. Anything that is not " +
            "exactly 'simpleMode' is treated as report-only, so NO servers will be rebooted."
        );
    }
    System.log("rebootMode='" + mode + "' -- report-only run.");
}

// ---------------------------------------------------------------------------
// 4. Run it
// ---------------------------------------------------------------------------
function yesNo(value) {
    if (value === true)  { return "yes"; }
    if (value === false) { return "no"; }
    var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    return (text === "yes" || text === "true" || text === "1") ? "yes" : "no";
}

// S-13: the pre-reboot step is opt-in and defaults OFF. See the script's NOTES block --
// it was never actually running, so turning it on changes security posture.
var preScriptFlag = yesNo(runPreRebootScript);
if (preScriptFlag === "yes") {
    System.warn(
        "runPreRebootScript is ON -- '" + preRebootScriptPath + "' will run on every server that " +
        "is rebooted. Confirm this is security-approved."
    );
}

var parameters = new Properties();
parameters.put("ComputerNames",          computers.join(","));
parameters.put("RebootMode",             mode);
parameters.put("DelayBetweenServersSec", String(delayBetweenServersSec));
parameters.put("VerifyTimeoutSec",       String(verifyTimeoutSec));
parameters.put("VerifyPollSec",          String(verifyPollSec));
parameters.put("RunPreRebootScript",     preScriptFlag);
parameters.put("PreRebootScriptPath",    preRebootScriptPath ? String(preRebootScriptPath) : "");
parameters.put("EmailReport",            yesNo(emailReport));
parameters.put("SMTPServer",             smtpServer ? String(smtpServer) : "");
parameters.put("MailToString",           (mailTo && mailTo.length) ? mailTo.join(",") : "");
parameters.put("MailCcString",           (mailCc && mailCc.length) ? mailCc.join(",") : "");
parameters.put("MailSubject",            mailSubject ? String(mailSubject) : "");

// The report header names the group that was ACTUALLY resolved, so it can never name a
// different group than the one whose servers were rebooted. (Change P-13.)
parameters.put("HeaderNote", String(group.name));

var host = shared.selectPowerShellHost(psHost);
var run  = shared.runPowerShellScript(host, rebootScript, parameters);

// ---------------------------------------------------------------------------
// 5. Report what happened
// ---------------------------------------------------------------------------
var reported = run.get("result");

executionSuccess = run.get("success");
transcript       = run.get("transcript");
serversChecked   = reported.get("serversRequested");
serversPending   = reported.get("pendingReboot");
serversRebooted  = reported.get("rebooted");

var wasReportOnly = (reported.get("reportOnly") === true);

if (wasReportOnly) {
    executionOutput = serversPending + " of " + serversChecked +
        " server(s) require a reboot. REPORT ONLY -- nothing was rebooted.";
}
else {
    executionOutput = serversRebooted + " of " + serversPending +
        " pending server(s) rebooted and verified, across " + serversChecked + " server(s) checked.";
}

if (executionSuccess) {
    System.log("Finished. " + executionOutput);
}
else {
    System.warn("Finished with " + reported.get("errorCount") + " error(s). " + executionOutput);

    // A server that did not come back is a live incident, not a line in a report. It is
    // called out on its own because it is the one outcome here that needs somebody now.
    if (reported.get("notReturned") > 0) {
        System.warn(
            reported.get("notReturned") + " server(s) did NOT come back within the verification " +
            "timeout. THESE NEED ATTENTION NOW -- a reboot was issued and they have not answered since."
        );
    }

    var errors = reported.get("errors");
    for (var i = 0; i < errors.length; i++) {
        System.warn("  " + errors[i]);
    }
}
