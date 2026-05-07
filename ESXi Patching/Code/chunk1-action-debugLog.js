// ===================================================================
// ACTION:    debugLog
// MODULE:    com.broadcom.pso.common.logging
// PURPOSE:   Emit a debug-level log line ONLY when the caller's
//            'debugEnabled' flag is true. Used for verbose tracing
//            of internal state (variable values, loop counters,
//            decision inputs) that operators do not normally want
//            cluttering production logs but that are invaluable
//            when diagnosing a misbehaving run.
//
// PHASE:     used at every phase
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: caller-supplied
//
// INPUTS:
//   prefix       (string)  — Workflow-layer log prefix.
//   phase        (string)  — Execution phase token.
//   status       (string)  — Status token.
//   message      (string)  — Debug message body.
//   debugEnabled (boolean) — If false, the action is a no-op and
//                            returns immediately. If true, the line
//                            is emitted in the same format as
//                            auditLog with "[DEBUG]" appended at
//                            the end of the message body so debug
//                            lines are visually distinguishable.
//
// RETURNS: void
//
// REQUIREMENT TRACE:
//   Implements: FR-45, FR-46
//
// NOTES:
//   - The 'debugEnabled' flag is normally the workflow's top-level
//     'debugLogging' input parameter, propagated from layer to
//     layer. Each Scriptable Task or Action that wants to debug-log
//     must have access to this flag via workflow attributes or
//     direct input bindings.
//   - When debugEnabled is false, the cost of calling debugLog is
//     a single function call and a boolean check — effectively
//     zero. This means debugLog calls are safe to leave in the
//     code permanently rather than #ifdef-style stripping.
//   - The "[DEBUG]" suffix on the message is important: it lets
//     log-search queries trivially filter debug noise out
//     ("WHERE message NOT LIKE '%[DEBUG]%'").
// ===================================================================

// -------------------------------------------------------------------
// Input validation. Accept-and-skip when debugEnabled is false (or
// missing/falsy) so the cost of disabled debug calls is minimal.
// -------------------------------------------------------------------

if (arguments.length < 5) {
    throw new Error(
        "debugLog requires 5 inputs: " +
        "(prefix:string, phase:string, status:string, message:string, " +
        "debugEnabled:boolean). Got " + arguments.length + " arguments."
    );
}

var prefix       = arguments[0];
var phase        = arguments[1];
var status       = arguments[2];
var message      = arguments[3];
var debugEnabled = arguments[4];

// Fast-path no-op: if debug is disabled, exit immediately. We do
// NOT validate the other parameters in this path — the cost of
// validation on hot loops would defeat the purpose of having a
// gated debug logger.
if (!debugEnabled) {
    return;
}

// -------------------------------------------------------------------
// Debug is enabled. Validate inputs (now we care about correctness)
// and emit the line.
// -------------------------------------------------------------------

if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error("debugLog: 'prefix' must be a non-empty string.");
}
if (typeof phase !== "string" || phase.length === 0) {
    throw new Error("debugLog: 'phase' must be a non-empty string.");
}
if (typeof status !== "string" || status.length === 0) {
    throw new Error("debugLog: 'status' must be a non-empty string.");
}
if (typeof message !== "string") {
    throw new Error("debugLog: 'message' must be a string (empty allowed).");
}

// Compose the debug line. The "[DEBUG]" suffix on the message body
// (not on the structured prefix tokens) makes it grep-friendly
// without polluting the phase/status taxonomy.
var line = prefix + " [" + phase + "] [" + status + "] " + message + " [DEBUG]";

System.log(line);
