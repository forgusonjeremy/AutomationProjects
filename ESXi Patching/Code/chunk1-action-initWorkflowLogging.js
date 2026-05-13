// ===================================================================
// ACTION:    initWorkflowLogging
// MODULE:    com.broadcom.pso.common.logging
// PURPOSE:   Set the vRO log marker for the running workflow and emit
//            the WorkflowStart audit log line. This MUST be the first
//            action invoked at the start of every workflow that wishes
//            its log output to be filterable in VCF Operations for
//            Logs by run ID.
// PHASE:     STARTUP (used by every workflow)
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: caller-supplied (e.g. [ESXI-REMEDIATE-VC])
//
// INPUTS:
//   prefix (string) — Per-line audit-log prefix used elsewhere in
//                     the workflow. Examples:
//                       [ESXI-REMEDIATE-VC]   (Remediate vSphere Environment)
//                       [ESXI-REMEDIATE-CL]   (Remediate vSphere Cluster)
//                       [ESXI-REMEDIATE-HOST] (Remediate ESX Host)
//
// RETURNS: void
//
// REQUIREMENT TRACE:
//   Implements: FR-42, FR-46
//   Per AD-07 (layered architecture): WF-01 sets the marker, child
//   workflows inherit it automatically because vRO propagates the
//   log marker into the child workflow's logging scope when invoked
//   via Workflow.execute() / Workflow.executeAsync().
//
// NOTES:
//   - The marker format is intentionally exact:
//        "Workflow Name:<name>-WorkflowRunId:<id>"
//     This is what VCF Operations for Logs filters on when an
//     operator pulls a single run's logs out of the firehose.
//   - The action uses System.setLogMarker() which is a vRO platform
//     API. Calling it has no effect if the marker is already set
//     by a parent workflow — that is why setting it once at WF-01
//     entry is sufficient to tag all children's logs.
//   - The action emits a single audit log line on success so logs
//     immediately show that initialization succeeded.
//   - Called from a Scriptable Task, NOT from a workflow Action
//     element. Because: the action needs access to the
//     'workflow' global (for workflow.name and workflow.id) which
//     is only available inside a Scriptable Task's scope.
//     The action is therefore invoked indirectly:
//        var wfName  = workflow.name;
//        var wfRunId = workflow.id;
//        System.getModule(
//            "com.broadcom.pso.common.logging"
//        ).initWorkflowLogging(prefix, wfName, wfRunId);
// ===================================================================

// -------------------------------------------------------------------
// Input validation. Rhino has no default parameters, so we check
// arguments explicitly. We accept three inputs for the reason
// described in the NOTES above: the action cannot reach the
// 'workflow' global directly — it must be passed in by the caller.
// -------------------------------------------------------------------

if (arguments.length < 3) {
    throw new Error(
        "initWorkflowLogging requires 3 inputs: " +
        "(prefix:string, wfName:string, wfRunId:string). " +
        "Got " + arguments.length + " arguments."
    );
}

// 'prefix', 'wfName', 'wfRunId' come in as positional arguments.
// Rhino exposes them via the 'arguments' object. Pull them out
// and validate types.
var prefix  = arguments[0];
var wfName  = arguments[1];
var wfRunId = arguments[2];

if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error("initWorkflowLogging: 'prefix' must be a non-empty string.");
}
if (typeof wfName !== "string" || wfName.length === 0) {
    throw new Error("initWorkflowLogging: 'wfName' must be a non-empty string.");
}
if (typeof wfRunId !== "string" || wfRunId.length === 0) {
    throw new Error("initWorkflowLogging: 'wfRunId' must be a non-empty string.");
}

// -------------------------------------------------------------------
// Compose and set the log marker. The format is exact and must not
// be changed lightly — VCF Operations for Logs queries are
// keyed on this string.
// -------------------------------------------------------------------

var marker = "Workflow Name:" + wfName + "-WorkflowRunId:" + wfRunId;

// System.setLogMarker is a vRO platform method. It tags every
// subsequent System.log/warn/error call with this marker until
// the workflow ends or the marker is replaced. Child workflows
// invoked from this workflow inherit the marker.
System.setLogMarker(marker);

// -------------------------------------------------------------------
// Emit the WorkflowStart audit log line. Two log lines are emitted:
//   1. The raw "WorkflowStart:" marker line — verbatim from the
//      system prompt's logging template, used for log-grep entry
//      points.
//   2. A structured audit line in the project's standard format.
// -------------------------------------------------------------------

System.log("WorkflowStart:" + marker);
System.log(prefix + " [STARTUP] [OK] Workflow initialized | RunId: " + wfRunId);
