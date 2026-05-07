// ===================================================================
// ACTION:    auditLog
// MODULE:    com.broadcom.pso.common.logging
// PURPOSE:   Emit a single audit-level log line in the project's
//            standard structured format. Audit lines are unconditional
//            — they are always emitted regardless of the
//            'debugLogging' workflow input. Use auditLog for events
//            that must appear in production logs: phase boundaries,
//            failures, summary lines, decisions taken, and
//            externally-observable state changes.
//
// PHASE:     used at every phase
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: caller-supplied
//
// INPUTS:
//   prefix  (string) — Workflow-layer log prefix (e.g.
//                      "[ESXI-REMEDIATE-VC]"). Surrounding brackets
//                      are part of the convention; the action does
//                      not add them.
//   phase   (string) — Execution phase token. Must be one of:
//                        STARTUP, VALIDATE, AUTH, DISCOVER, DECIDE,
//                        EXECUTE, VERIFY, CLEANUP, ERROR
//                      OR one of the workflow-specific 14 per-host
//                      remediation phases (MM_PRECHECK,
//                      AUTH_PROVISION, AUTH_VERIFY, SSH_ENABLE,
//                      MM_ENTER, PATCH_LIST, PATCH_INSTALL, REBOOT,
//                      RECONNECT, VERIFY_BUILD, HA_REJOIN,
//                      SSH_DISABLE, MM_EXIT, AUTH_CLEANUP).
//                      The action does NOT validate the phase string
//                      against an enum — it is the caller's
//                      responsibility to pass a valid phase.
//   status  (string) — Status token. Must be one of:
//                        OK, SKIP, DONE, DRY-RUN, HOLD, WARN,
//                        FAIL, RESULT
//                      Same not-validated note as 'phase'.
//   message (string) — Human-readable message body. May contain
//                      pipe-separated key/value pairs for structured
//                      detail (e.g. "Cluster=prod-01 | Hosts=8").
//
// RETURNS: void
//
// REQUIREMENT TRACE:
//   Implements: FR-43, FR-44
//
// NOTES:
//   - Output format is exactly: "<prefix> [<phase>] [<status>] <message>"
//   - The function uses System.log() which is captured by VCF
//     Operations for Logs and tagged with the workflow's log marker
//     (set by initWorkflowLogging).
//   - Consider this action your primary logging tool. Reach for
//     debugLog only when you need verbose tracing of internal state
//     that does not need to appear in production logs.
//   - Empty string is acceptable for 'message' but discouraged —
//     audit lines without a message are usually mistakes.
// ===================================================================

// -------------------------------------------------------------------
// Input validation. We allow empty 'message' but require everything
// else.
// -------------------------------------------------------------------

if (arguments.length < 4) {
    throw new Error(
        "auditLog requires 4 inputs: " +
        "(prefix:string, phase:string, status:string, message:string). " +
        "Got " + arguments.length + " arguments."
    );
}

var prefix  = arguments[0];
var phase   = arguments[1];
var status  = arguments[2];
var message = arguments[3];

if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error("auditLog: 'prefix' must be a non-empty string.");
}
if (typeof phase !== "string" || phase.length === 0) {
    throw new Error("auditLog: 'phase' must be a non-empty string.");
}
if (typeof status !== "string" || status.length === 0) {
    throw new Error("auditLog: 'status' must be a non-empty string.");
}
if (typeof message !== "string") {
    // Empty string is OK; non-string is a programmer error.
    throw new Error("auditLog: 'message' must be a string (empty allowed).");
}

// -------------------------------------------------------------------
// Compose and emit the line. String concatenation rather than
// template literals because Rhino does not support backtick
// template strings.
// -------------------------------------------------------------------

var line = prefix + " [" + phase + "] [" + status + "] " + message;

System.log(line);
