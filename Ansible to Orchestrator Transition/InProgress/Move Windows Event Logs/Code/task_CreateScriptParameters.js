/**
 * Workflow:  Move Archived Logs
 * Element:   "Create Script Parameters" -- the scriptable task before runPowerShellScript
 *
 * WHERE THIS SITS
 *
 *     [ group resolution ] -> getGroupComputers -> Create Script Parameters
 *                          -> runPowerShellScript -> Parse Result -> end
 *
 *   This task does no work of its own. It turns the request form and the resolved server
 *   list into the Properties bag that Move-ArchivedLogs.ps1 expects, and says in the log
 *   what it decided. Everything it needs arrives as a binding, so the schema shows where
 *   each value came from -- nothing is fetched with System.getModule().
 *
 * ---------------------------------------------------------------------------
 * IN tab -- bind these
 * ---------------------------------------------------------------------------
 *   computerNames          Array/string  attribute, from getGroupComputers
 *   logsFilePath       string        attribute. Default: C$\Windows\System32\winevt\Logs
 *   fileServerPath     string        attribute. The archive share. FQDN, never an IP
 *   fileFilter         string        attribute. Default: Archive-*.evtx
 *   olderThanDays      number        workflow input. 0 means every age
 *   reportOnly         boolean       workflow input. Default: true
 *   overwriteExisting  boolean       workflow input. Default: false
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
// A run that moves no files because the group was empty must not look the same as a run
// that moved no files because nothing was old enough. Stop here instead.
if (computerNames === null || computerNames === undefined || computerNames.length === 0) {
    throw new Error(
        "Create Script Parameters: no servers were resolved. The AD group contains no " +
        "enabled computer accounts, or the group holds users rather than computerNames. " +
        "Check the getGroupComputers element's log for what it found."
    );
}

System.log("Servers to process (" + computerNames.length + "): " + computerNames.join(", "));

// ---------------------------------------------------------------------------
// 2. Check the destination before anything reaches it
// ---------------------------------------------------------------------------
if (fileServerPath === null || fileServerPath === undefined ||
    String(fileServerPath).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error(
        "Create Script Parameters: fileServerPath is empty. Bind it to the workflow " +
        "attribute holding the archive share."
    );
}

// A UNC path written with an IP address cannot authenticate with Kerberos -- there is no
// service principal name for an IP literal -- so the connection drops to NTLM and is
// refused. The source paths are immune: they are built from AD computer names and so are
// always FQDNs. That asymmetry is what makes this so hard to read from the log -- every
// server appears to refuse, while the real fault is the one path an operator typed.
if (/^\\\\(\d{1,3}\.){3}\d{1,3}\\/.test(String(fileServerPath))) {
    System.warn(
        "fileServerPath is addressed by IP address (" + fileServerPath + "). Kerberos " +
        "cannot authenticate to an IP literal, so writing to it will most likely be " +
        "refused as 'Access is denied' no matter how the share is permissioned. This " +
        "reports as a failure against the SOURCE servers, not against the share. Use the FQDN."
    );
}

// The old Ansible convention was days_old: -1, which under this script would put the
// cutoff in the future and take everything in scope. The script refuses it too; this is
// so the refusal is immediate and names the fix.
if (Number(olderThanDays) < 0) {
    throw new Error(
        "Create Script Parameters: olderThanDays is " + olderThanDays + ". Negative " +
        "values are rejected. The Ansible playbooks used -1 to mean 'every age' because " +
        "their date arithmetic had the sign inverted; here, use 0."
    );
}

// ---------------------------------------------------------------------------
// 3. Turn the tick-boxes into the 'yes' and 'no' the script expects
// ---------------------------------------------------------------------------
/**
 * reportOnly and overwriteExisting are booleans, so  value ? "yes" : "no"  would do the
 * job today. It is written out longhand because these two have been declared as strings
 * at times, and that one-liner fails silently when they are: every non-empty string is
 * truthy in JavaScript, so "no" comes out as "yes" -- turning OverwriteExisting on for a
 * run whose operator had turned it off, and pinning ReportOnly on so nothing ever moves.
 * Nothing in the log would say so. These two decide whether files are overwritten and
 * whether anything moves at all, so the value is read rather than tested for truth.
 */
function yesNo(value) {
    if (value === true)  { return "yes"; }
    if (value === false) { return "no"; }

    var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    return (text === "yes" || text === "true" || text === "1") ? "yes" : "no";
}

var reportOnlyFlag = yesNo(reportOnly);
var overwriteFlag  = yesNo(overwriteExisting);

// ---------------------------------------------------------------------------
// 4. Build the bag
// ---------------------------------------------------------------------------
// The keys are the script's parameter names. runPowerShellScript turns each one into
// -Name 'value' on the command line, so they have to match the param() block in
// Move-ArchivedLogs.ps1 exactly.
scriptParameters = new Properties();
scriptParameters.put("ComputerNames",     computerNames.join(","));
scriptParameters.put("SourcePath",        logsFilePath);
scriptParameters.put("TargetPath",        fileServerPath);
scriptParameters.put("FileFilter",        fileFilter);
scriptParameters.put("OlderThanDays",     String(olderThanDays));
scriptParameters.put("ReportOnly",        reportOnlyFlag);
scriptParameters.put("OverwriteExisting", overwriteFlag);

// Say what was decided, so the run record shows the decision rather than the raw input. A
// run that moved nothing because ReportOnly was on is otherwise indistinguishable from
// one that found nothing old enough to move.
System.log(
    "SourcePath=" + logsFilePath + ", TargetPath=" + fileServerPath +
    ", FileFilter=" + fileFilter + ", OlderThanDays=" + olderThanDays +
    ", ReportOnly=" + reportOnlyFlag + ", OverwriteExisting=" + overwriteFlag
);

if (reportOnlyFlag === "yes") {
    System.log("REPORT ONLY: this run will list what would move and change nothing.");
    System.log(
        "Note that a report-only run never writes to the destination, so it cannot tell " +
        "you whether the archive share is writable. Only a live run does."
    );
}
