/**
 * Workflow:  Clean Archived Event Logs from File Share
 * Element:   "Parse Result" -- the last scriptable task in the schema
 *            (deployed as item6, id b453f157-9cc7-48c5-855e-b1f666141897)
 *
 * WHERE THIS SITS
 *
 *     Create Script Parameters -> runPowerShellScript -> Parse Result -> end
 *
 *   runPowerShellScript hands back one Properties object holding everything the script
 *   reported. This task takes it apart into the workflow's own outputs, so a caller --
 *   a parent workflow, a schedule, or the API -- can read the numbers without knowing
 *   anything about PSO_RESULT or about how the script logs.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE EDITING
 * ---------------------------------------------------------------------------
 *   The field names below are NOT the same as the move workflow's, and the two tasks
 *   cannot be swapped. Remove-OldArchivedLogs.ps1 reports:
 *
 *       matched  deleted  freedMB  reportOnly  errorCount  errors
 *
 *   Move-ArchivedLogs.ps1 reports something different:
 *
 *       serversProcessed  serversRequested  moved  skipped  reportOnly  errorCount  errors
 *
 *   Reading the move workflow's names here returns null for every one of them, and the
 *   run then logs "Finished. null file(s) across null server(s)." on a run that worked
 *   perfectly. Nothing fails, nothing warns -- the numbers are simply absent. This has
 *   happened once already, by pasting the move workflow's task in here unchanged.
 *
 * ---------------------------------------------------------------------------
 * IN tab -- bind this
 * ---------------------------------------------------------------------------
 *   scriptRunResult  Properties  attribute, bound from runPowerShellScript's output
 *
 * ---------------------------------------------------------------------------
 * OUT tab -- bind all of these to workflow OUTPUTS
 * ---------------------------------------------------------------------------
 *   success       boolean  true when the script reported no errors at all
 *   filesDeleted  number   in a report-only run, the number that would have been deleted
 *   spaceFreedMB  number   likewise
 *   filesMatched  number   how many matched the filter and the cutoff
 *   transcript    string   the full run log, for the record
 *
 *   The deployed workflow declares NO outputs, so these four are assigned and then
 *   discarded. That is not an error and raises no warning -- the workflow simply
 *   finishes looking successful with nothing to show for it. Declare the outputs and
 *   bind them here if anything is ever to consume the result.
 */

// runPowerShellScript throws rather than returning nothing, so an empty result here means
// the element above it was skipped or its output was never bound. Say which, because the
// alternative is null outputs and no clue where they came from.
if (scriptRunResult === null || scriptRunResult === undefined) {
    throw new Error(
        "Parse Result: scriptRunResult is empty. Bind this task's scriptRunResult input " +
        "to the output of the runPowerShellScript element."
    );
}

var reported = scriptRunResult.get("result");

success      = scriptRunResult.get("success");
transcript   = scriptRunResult.get("transcript");
filesDeleted = reported.get("deleted");
spaceFreedMB = reported.get("freedMB");
filesMatched = reported.get("matched");

// reportOnly comes back from the script itself rather than from the request form, so this
// reports what actually ran. If the two ever disagree, the script's answer is the true one.
var wasReportOnly = (reported.get("reportOnly") === true);

if (success) {
    System.log(
        "Finished. " + filesDeleted + " of " + filesMatched + " matched file(s), " +
        spaceFreedMB + " MB" +
        (wasReportOnly ? " would have been deleted." : " deleted.")
    );

    if (wasReportOnly && filesDeleted > 0) {
        // Worth saying plainly. A report-only run reads the share but never writes to it,
        // so a clean report proves the files can be listed -- not that they can be
        // deleted. Only a live run proves the second.
        System.log(
            "This was a report-only run, so nothing was deleted and no delete permission " +
            "was exercised. Re-run with reportOnly unticked to remove these files."
        );
    }
}
else {
    // Individual files can be locked, protected, or in a folder that cannot be read. The
    // rest of the cleanup still ran, so this is not a failed workflow -- but it must be
    // visible rather than buried in a transcript nobody opens.
    System.warn(
        "Finished with " + reported.get("errorCount") + " error(s). " + filesDeleted +
        " of " + filesMatched + " matched file(s) were removed. The errors were:"
    );

    var errors = reported.get("errors");
    for (var i = 0; i < errors.length; i++) {
        System.warn("  " + errors[i]);
    }

    System.warn(
        "'could not list' and 'could not delete' are different permissions on the share. " +
        "A report-only run only ever exercises the first."
    );
}
