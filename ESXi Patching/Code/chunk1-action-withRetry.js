// ===================================================================
// ACTION:    withRetry
// MODULE:    com.broadcom.pso.common.workflow
// PURPOSE:   Invoke an Action with exponential-backoff retry on
//            failure. Used to make transient vCenter SDK glitches
//            (network blips, brief vCenter restarts, transient HTTP
//            5xx) survivable without surfacing them as workflow
//            failures.
//
// PHASE:     used at every phase
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [PSO-COMMON-RETRY]
//
// INPUTS:
//   actionName    (string)     — Fully-qualified action reference in
//                                 format "moduleName/actionName".
//   actionInputs  (Properties) — Properties bag of inputs to pass
//                                 to the action. Keys are positional
//                                 in the order the action expects.
//                                 The Properties bag is converted to
//                                 an Array of values in the order
//                                 listed in the optional 'inputOrder'
//                                 sub-key, or in alphabetical key
//                                 order if 'inputOrder' is absent.
//   maxAttempts   (number)     — Total number of attempts INCLUDING
//                                 the first one. Must be >= 1.
//                                 maxAttempts = 1 disables retry.
//   backoffMs     (number)     — Base delay between attempts in
//                                 milliseconds. The delay before
//                                 attempt N is backoffMs *
//                                 (2 ^ (N-2)) — i.e. backoffMs,
//                                 2*backoffMs, 4*backoffMs...
//                                 Use 1000 (1s) for fast-recovery
//                                 calls, 5000+ for slower systems.
//
// RETURNS: any — Whatever the wrapped action returns on its first
//                successful attempt. If all attempts fail, the LAST
//                exception is rethrown so the caller can see the
//                final error condition.
//
// REQUIREMENT TRACE:
//   Implements: NFR-04 robustness against transient failures.
//
// NOTES:
//   - The action throws if all attempts fail. This is intentional:
//     callers who want a "soft" version that returns null on
//     exhaustion should wrap THIS action in their own try/catch.
//   - The wrapped action is invoked using the standard
//     System.getModule().<action>() pattern, NOT via Workflow.run.
//   - Inputs are passed positionally. Two ways to control order:
//     (a) Add an 'inputOrder' Array key to actionInputs that lists
//         the keys in the order the action expects them.
//     (b) Omit 'inputOrder' and the keys will be passed in
//         alphabetical order. This is fragile — explicit
//         inputOrder is recommended.
//   - The exponential backoff caps internally at 30 seconds per
//     wait so misconfigured backoffMs (e.g. 10000 with maxAttempts=
//     10 would otherwise sleep for over 5 hours on the last attempt)
//     does not cause a workflow to hang.
//   - Each attempt logs at audit level so retry behavior is visible
//     in production logs.
// ===================================================================

var LOG_PREFIX = "[PSO-COMMON-RETRY]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

var MAX_BACKOFF_MS = 30000; // hard ceiling per wait

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 4) {
    throw new Error(
        "withRetry requires 4 inputs: " +
        "(actionName:string, actionInputs:Properties, maxAttempts:number, backoffMs:number)."
    );
}

var actionName   = arguments[0];
var actionInputs = arguments[1];
var maxAttempts  = arguments[2];
var backoffMs    = arguments[3];

if (typeof actionName !== "string" || actionName.length === 0) {
    throw new Error("withRetry: 'actionName' must be a non-empty string.");
}
if (actionInputs == null) {
    throw new Error("withRetry: 'actionInputs' must be a Properties object (use empty Properties for no inputs).");
}
if (typeof maxAttempts !== "number" || maxAttempts < 1) {
    throw new Error("withRetry: 'maxAttempts' must be a number >= 1.");
}
if (typeof backoffMs !== "number" || backoffMs < 0) {
    throw new Error("withRetry: 'backoffMs' must be a non-negative number.");
}

// Parse "moduleName/actionName" into pieces.
var slashIdx = actionName.indexOf("/");
if (slashIdx < 1 || slashIdx === actionName.length - 1) {
    throw new Error(
        "withRetry: 'actionName' must be in format 'moduleName/actionName'. " +
        "Got: " + actionName
    );
}
var moduleName = actionName.substring(0, slashIdx);
var bareActionName = actionName.substring(slashIdx + 1);

// -------------------------------------------------------------------
// Build the positional argument list from actionInputs.
// Determine input order from 'inputOrder' key or alphabetical fall-
// back.
// -------------------------------------------------------------------

var inputOrder = actionInputs.get("inputOrder");
var orderedKeys = [];

if (inputOrder != null && inputOrder instanceof Array) {
    // Explicit order: use as-is.
    for (var i = 0; i < inputOrder.length; i++) {
        orderedKeys.push(inputOrder[i]);
    }
} else {
    // Alphabetical fallback. Properties.keys returns an Array.
    var allKeys = actionInputs.keys;
    var sortable = [];
    for (var k = 0; k < allKeys.length; k++) {
        if (allKeys[k] !== "inputOrder") {
            sortable.push(allKeys[k]);
        }
    }
    sortable.sort(); // alphabetical
    orderedKeys = sortable;
}

// Build the actual argument array.
var orderedArgs = [];
for (var oi = 0; oi < orderedKeys.length; oi++) {
    orderedArgs.push(actionInputs.get(orderedKeys[oi]));
}

// -------------------------------------------------------------------
// Resolve the action handle once. If the module/action does not
// exist, fail fast — this is a programmer error, not a transient
// failure to retry.
// -------------------------------------------------------------------

var actionModule;
try {
    actionModule = System.getModule(moduleName);
} catch (e) {
    throw new Error("withRetry: cannot load module '" + moduleName + "': " + e.message);
}

if (typeof actionModule[bareActionName] !== "function") {
    throw new Error(
        "withRetry: action '" + bareActionName +
        "' not found in module '" + moduleName + "'."
    );
}

var actionFn = actionModule[bareActionName];

// -------------------------------------------------------------------
// Retry loop.
// -------------------------------------------------------------------

var lastError = null;

for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    auditLogger.auditLog(
        LOG_PREFIX, "EXECUTE", "OK",
        "Invoking " + actionName + " | attempt=" + attempt + "/" + maxAttempts
    );

    try {
        // .apply lets us pass an array of arguments positionally.
        var result = actionFn.apply(actionModule, orderedArgs);

        if (attempt > 1) {
            auditLogger.auditLog(
                LOG_PREFIX, "EXECUTE", "DONE",
                "Action " + actionName + " succeeded on attempt " + attempt
            );
        }
        return result;
    } catch (e) {
        lastError = e;
        auditLogger.auditLog(
            LOG_PREFIX, "EXECUTE", "WARN",
            "Action " + actionName + " threw on attempt " + attempt +
            "/" + maxAttempts + " | error=" + e.message
        );

        if (attempt < maxAttempts) {
            // Compute backoff: backoffMs * 2^(attempt-1), capped.
            var multiplier = 1;
            for (var p = 1; p < attempt; p++) {
                multiplier = multiplier * 2;
            }
            var sleepMs = backoffMs * multiplier;
            if (sleepMs > MAX_BACKOFF_MS) {
                sleepMs = MAX_BACKOFF_MS;
            }

            auditLogger.auditLog(
                LOG_PREFIX, "EXECUTE", "HOLD",
                "Sleeping " + sleepMs + "ms before retry"
            );
            System.sleep(sleepMs);
        }
    }
}

// All attempts exhausted. Rethrow the last error so the caller sees it.
auditLogger.auditLog(
    LOG_PREFIX, "EXECUTE", "FAIL",
    "Action " + actionName + " exhausted all " + maxAttempts +
    " attempts | last error=" + (lastError !== null ? lastError.message : "(unknown)")
);

throw new Error(
    "withRetry exhausted " + maxAttempts + " attempts on " + actionName +
    ". Last error: " + (lastError !== null ? lastError.message : "(unknown)")
);
