// ===================================================================
// ACTION:    releaseAllLocksHeldByWorkflow
// MODULE:    com.broadcom.pso.common.workflow
// PURPOSE:   Release every LockingSystem lock currently owned by the
//            given workflow run. Intended for use in a workflow's
//            Default Error Handler (DEH) so that a workflow that
//            crashes before reaching its normal cleanup code does
//            not leave locks orphaned.
//
// PHASE:     CLEANUP / ERROR (called from DEH)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [PSO-COMMON-LOCK]
//
// INPUTS:
//   workflowRunId (string) — The workflow.id of the workflow whose
//                            locks should be released. Typically the
//                            calling workflow itself; in WF-07
//                            reconciliation contexts, the ID of a
//                            different (dead) workflow whose locks
//                            need force-release.
//
// RETURNS: number — count of locks released.
//
// REQUIREMENT TRACE:
//   Implements: AD-11 cleanup cascade rule 4 (idempotent),
//               FR-33 (cluster-scope lock release in all exit paths).
//
// NOTES:
//   - Uses LockingSystem.retrieveAll() (verified vRO platform API)
//     to enumerate every lock currently in the locking database.
//     Each lock has properties .id (the lock name) and .owner
//     (the run ID that holds it).
//   - Filters to locks owned by the supplied workflowRunId, then
//     calls LockingSystem.unlock(lockId, ownerRunId) on each.
//   - Idempotent: if no locks are held, returns 0 with no error.
//   - Failures on individual unlock attempts are caught and logged;
//     the function continues with remaining locks. The returned
//     count reflects only successful releases. This matters in
//     reconciliation contexts where partial failures should not
//     block the rest of the cleanup.
//   - The action is GENERIC — it does not know about the
//     ESXI_PATCH_* lock naming convention. Callers wanting to
//     filter by lock name pattern should use force-release
//     workflows (WF-05) instead.
// ===================================================================

var LOG_PREFIX = "[PSO-COMMON-LOCK]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 1) {
    throw new Error("releaseAllLocksHeldByWorkflow requires 1 input: workflowRunId (string).");
}

var workflowRunId = arguments[0];

if (typeof workflowRunId !== "string" || workflowRunId.length === 0) {
    throw new Error(
        "releaseAllLocksHeldByWorkflow: 'workflowRunId' must be a non-empty string."
    );
}

auditLogger.auditLog(
    LOG_PREFIX, "CLEANUP", "OK",
    "Enumerating locks for workflow run | runId=" + workflowRunId
);

// -------------------------------------------------------------------
// Enumerate all locks. retrieveAll returns an array of Lock objects.
// Some vRO versions return null for an empty system; defensive null
// check keeps us idempotent.
// -------------------------------------------------------------------

var allLocks = null;
try {
    allLocks = LockingSystem.retrieveAll();
} catch (e) {
    // If retrieveAll itself throws, log and treat as empty. We do
    // NOT rethrow — DEH must not introduce new failures.
    auditLogger.auditLog(
        LOG_PREFIX, "CLEANUP", "WARN",
        "LockingSystem.retrieveAll threw: " + e.message + " | proceeding with 0 locks"
    );
    allLocks = null;
}

if (allLocks == null || allLocks.length === 0) {
    auditLogger.auditLog(
        LOG_PREFIX, "CLEANUP", "DONE",
        "No locks present in locking system | runId=" + workflowRunId
    );
    return 0;
}

// -------------------------------------------------------------------
// Filter to locks owned by this run, and release each.
// -------------------------------------------------------------------

var releasedCount = 0;
var failedCount = 0;

for (var i = 0; i < allLocks.length; i++) {
    var lock = allLocks[i];

    // The Lock object has .id (lock name) and .owner properties.
    // Defensive: if either is missing, skip this lock entirely.
    if (lock == null || lock.id == null || lock.owner == null) {
        continue;
    }

    if (String(lock.owner) !== workflowRunId) {
        continue; // not ours, leave alone
    }

    var lockId = String(lock.id);

    try {
        LockingSystem.unlock(lockId, workflowRunId);
        releasedCount++;
        auditLogger.auditLog(
            LOG_PREFIX, "CLEANUP", "DONE",
            "Released lock | lockId=" + lockId + " | owner=" + workflowRunId
        );
    } catch (e) {
        // Individual unlock failure: log and keep going.
        failedCount++;
        auditLogger.auditLog(
            LOG_PREFIX, "CLEANUP", "WARN",
            "Failed to release lock | lockId=" + lockId +
            " | owner=" + workflowRunId +
            " | error=" + e.message
        );
    }
}

auditLogger.auditLog(
    LOG_PREFIX, "CLEANUP", "RESULT",
    "Lock release sweep complete | released=" + releasedCount +
    " | failed=" + failedCount +
    " | runId=" + workflowRunId
);

return releasedCount;
