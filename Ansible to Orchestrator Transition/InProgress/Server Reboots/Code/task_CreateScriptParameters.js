/**
 * Workflow:  Invoke Server Reboot
 * Element:   "Create Script Parameters" -- the scriptable task before runPowerShellScript
 *
 * WHERE THIS SITS
 *
 *     [ group resolution ] -> getGroupComputersDirect -> Create Script Parameters
 *                          -> runPowerShellScript -> Parse Result -> end
 *
 *   This task does no work of its own. It turns the request form and the resolved server
 *   list into the Properties bag that Invoke-ServerReboot.ps1 expects, and says in the
 *   log what it decided. Everything it needs arrives as a binding, so the schema shows
 *   where each value came from -- nothing is fetched with System.getModule().
 *
 * ---------------------------------------------------------------------------
 * IN tab -- bind these
 * ---------------------------------------------------------------------------
 *   computerNames           Array/string  attribute, from getGroupComputersDirect
 *   groupName               string        attribute, the group's name -- report label only
 *   rebootMode              string        workflow input. Default: no   (SAFETY GATE)
 *   delayBetweenServersSec  number        workflow input. Default: 10
 *   verifyTimeoutSec        number        workflow input. Default: 600
 *   verifyPollSec           number        workflow input. Default: 15
 *   runPreRebootScript      boolean       workflow input. Default: false
 *   preRebootScriptPath     string        workflow input. Only used when the above is true
 *   emailReport             boolean       workflow input. Default: true
 *   smtpServer              string        workflow input
 *   mailTo                  Array/string  workflow input
 *   mailCc                  Array/string  workflow input
 *   mailSubject             string        workflow input
 *
 * ---------------------------------------------------------------------------
 * OUT tab -- bind this
 * ---------------------------------------------------------------------------
 *   scriptParameters  Properties  attribute, bound on to runPowerShellScript's
 *                                 'parameters' input
 */

// ---------------------------------------------------------------------------
// 1. Refuse to run a script against nothing
// ---------------------------------------------------------------------------
// A run that rebooted nothing because the group was empty must not look the same as a
// run that rebooted nothing because no server had a reboot pending. Stop here instead.
if (computerNames === null || computerNames === undefined || computerNames.length === 0) {
    throw new Error(
        "Create Script Parameters: no servers were resolved. The AD group has no enabled " +
        "computer accounts as DIRECT members -- note that nested groups are deliberately not " +
        "expanded for reboots (change S-7). Check the getGroupComputersDirect element's log: " +
        "if it reported nested groups, that is where the servers are."
    );
}

System.log("Servers to check (" + computerNames.length + "): " + computerNames.join(", "));

// ---------------------------------------------------------------------------
// 2. The safety gate
// ---------------------------------------------------------------------------
// rebootMode maps to the script's -RebootMode. 'simpleMode' actually reboots; ANY other
// value is a report-only run. The spelling is inherited from the Ansible variable
// var_RebootIt and kept so the two can be read against each other.
//
// The failure mode worth guarding is a TYPO: 'simplemode' or 'simple' silently means
// "do nothing", and the run looks entirely successful while no server is rebooted.
// Anything that is not one of the two expected values is called out.
var mode = String(rebootMode === null || rebootMode === undefined ? "" : rebootMode).replace(/^\s+|\s+$/g, "");

if (mode === "") {
    throw new Error(
        "Create Script Parameters: rebootMode is empty. Use 'simpleMode' to reboot, or 'no' " +
        "for a report-only run."
    );
}

if (mode === "simpleMode") {
    System.warn(
        "rebootMode='simpleMode' -- this run WILL REBOOT every direct, enabled member of '" +
        groupName + "' that reports a pending reboot. " + computerNames.length + " server(s) " +
        "will be checked."
    );
}
else {
    if (mode !== "no") {
        System.warn(
            "rebootMode='" + mode + "' is neither 'simpleMode' nor 'no'. The script treats any " +
            "non-'simpleMode' value as report-only, so NO servers will be rebooted. If a reboot " +
            "was intended, the value must be exactly 'simpleMode' -- it is case-sensitive."
        );
    }
    System.log("rebootMode='" + mode + "' -- report-only run; pending servers will be reported but not rebooted.");
}

// ---------------------------------------------------------------------------
// 3. Check the numbers before the script has to
// ---------------------------------------------------------------------------
// These are cast with [int] inside the script, where a bad value becomes 0 rather than
// an error -- a verifyPollSec of 0 would spin the verification loop with no wait at all.
// Refuse them here, where the message can name the input the operator has to fix.
function requireWholeNumber(value, name, minimum) {
    if (value === null || value === undefined || String(value).replace(/^\s+|\s+$/g, "") === "") {
        throw new Error("Create Script Parameters: " + name + " is required.");
    }

    var n = parseInt(value, 10);

    if (isNaN(n) || String(n) !== String(value).replace(/^\s+|\s+$/g, "")) {
        throw new Error(
            "Create Script Parameters: " + name + " must be a whole number. Received: " + value
        );
    }
    if (n < minimum) {
        throw new Error(
            "Create Script Parameters: " + name + " must be " + minimum + " or greater. Received: " + n
        );
    }
    return n;
}

var delaySec  = requireWholeNumber(delayBetweenServersSec, "delayBetweenServersSec", 0);
var verifySec = requireWholeNumber(verifyTimeoutSec, "verifyTimeoutSec", 1);
var pollSec   = requireWholeNumber(verifyPollSec, "verifyPollSec", 1);

if (pollSec > verifySec) {
    throw new Error(
        "Create Script Parameters: verifyPollSec (" + pollSec + ") must not exceed verifyTimeoutSec (" +
        verifySec + ") -- a server would never be polled before its deadline passed."
    );
}

// The whole run is ONE synchronous PowerShell invocation. If it outlasts the WinRM/PSRP
// operation timeout on the host, the session is cut and the transcript is lost
// mid-reboot -- with servers already rebooting and no record of which. Worth saying
// before it happens rather than diagnosing afterwards.
var worstCaseSec = (computerNames.length * delaySec) + verifySec;
System.log(
    "Worst-case run time: " + Math.ceil(worstCaseSec / 60) + " minute(s) (" + computerNames.length +
    " server(s) x " + delaySec + "s delay, plus up to " + verifySec + "s of verification)."
);
if (worstCaseSec > 1800) {
    System.warn(
        "This run could take up to " + Math.ceil(worstCaseSec / 60) + " minutes in a single " +
        "PowerShell invocation. Confirm the PS host's WinRM MaxTimeoutms and the PowerShell " +
        "plug-in timeout both exceed that, or the session will be cut off mid-run -- after " +
        "reboots have been issued but before anything is reported."
    );
}

// ---------------------------------------------------------------------------
// 4. Turn the tick-boxes into the 'yes' and 'no' the script expects
// ---------------------------------------------------------------------------
/**
 * These are booleans, so  value ? "yes" : "no"  would do the job today. It is written
 * out longhand because inputs like these have been declared as strings at times, and
 * that one-liner fails silently when they are: every non-empty string is truthy in
 * JavaScript, so "no" comes out as "yes". Here that would turn ON the pre-reboot script
 * for a run whose operator had turned it off -- a security-posture change nobody asked
 * for. The value is read, not tested for truth.
 */
function yesNo(value) {
    if (value === true)  { return "yes"; }
    if (value === false) { return "no"; }

    var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    return (text === "yes" || text === "true" || text === "1") ? "yes" : "no";
}

var preScriptFlag = yesNo(runPreRebootScript);
var emailFlag     = yesNo(emailReport);

// S-13: the pre-reboot step is opt-in and defaults OFF. ownership_w2k.ps1 takes
// ownership of and loosens the ACLs on usbstor.inf (USB mass-storage driver INF) and
// termsrv.dll (Terminal Services). Because of defect S-6 the step never actually ran,
// so enabling it is a security-posture CHANGE rather than a restoration of working
// behaviour. Make it loud when it is on.
var preScriptPath = (preRebootScriptPath === null || preRebootScriptPath === undefined)
    ? "" : String(preRebootScriptPath).replace(/^\s+|\s+$/g, "");

if (preScriptFlag === "yes") {
    if (preScriptPath === "") {
        throw new Error(
            "Create Script Parameters: runPreRebootScript is ticked but preRebootScriptPath is " +
            "empty. Give the full path to the script on the PowerShell host, or untick it."
        );
    }
    System.warn(
        "runPreRebootScript is ON -- '" + preScriptPath + "' WILL run on every server that is " +
        "rebooted. If this is ownership_w2k.ps1, it takes ownership of and loosens ACLs on " +
        "usbstor.inf and termsrv.dll. This step has never run in production (defect S-6), so " +
        "enabling it changes security posture. Confirm it is security-approved."
    );
}

// ---------------------------------------------------------------------------
// 5. Email is opt-in; when it is on, there has to be somewhere to send it
// ---------------------------------------------------------------------------
var toList = (mailTo && mailTo.length) ? mailTo.join(",") : "";
var ccList = (mailCc && mailCc.length) ? mailCc.join(",") : "";

if (emailFlag === "yes") {
    if (smtpServer === null || smtpServer === undefined ||
        String(smtpServer).replace(/^\s+|\s+$/g, "") === "") {
        throw new Error(
            "Create Script Parameters: smtpServer is required when emailReport is ticked."
        );
    }
    if (toList === "") {
        throw new Error(
            "Create Script Parameters: mailTo must hold at least one recipient when emailReport " +
            "is ticked."
        );
    }
}

// ---------------------------------------------------------------------------
// 6. Build the bag
// ---------------------------------------------------------------------------
// The keys are the script's parameter names. runPowerShellScript turns each one into
// -Name 'value' on the command line, so they have to match the param() block in
// Invoke-ServerReboot.ps1 exactly.
scriptParameters = new Properties();
scriptParameters.put("ComputerNames",          computerNames.join(","));
scriptParameters.put("RebootMode",             mode);
scriptParameters.put("DelayBetweenServersSec", String(delaySec));
scriptParameters.put("VerifyTimeoutSec",       String(verifySec));
scriptParameters.put("VerifyPollSec",          String(pollSec));
scriptParameters.put("RunPreRebootScript",     preScriptFlag);
scriptParameters.put("PreRebootScriptPath",    preScriptPath);
scriptParameters.put("EmailReport",            emailFlag);
scriptParameters.put("SMTPServer",             smtpServer ? String(smtpServer).replace(/^\s+|\s+$/g, "") : "");
scriptParameters.put("MailToString",           toList);
scriptParameters.put("MailCcString",           ccList);
scriptParameters.put("MailSubject",            mailSubject ? String(mailSubject).replace(/^\s+|\s+$/g, "") : "");

// -HeaderNote is the group name printed in the report header. It is a display label
// only, so it is taken from the group that was actually resolved rather than asked for
// separately -- which makes it impossible for the header to name a different group than
// the one whose servers were rebooted. (Change P-13.)
scriptParameters.put("HeaderNote", groupName ? String(groupName) : "");

System.log(
    "rebootMode=" + mode + ", servers=" + computerNames.length +
    ", delay=" + delaySec + "s, verifyTimeout=" + verifySec + "s, verifyPoll=" + pollSec + "s" +
    ", preRebootScript=" + preScriptFlag + ", emailReport=" + emailFlag +
    (emailFlag === "yes" ? ", mailTo=" + toList : "")
);
