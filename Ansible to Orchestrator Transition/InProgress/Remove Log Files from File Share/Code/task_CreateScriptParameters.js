/**
 * Workflow:  Remove Old Archived Logs
 * Element:   "Create Script Parameters" -- the first scriptable task in the schema
 *
 * WHERE THIS SITS
 *
 *     Create Script Parameters -> runPowerShellScript -> Parse Result -> end
 *
 *   The whole workflow is those three elements. There is no Active Directory in this
 *   one: it works on a share, not on a list of servers, so all it needs is a path and
 *   a PowerShell host to run from.
 *
 *   This task does no work of its own. It turns the request form into the Properties
 *   bag that Remove-OldArchivedLogs.ps1 expects, and says in the log what it decided.
 *   Everything it needs arrives as a binding, so the schema shows where each value
 *   came from -- nothing is fetched with System.getModule().
 *
 * ---------------------------------------------------------------------------
 * IN tab -- bind these
 * ---------------------------------------------------------------------------
 *   fileServerPath      string   workflow input.     The share to clean up. Use the file
 *                                               server's FQDN, never an IP address.
 *   fileFilter     string   workflow attribute. Default: Archive-*.evtx
 *   olderThanDays  number   workflow input.     Default: 370. Must be 1 or more.
 *   reportOnly     boolean  workflow input.     Default: true
 *
 * ---------------------------------------------------------------------------
 * OUT tab -- bind this
 * ---------------------------------------------------------------------------
 *   scriptParameters  Properties  workflow attribute, bound on to runPowerShellScript's
 *                                 'parameters' input
 */

// ---------------------------------------------------------------------------
// 1. Check what we were given, before anything reaches the share
// ---------------------------------------------------------------------------
if (fileServerPath === null || fileServerPath === undefined ||
    String(fileServerPath).replace(/^\s+|\s+$/g, "") === "") {
    throw new Error(
        "Create Script Parameters: fileServerPath is empty. Bind it to the workflow input " +
        "holding the archive share, for example \\\\iaaslabdc.vcf.lab\\archived-logs."
    );
}

// A UNC path written with an IP address cannot authenticate with Kerberos -- there is no
// service principal name for an IP literal -- so the connection drops to NTLM and is
// refused. It presents as a share-permissions problem, and no amount of delegation work
// fixes it. The script warns about this too, but that warning only reaches the transcript
// after the run; saying it here puts it in the workflow log before the share is touched.
if (/^\\\\(\d{1,3}\.){3}\d{1,3}\\/.test(String(fileServerPath))) {
    System.warn(
        "fileServerPath is addressed by IP address (" + fileServerPath + "). Kerberos cannot " +
        "authenticate to an IP literal, so this will most likely be refused as " +
        "'Access is denied' no matter how the share is permissioned. Use the FQDN."
    );
}

// Caught here as well as in the script. The script's guard is what actually protects the
// share; this one means a mistyped retention is refused before a session is opened.
if (olderThanDays === null || olderThanDays === undefined || Number(olderThanDays) < 1) {
    throw new Error(
        "Create Script Parameters: olderThanDays is " + olderThanDays + ". It must be at " +
        "least 1, so that a mistyped 0 cannot delete the whole share."
    );
}

// ---------------------------------------------------------------------------
// 2. Turn the tick-box into the 'yes' or 'no' the script expects
// ---------------------------------------------------------------------------
/**
 * reportOnly is a boolean, so  reportOnly ? "yes" : "no"  would do the job today. It is
 * written out longhand because this input has been declared a string at times, and that
 * one-liner fails silently when it is: every non-empty string is truthy in JavaScript, so
 * "no" comes out as "yes". Here that error is fail-safe -- it reports instead of deleting
 * -- but it would mean nothing could ever be deleted, and the identical mistake on the
 * move workflow silently overwrote archived logs.
 */
function yesNo(value) {
    if (value === true)  { return "yes"; }
    if (value === false) { return "no"; }

    var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    return (text === "yes" || text === "true" || text === "1") ? "yes" : "no";
}

var reportOnlyFlag = yesNo(reportOnly);

// ---------------------------------------------------------------------------
// 3. Build the bag
// ---------------------------------------------------------------------------
// The keys are the script's parameter names. runPowerShellScript turns each one into
// -Name 'value' on the command line, so they have to match the param() block in
// Remove-OldArchivedLogs.ps1 exactly.
scriptParameters = new Properties();
scriptParameters.put("Path",          fileServerPath);
scriptParameters.put("FileFilter",    fileFilter);
scriptParameters.put("OlderThanDays", String(olderThanDays));
scriptParameters.put("ReportOnly",    reportOnlyFlag);

// Say what was decided, so the run record shows the decision rather than the raw input.
// A run that deleted nothing because ReportOnly was on is otherwise indistinguishable
// from one that found nothing old enough to delete.
System.log("Path=" + fileServerPath + ", FileFilter=" + fileFilter +
           ", OlderThanDays=" + olderThanDays + ", ReportOnly=" + reportOnlyFlag);

if (reportOnlyFlag === "yes") {
    System.log("REPORT ONLY: this run will list what would be deleted and delete nothing.");
}
else {
    System.warn("LIVE RUN: files older than " + olderThanDays +
                " days will be permanently deleted from " + fileServerPath);
}
