/**
 * Shared Scriptable Task: handlePSFailure
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow placement:
 *   Exception path from the OOTB "Invoke a PowerShell script" workflow element
 *   in ALL FOUR workflows:
 *     - Move-ArchivedLogs-LocalHost
 *     - Move-ArchivedLogs-ByADGroupName
 *     - Move-ArchivedLogs-ByADGroupCN
 *     - Remove-OldFiles-UNCShare
 *
 * Inputs (bound from exception outputs of the OOTB PS workflow):
 *   errorCode    (string)  — exception error code
 *   errorMessage (string)  — exception error message
 *
 * Outputs (workflow-level, set by this task):
 *   executionSuccess (boolean) — set to false
 *   executionOutput  (string)  — set to failure description
 *
 * This task feeds directly into [End - Failed: PS Execution].
 * ─────────────────────────────────────────────────────────────────────────────
 */

System.error(
    "handlePSFailure | PS execution failed" +
    " | errorCode=" + errorCode +
    " | errorMessage=" + errorMessage
);

executionSuccess = false;
executionOutput  = "PS execution failed: " + errorMessage;
