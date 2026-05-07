// ===================================================================
// ACTION:    runWithParallelism
// MODULE:    com.broadcom.pso.common.workflow
// PURPOSE:   Execute a worker workflow N times in parallel against a
//            list of work items, with a bounded concurrency cap and
//            asymmetric scheduling. As soon as any one in-flight
//            worker finishes, the next queued work item is dispatched
//            — slow workers do not hold back the queue. This is the
//            core fan-out primitive for the project's vCenter→Cluster
//            orchestration but is intentionally generic so other
//            projects can reuse it.
//
// PHASE:     used by orchestrator workflows during their EXECUTE phase
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [PSO-COMMON-PARALLEL]
//
// INPUTS:
//   workItems       (Array/Properties) — One Properties bag per
//                                        unit of work. Order is
//                                        preserved in the returned
//                                        results array. Each item is
//                                        passed verbatim to the
//                                        inputBuilderActionName
//                                        action (next parameter).
//   workerWorkflow  (Workflow)         — The vRO workflow object that
//                                        will be executed once per
//                                        work item.
//   inputBuilderActionName (string)    — Fully-qualified name of an
//                                        Action that takes one
//                                        workItem (Properties) and
//                                        returns a Properties bag of
//                                        inputs for the workerWorkflow.
//                                        Format:
//                                          "moduleName/actionName"
//                                        Example:
//                                          "com.broadcom.pso.vc.esxi.remediation.cluster/buildClusterWorkerInputs"
//   parallelismCap  (number)           — Max in-flight worker runs
//                                        at any moment. Must be >= 1.
//                                        Use a small cap (e.g. 3) to
//                                        respect downstream system
//                                        load (vCenter, etc).
//   pollIntervalSeconds (number)       — Seconds between polls of
//                                        in-flight worker state.
//                                        Default 10. Smaller values
//                                        give faster scheduling but
//                                        more vRO load.
//
// RETURNS: Array/Properties — Per-work-item results, same order as
//                             input. Each entry is a Properties bag
//                             with these keys:
//                               outputs       (Properties) — the
//                                              workerWorkflow's output
//                                              attributes if it
//                                              completed, else null.
//                               state         (string) — "completed",
//                                              "failed", or
//                                              "cancelled".
//                               errorMessage  (string) — non-empty
//                                              when state != "completed",
//                                              else "".
//                               wfRunId       (string) — child run id
//                               startedAt     (Date)
//                               finishedAt    (Date)
//
// REQUIREMENT TRACE:
//   Implements: FR-03 (vCenter-level parallelism cap),
//               AD-07 (layered architecture, async fan-out)
//
// NOTES:
//   - Asymmetric scheduling means: when one worker out of P
//     in-flight finishes, the next queued work item starts
//     immediately. We do NOT wait for all P workers to finish
//     before launching the next batch — that would be symmetric
//     batch scheduling and would idle workers behind a slow one.
//   - The action poll loop sleeps with System.sleep(ms). This is
//     a blocking sleep on the workflow's thread — that is the
//     correct behavior here because the calling workflow's whole
//     point is to wait for children.
//   - The parallelismCap is enforced strictly. If you pass
//     workItems.length = 8 and cap = 3, at most 3 children run at
//     any moment.
//   - The action is RESILIENT to children that fail or throw — a
//     failed child produces a result with state = "failed" and
//     errorMessage populated; the parent loop continues. This is
//     intentional and aligned with AD-11 (cleanup cascade).
//   - The inputBuilder Action is invoked synchronously to construct
//     each child's inputs. If the inputBuilder itself throws, that
//     work item cannot be dispatched — its result is recorded as
//     state = "failed" with the input-builder error.
//   - Result order matches workItems order regardless of finishing
//     order. Callers can zip workItems and results 1:1.
// ===================================================================

// -------------------------------------------------------------------
// Local logging prefix. This action does its own logging so callers
// can see scheduler decisions in audit logs.
// -------------------------------------------------------------------
var LOG_PREFIX = "[PSO-COMMON-PARALLEL]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 5) {
    throw new Error(
        "runWithParallelism requires 5 inputs: " +
        "(workItems, workerWorkflow, inputBuilderActionName, parallelismCap, pollIntervalSeconds)."
    );
}

var workItems              = arguments[0];
var workerWorkflow         = arguments[1];
var inputBuilderActionName = arguments[2];
var parallelismCap         = arguments[3];
var pollIntervalSeconds    = arguments[4];

if (workItems == null || !(workItems instanceof Array)) {
    throw new Error("runWithParallelism: 'workItems' must be an Array.");
}
if (workerWorkflow == null) {
    throw new Error("runWithParallelism: 'workerWorkflow' must be a Workflow object.");
}
if (typeof inputBuilderActionName !== "string" || inputBuilderActionName.length === 0) {
    throw new Error("runWithParallelism: 'inputBuilderActionName' must be a non-empty string.");
}
if (typeof parallelismCap !== "number" || parallelismCap < 1) {
    throw new Error("runWithParallelism: 'parallelismCap' must be a number >= 1.");
}
if (typeof pollIntervalSeconds !== "number" || pollIntervalSeconds < 1) {
    pollIntervalSeconds = 10; // sensible default if caller passes nonsense
}

// Parse the inputBuilderActionName. Expected format:
// "moduleName/actionName" — the same format as System.getModule.
var slashIdx = inputBuilderActionName.indexOf("/");
if (slashIdx < 1 || slashIdx === inputBuilderActionName.length - 1) {
    throw new Error(
        "runWithParallelism: 'inputBuilderActionName' must be in format " +
        "'moduleName/actionName'. Got: " + inputBuilderActionName
    );
}
var inputBuilderModule = inputBuilderActionName.substring(0, slashIdx);
var inputBuilderAction = inputBuilderActionName.substring(slashIdx + 1);

auditLogger.auditLog(
    LOG_PREFIX, "STARTUP", "OK",
    "Parallelism scheduler started | items=" + workItems.length +
    " | cap=" + parallelismCap +
    " | poll=" + pollIntervalSeconds + "s" +
    " | worker=" + workerWorkflow.name
);

// -------------------------------------------------------------------
// Result allocation. Pre-allocate the results array so the order
// matches workItems order regardless of completion timing. Each
// slot starts null and gets populated when its worker finishes.
// -------------------------------------------------------------------

var results = [];
for (var i = 0; i < workItems.length; i++) {
    results.push(null);
}

// -------------------------------------------------------------------
// Scheduler state.
//   nextItemIndex       — next workItems index to dispatch
//   inFlight            — array of objects:
//                           { workItemIndex: number,
//                             token: WorkflowToken,
//                             startedAt: Date }
// -------------------------------------------------------------------

var nextItemIndex = 0;
var inFlight = [];

// -------------------------------------------------------------------
// Helper: dispatch the next work item if there is one and we have
// capacity. Returns true if it dispatched, false if there's nothing
// to dispatch or capacity is full.
// -------------------------------------------------------------------
function tryDispatchNext() {
    if (nextItemIndex >= workItems.length) {
        return false; // no more items
    }
    if (inFlight.length >= parallelismCap) {
        return false; // capacity full
    }

    var workItemIndex = nextItemIndex;
    nextItemIndex++;

    var workItem = workItems[workItemIndex];

    // Build inputs for this child workflow. If the input builder
    // throws, record a failed result and continue.
    var inputs = null;
    var inputBuilderError = null;
    try {
        inputs = System.getModule(inputBuilderModule)[inputBuilderAction](workItem);
    } catch (e) {
        inputBuilderError = "Input builder threw: " + e.message;
    }

    if (inputBuilderError !== null || inputs == null) {
        // Cannot dispatch this work item. Record as failed.
        var failResult = new Properties();
        failResult.put("outputs", null);
        failResult.put("state", "failed");
        failResult.put(
            "errorMessage",
            inputBuilderError !== null
                ? inputBuilderError
                : "Input builder returned null."
        );
        failResult.put("wfRunId", "");
        failResult.put("startedAt", new Date());
        failResult.put("finishedAt", new Date());
        results[workItemIndex] = failResult;

        auditLogger.auditLog(
            LOG_PREFIX, "EXECUTE", "FAIL",
            "Item " + workItemIndex + " failed at input-build stage: " +
            failResult.get("errorMessage")
        );
        return true; // we still "dispatched" the slot (to a failed result)
    }

    // Launch the child workflow asynchronously. executeAsync returns
    // a WorkflowToken we can poll.
    var token = null;
    try {
        token = workerWorkflow.executeAsync(inputs);
    } catch (e) {
        // executeAsync itself failed (very rare — usually means a
        // permission or workflow-load error). Record failed.
        var execFailResult = new Properties();
        execFailResult.put("outputs", null);
        execFailResult.put("state", "failed");
        execFailResult.put("errorMessage", "executeAsync threw: " + e.message);
        execFailResult.put("wfRunId", "");
        execFailResult.put("startedAt", new Date());
        execFailResult.put("finishedAt", new Date());
        results[workItemIndex] = execFailResult;

        auditLogger.auditLog(
            LOG_PREFIX, "EXECUTE", "FAIL",
            "Item " + workItemIndex + " could not be launched: " + e.message
        );
        return true;
    }

    inFlight.push({
        workItemIndex: workItemIndex,
        token: token,
        startedAt: new Date()
    });

    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE", "OK",
        "Dispatched item " + workItemIndex + " | runId=" + token.id +
        " | inFlight=" + inFlight.length + "/" + parallelismCap
    );

    return true;
}

// -------------------------------------------------------------------
// Helper: harvest any finished workers from inFlight. Removes them
// from inFlight and writes their results to the results[] array.
// Returns the number of slots freed.
// -------------------------------------------------------------------
function harvestFinished() {
    var freedCount = 0;
    var stillInFlight = [];

    for (var i = 0; i < inFlight.length; i++) {
        var entry = inFlight[i];
        var token = entry.token;
        var state = token.state; // "running"|"waiting"|"completed"|"failed"|"canceled"|"suspended"

        if (state === "running" || state === "waiting" || state === "suspended") {
            // Still in flight, keep it.
            stillInFlight.push(entry);
            continue;
        }

        // Terminal state. Build a result entry.
        var result = new Properties();
        var outputs = null;
        var errorMessage = "";

        if (state === "completed") {
            // Pull workflow output attributes into a Properties bag.
            // token.getOutputParameters() returns Properties.
            try {
                outputs = token.getOutputParameters();
            } catch (e) {
                outputs = null;
                errorMessage = "Could not retrieve outputs: " + e.message;
            }
        } else if (state === "failed") {
            errorMessage = token.exception != null
                ? String(token.exception)
                : "Worker failed without exception detail.";
        } else if (state === "canceled" || state === "cancelled") {
            // vRO's spelling has been inconsistent across versions; handle both.
            state = "cancelled";
            errorMessage = "Worker was cancelled.";
        } else {
            errorMessage = "Worker ended in unexpected state: " + state;
        }

        result.put("outputs", outputs);
        result.put("state", state);
        result.put("errorMessage", errorMessage);
        result.put("wfRunId", token.id);
        result.put("startedAt", entry.startedAt);
        result.put("finishedAt", new Date());

        results[entry.workItemIndex] = result;

        auditLogger.auditLog(
            LOG_PREFIX, "EXECUTE", state === "completed" ? "DONE" : "FAIL",
            "Harvested item " + entry.workItemIndex +
            " | runId=" + token.id +
            " | state=" + state
        );

        freedCount++;
    }

    inFlight = stillInFlight;
    return freedCount;
}

// -------------------------------------------------------------------
// Main scheduler loop. The pattern:
//   1. Dispatch as many items as capacity allows.
//   2. If nothing in flight and nothing to dispatch, we're done.
//   3. Otherwise, sleep, then harvest finished workers, then loop.
//
// Asymmetric scheduling falls out naturally: harvestFinished frees
// individual slots as workers finish; the next loop iteration's
// dispatch step fills any freed slots immediately.
// -------------------------------------------------------------------

while (true) {
    // Dispatch as many as we can right now.
    while (tryDispatchNext()) {
        // tryDispatchNext returns true while it makes progress.
        // It will stop returning true when capacity is full OR
        // there are no more items.
    }

    // Termination check: nothing in flight, nothing left to dispatch.
    if (inFlight.length === 0 && nextItemIndex >= workItems.length) {
        break;
    }

    // Sleep, then harvest. System.sleep takes milliseconds.
    System.sleep(pollIntervalSeconds * 1000);
    harvestFinished();
}

// -------------------------------------------------------------------
// All workers finished. Final summary log line and return results.
// -------------------------------------------------------------------

var completedCount = 0;
var failedCount = 0;
var cancelledCount = 0;
for (var r = 0; r < results.length; r++) {
    var st = results[r].get("state");
    if (st === "completed") {
        completedCount++;
    } else if (st === "failed") {
        failedCount++;
    } else if (st === "cancelled") {
        cancelledCount++;
    }
}

auditLogger.auditLog(
    LOG_PREFIX, "CLEANUP", "RESULT",
    "Parallelism scheduler finished | total=" + results.length +
    " | completed=" + completedCount +
    " | failed=" + failedCount +
    " | cancelled=" + cancelledCount
);

return results;
