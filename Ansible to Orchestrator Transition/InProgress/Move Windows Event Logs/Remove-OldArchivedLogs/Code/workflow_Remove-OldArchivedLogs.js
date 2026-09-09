/**
 * Workflow:  Remove Old Archived Logs
 * Element:   the workflow's single scriptable task
 * Module:    com.broadcom.pso.windows.logs
 *
 * WHAT THE WORKFLOW DOES
 *   Deletes files older than the retention period from the archive share -- the
 *   housekeeping partner to Move Archived Logs, which is what fills the share up.
 *
 *   There is no Active Directory in this one. It works on a share, not on a list of
 *   servers, so all it needs is a path and a PowerShell host to run from.
 *
 *   It will not delete anything unless it is explicitly told to. reportOnly starts as
 *   true, so the first run of any new path always shows you the list first.
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW INPUTS -- bind these to the scriptable task's IN tab
 * ---------------------------------------------------------------------------
 *   sharePath      string                     The share to clean up.
 *                                             Default: \\fileserver.vcf.lab\mdcarchivelog$\Windows
 *   psHost         PowerShell:PowerShellHost  Leave empty when only one is registered.
 *   fileFilter     string                     Default: Archive-*.evtx
 *   olderThanDays  number                     Default: 370. Must be 1 or more.
 *   reportOnly     boolean                    Default: true
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW ATTRIBUTES -- set once when the workflow is built, not by the operator
 * ---------------------------------------------------------------------------
 *   removeScript  ResourceElement  The Resource Element holding Remove-OldArchivedLogs.ps1.
 *                                  Bound here so the run record shows which script ran;
 *                                  the action does not go looking for it by name.
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW OUTPUTS -- bind these to the OUT tab
 * ---------------------------------------------------------------------------
 *   success       boolean  true when the script reported no errors
 *   filesDeleted  number
 *   spaceFreedMB  number
 *   transcript    string   the full run log, for the record
 */

var actions = System.getModule("com.broadcom.pso.windows.logs");

// ---------------------------------------------------------------------------
// 1. Which PowerShell host?
// ---------------------------------------------------------------------------
var host = actions.selectPowerShellHost(psHost);

// ---------------------------------------------------------------------------
// 2. Run the script
// ---------------------------------------------------------------------------
var parameters = new Properties();
parameters.put("Path",          sharePath);
parameters.put("FileFilter",    fileFilter);
parameters.put("OlderThanDays", String(olderThanDays));
parameters.put("ReportOnly",    reportOnly ? "yes" : "no");

if (reportOnly) {
    System.log("REPORT ONLY: this run will list what would be deleted and delete nothing.");
}
else {
    System.warn("LIVE RUN: files older than " + olderThanDays + " days will be deleted from " + sharePath);
}

var run = actions.runPowerShellScript(host, removeScript, parameters);

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------
var reported = run.get("result");

success      = run.get("success");
transcript   = run.get("transcript");
filesDeleted = reported.get("deleted");
spaceFreedMB = reported.get("freedMB");

if (success) {
    System.log(
        "Finished. " + filesDeleted + " file(s), " + spaceFreedMB + " MB" +
        (reportOnly ? " would have been deleted." : " deleted.")
    );
}
else {
    // Individual files can be locked or protected. The rest of the cleanup still ran.
    System.warn("Finished with " + reported.get("errorCount") + " error(s). The errors were:");
    var errors = reported.get("errors");
    for (var i = 0; i < errors.length; i++) {
        System.warn("  " + errors[i]);
    }
}
