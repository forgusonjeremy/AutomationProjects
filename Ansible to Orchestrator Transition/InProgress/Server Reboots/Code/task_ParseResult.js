/**
 * Workflow:  Invoke Server Reboot
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
 * IN tab -- bind these
 * ---------------------------------------------------------------------------
 *   scriptRunResult  Properties  attribute, bound from runPowerShellScript's output
 *   groupName        string      attribute, for the log line only
 *
 * ---------------------------------------------------------------------------
 * OUT tab -- bind all six to the workflow's outputs
 * ---------------------------------------------------------------------------
 *   executionSuccess  boolean  true when the script reported no errors at all
 *   executionOutput   string   one-line summary, for a caller or a notification
 *   serversChecked    number   how many servers were interrogated
 *   serversRebooted   number   rebooted AND verified back online
 *   serversPending    number   how many reported a pending reboot
 *   transcript        string   the full run log, for the record
 */

// runPowerShellScript throws rather than returning nothing, so an empty result here means
// the element above it was skipped or its output was never bound. Say which, because the
// alternative is six null outputs and no clue where they came from.
if (scriptRunResult === null || scriptRunResult === undefined) {
    throw new Error(
        "Parse Result: scriptRunResult is empty. Bind this task's scriptRunResult input to the " +
        "output of the runPowerShellScript element."
    );
}

var reported = scriptRunResult.get("result");

executionSuccess = scriptRunResult.get("success");
transcript       = scriptRunResult.get("transcript");

serversChecked  = reported.get("serversRequested");
serversPending  = reported.get("pendingReboot");
serversRebooted = reported.get("rebooted");

var notReturned  = reported.get("notReturned");
var rebootFailed = reported.get("rebootFailed");
var skipped      = reported.get("skipped");
var errorCount   = reported.get("errorCount");

// reportOnly comes back from the SCRIPT rather than from the request form, so this
// reports what actually ran. If the two ever disagree, the script's answer is the true
// one -- and the disagreement is itself the thing worth knowing.
var wasReportOnly = (reported.get("reportOnly") === true);

// ---------------------------------------------------------------------------
// The summary line
// ---------------------------------------------------------------------------
if (wasReportOnly) {
    executionOutput =
        serversPending + " of " + serversChecked + " server(s) require a reboot. " +
        "REPORT ONLY -- nothing was rebooted.";
}
else {
    executionOutput =
        serversRebooted + " of " + serversPending + " pending server(s) rebooted and verified, " +
        "across " + serversChecked + " server(s) checked.";
}

// ---------------------------------------------------------------------------
// Say what happened
// ---------------------------------------------------------------------------
if (executionSuccess) {
    System.log("Finished. " + executionOutput);

    if (wasReportOnly && serversPending > 0) {
        // Worth saying plainly. A clean report-only run proves the servers could be
        // interrogated -- not that any of them can actually be rebooted. The reboot
        // path (shutdown rights, RPC) is never exercised until a live run.
        System.log(
            "This was a report-only run. No reboot was issued, so it does not confirm the " +
            "servers can be rebooted -- only that their pending state could be read. " +
            "Re-run with rebootMode set to 'simpleMode' to reboot these " + serversPending +
            " server(s)."
        );
    }
}
else {
    // Some servers worked and some did not. That is not a failed workflow -- the work
    // that could be done was done, and the report was still produced -- but it must be
    // visible rather than buried in a transcript nobody opens.
    System.warn(
        "Finished with " + errorCount + " error(s) against group '" + groupName + "'. " +
        executionOutput
    );

    // Each count names a DIFFERENT kind of problem with a different owner, so they are
    // reported separately rather than as one total. Collapsing them is what makes a
    // reboot run hard to read: "3 errors" could be three unreachable servers (a
    // firewall or WMI problem) or three servers that never came back (a real outage),
    // and those two call for opposite responses.
    if (skipped > 0 && serversPending < serversChecked) {
        System.warn(
            "  " + skipped + " server(s) were skipped. A server whose pending-reboot state " +
            "could not be read is NEVER rebooted (change S-8) -- check remote WMI/RPC access " +
            "to those servers from the PowerShell host."
        );
    }
    if (rebootFailed > 0) {
        System.warn(
            "  " + rebootFailed + " server(s) rejected the shutdown command. These are still " +
            "running and still require a reboot. Check the PowerShell host's shutdown rights " +
            "on them."
        );
    }
    if (notReturned > 0) {
        System.warn(
            "  " + notReturned + " server(s) did NOT come back within the verification timeout. " +
            "THESE NEED ATTENTION NOW -- a reboot was issued and the machine has not answered " +
            "since. Check them before re-running anything."
        );
    }

    var errors = reported.get("errors");
    if (errors !== null && errors !== undefined) {
        System.warn("The errors were:");
        for (var i = 0; i < errors.length; i++) {
            System.warn("  " + errors[i]);
        }
    }

    System.warn("The full transcript, and the emailed report, hold the per-server detail.");
}
