/**
 * Workflow:  Move Archived Logs
 * Element:   the workflow's single scriptable task
 * Module:    com.broadcom.pso.windows.logs
 *
 * WHAT THE WORKFLOW DOES
 *   Moves archived event logs off every server in an Active Directory group onto a
 *   central share, into a folder named after the server.
 *
 *   It replaces four Ansible playbooks that all did this same job in slightly different
 *   ways. See 02_Design-Decisions.md for what was standardised and why.
 *
 *   In order:
 *      1. work out which AD group was asked for
 *      2. ask the AD plug-in for its member servers, nested groups included
 *      3. work out which PowerShell host will do the work
 *      4. run Move-ArchivedLogs.ps1 there against that list of servers
 *
 *   Steps 1 and 2 use the Active Directory plug-in, so no PowerShell runs and no
 *   credentials travel anywhere. Step 4 is the only part that touches a Windows host.
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW INPUTS -- bind these to the scriptable task's IN tab
 * ---------------------------------------------------------------------------
 *   adGroup            AD:UserGroup               The group of servers. Picked from a tree,
 *                                                 so nothing is typed. Leave empty only for
 *                                                 scheduled runs, which use adGroupDn instead.
 *   adGroupDn          string                     The group's distinguishedName. For scheduled
 *                                                 and API runs, where nobody can pick from a
 *                                                 tree. Ignored when adGroup is set.
 *   psHost             PowerShell:PowerShellHost  Leave empty when only one is registered.
 *   sourcePath         string                     Default: C$\Windows\System32\winevt\Logs
 *   targetPath         string                     Default: \\fileserver.vcf.lab\mdcarchivelog$\Windows
 *   fileFilter         string                     Default: Archive-*.evtx
 *   olderThanDays      number                     Default: 0  (0 means every age)
 *   reportOnly         boolean                    Default: true
 *   overwriteExisting  boolean                    Default: false
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW ATTRIBUTES -- set once when the workflow is built, not by the operator
 * ---------------------------------------------------------------------------
 *   moveScript  ResourceElement  The Resource Element holding Move-ArchivedLogs.ps1.
 *                                Bound here so the run record shows which script ran;
 *                                the action does not go looking for it by name.
 *
 * ---------------------------------------------------------------------------
 * WORKFLOW OUTPUTS -- bind these to the OUT tab
 * ---------------------------------------------------------------------------
 *   success           boolean  true when the script reported no errors
 *   serversProcessed  number
 *   filesMoved        number
 *   transcript        string   the full run log, for the record
 */

var actions = System.getModule("com.broadcom.pso.windows.logs");

// ---------------------------------------------------------------------------
// 1. Which group?
// ---------------------------------------------------------------------------
// A group picked from the tree arrives already resolved and already attached to its
// own endpoint, so it is used as it stands and nothing is looked up. Only a name given
// as text has to be found, and finding it needs the endpoint worked out first --
// adHost is that step's answer, passed on rather than looked up again inside.
var group;

if (adGroup !== null && adGroup !== undefined) {
    group = adGroup;
}
else {
    var adHost = actions.findAdHostForDn(adGroupDn);
    group = actions.resolveAdGroup(adGroupDn, adHost);
}

// ---------------------------------------------------------------------------
// 2. Which servers are in it?
// ---------------------------------------------------------------------------
var computers = actions.getGroupComputers(group);

// Stop here rather than run a script against nothing. A run that moves no files
// because the group was empty should not look the same as a run that moved no files
// because there was nothing old enough to move.
if (computers.length === 0) {
    throw new Error(
        "Group '" + group.name + "' contains no enabled computer accounts, so there is nothing " +
        "to do. Check the group is the right one and that it holds computers rather than users."
    );
}

System.log("Servers to process: " + computers.join(", "));

// ---------------------------------------------------------------------------
// 3. Which PowerShell host?
// ---------------------------------------------------------------------------
var host = actions.selectPowerShellHost(psHost);

// ---------------------------------------------------------------------------
// 4. Run the script
// ---------------------------------------------------------------------------
// The script takes 'yes' and 'no' rather than true and false, so that its own log
// lines read plainly and so it can be run by hand at a console the same way.

/**
 * Turns the tick-box into the 'yes' or 'no' the script expects.
 *
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

var parameters = new Properties();
parameters.put("ComputerNames",     computers.join(","));
parameters.put("SourcePath",        sourcePath);
parameters.put("TargetPath",        targetPath);
parameters.put("FileFilter",        fileFilter);
parameters.put("OlderThanDays",     String(olderThanDays));
parameters.put("ReportOnly",        reportOnlyFlag);
parameters.put("OverwriteExisting", yesNo(overwriteExisting));

// Say what was decided, so the run log shows it rather than the raw input. A run that
// moved nothing because ReportOnly was on is otherwise indistinguishable from one that
// found nothing to move.
System.log(
    "ReportOnly=" + reportOnlyFlag + ", OverwriteExisting=" + yesNo(overwriteExisting)
);

if (reportOnlyFlag === "yes") {
    System.log("REPORT ONLY: this run will list what would move and change nothing.");
}

var run = actions.runPowerShellScript(host, moveScript, parameters);

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------
var reported = run.get("result");

success          = run.get("success");
transcript       = run.get("transcript");
serversProcessed = reported.get("serversProcessed");
filesMoved       = reported.get("moved");

if (success) {
    System.log("Finished. " + filesMoved + " file(s) across " + serversProcessed + " server(s).");
}
else {
    // Some servers worked and some did not. That is not a failed workflow -- the work
    // that could be done was done -- but it must be visible rather than buried in the log.
    System.warn(
        "Finished with " + reported.get("errorCount") + " error(s). " + filesMoved +
        " file(s) moved across " + serversProcessed + " of " + reported.get("serversRequested") +
        " server(s). The errors were:"
    );
    var errors = reported.get("errors");
    for (var i = 0; i < errors.length; i++) {
        System.warn("  " + errors[i]);
    }
}
