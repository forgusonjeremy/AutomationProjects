// ===================================================================
// ACTION:    generateShortRunId
// MODULE:    com.broadcom.pso.vc.esxi.remediation.account
// PURPOSE:   Convert a vRO workflow run ID (a UUID like
//            "d4e84e3f-3c8f-4561-9b9e-a8b91c3e8d62") into a short
//            8-character lowercase hex string suitable for use in
//            ESXi local user account names per AD-08.
//
//            Run-ID-derived names give us:
//              * Uniqueness — the run ID is already unique
//              * Traceability — back to the run that created it
//              * Cleanability — orphan accounts have a recognizable
//                prefix the reconcile workflow (WF-07) can find.
//
// PHASE:     AUTH_PROVISION (called once per host)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-ACCOUNT]
//
// INPUTS:
//   workflowRunId (string) — Full vRO run ID. Caller passes
//                            workflow.id from a Scriptable Task.
//
// RETURNS: Properties — {
//            shortId   (string) — 8-character lowercase hex
//            username  (string) — "vro-patch-<shortId>"
//          }
//
// REQUIREMENT TRACE:
//   Implements: AD-08 (ephemeral per-run ESXi account naming).
//
// NOTES:
//   - vRO run IDs are UUIDs in the standard 8-4-4-4-12 hex format.
//     Stripping dashes gives 32 hex characters; the first 8 of
//     those is sufficient — collision risk is negligible at this
//     project's scale (7-10 vCenters × few clusters × few hosts ×
//     runs/year).
//   - All-lowercase per ESXi POSIX local user conventions. ESXi 8.x
//     accepts mixed case but the reconciliation workflow's pattern
//     match is case-sensitive, so we standardize.
//   - Username pattern "vro-patch-<8hex>" is exactly 18 characters,
//     well within ESXi's 32-character local username limit.
//   - Hyphen prefix "vro-patch-" lets WF-07 / WF-06 (admin
//     workflows) easily recognize candidates for cleanup via a
//     prefix match.
//   - If passed a string that's NOT a UUID, the action takes the
//     first 8 alphanumeric characters and lowercases them. This
//     handles synthetic/test inputs gracefully.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-ACCOUNT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("generateShortRunId requires 1 input: workflowRunId.");
}
var workflowRunId = arguments[0];

if (typeof workflowRunId !== "string" || workflowRunId.length === 0) {
    throw new Error("generateShortRunId: 'workflowRunId' must be non-empty string.");
}

// -------------------------------------------------------------------
// Strip non-hex characters (dashes, mostly), take first 8, lowercase.
// -------------------------------------------------------------------

var stripped = workflowRunId.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
if (stripped.length < 8) {
    // Pad with zeros (shouldn't happen for real run IDs).
    while (stripped.length < 8) stripped += "0";
}

var shortId = stripped.substring(0, 8);
var username = "vro-patch-" + shortId;

var result = new Properties();
result.put("shortId", shortId);
result.put("username", username);

auditLogger.auditLog(
    LOG_PREFIX, "AUTH_PROVISION", "OK",
    "Generated short run ID | runId=" + workflowRunId +
    " | shortId=" + shortId + " | username=" + username
);

return result;
