/**
 * Workflow:  Move Archived Logs
 * Element:   "Parse Result" -- the last scriptable task in the schema
 *
 * WHERE THIS SITS
 *
 *     ... -> Create Script Parameters -> runPowerShellScript -> Parse Result -> end
 *
 *   runPowerShellScript hands back one Properties object holding everything the script
 *   reported. This task takes it apart into the workflow's own outputs, so a caller --
 *   a parent workflow, a schedule, or the API -- can read the numbers without knowing
 *   anything about PSO_RESULT or about how the script logs.
 *
 *   Bind the outputs on the OUT tab. An unbound OUT tab is not an error and produces no
 *   warning: the values are simply assigned and discarded, and the workflow finishes
 *   looking successful with nothing to show for it.
 *
 * ---------------------------------------------------------------------------
 * IN tab -- bind this
 * ---------------------------------------------------------------------------
 *   scriptRunResult  Properties  attribute, bound from runPowerShellScript's output
 *
 * ---------------------------------------------------------------------------
 * OUT tab -- bind all four to the workflow's outputs
 * ---------------------------------------------------------------------------
 *   success           boolean  true when the script reported no errors at all
 *   serversProcessed  number   how many servers completed, of how many were asked for
 *   filesMoved        number   in a report-only run, how many would have moved
 *   transcript        string   the full run log, for the record
 */

// runPowerShellScript throws rather than returning nothing, so an empty result here means
// the element above it was skipped or its output was never bound. Say which, because the
// alternative is four null outputs and no clue where they came from.
if (scriptRunResult === null || scriptRunResult === undefined) {
    throw new Error(
        "Parse Result: scriptRunResult is empty. Bind this task's scriptRunResult input to the output " +
        "of the runPowerShellScript element."
    );
}

var reported = scriptRunResult.get("result");

success          = scriptRunResult.get("success");
transcript       = scriptRunResult.get("transcript");
serversProcessed = reported.get("serversProcessed");
filesMoved       = reported.get("moved");

// reportOnly comes back from the script itself rather than from the request form, so this
// reports what actually ran. If the two ever disagree, the script's answer is the true one.
var wasReportOnly = (reported.get("reportOnly") === true);

if (success) {
    System.log(
        "Finished. " + filesMoved + " file(s) across " + serversProcessed + " server(s)" +
        (wasReportOnly ? " would have been moved." : " moved.")
    );

    if (wasReportOnly && filesMoved > 0) {
        // Worth saying plainly. Report-only never writes to the destination, so a clean
        // report proves the source files can be read -- not that the archive share can be
        // written to. That distinction has cost a full day of investigation before.
        System.log(
            "This was a report-only run. Nothing was written to the archive share, so " +
            "this does not confirm the share is writable. Re-run with reportOnly " +
            "unticked to move these files."
        );
    }
}
else {
    // Some servers worked and some did not. That is not a failed workflow -- the work that
    // could be done was done -- but it must be visible rather than buried in a transcript
    // nobody opens.
    System.warn(
        "Finished with " + reported.get("errorCount") + " error(s). " + filesMoved +
        " file(s) moved across " + serversProcessed + " of " +
        reported.get("serversRequested") + " server(s). The errors were:"
    );

    var errors = reported.get("errors");
    for (var i = 0; i < errors.length; i++) {
        System.warn("  " + errors[i]);
    }

    System.warn(
        "Each error names the path AND the operation that failed. If they all name the " +
        "same destination share, the fault is that share, not the servers."
    );
}
