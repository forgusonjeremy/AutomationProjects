// ===================================================================
// ACTION:    buildClusterValidationSummary
// MODULE:    com.broadcom.pso.vc.esxi.remediation.form
// PURPOSE:   Aggregate the cheap pre-flight findings across the
//            clusters the operator has selected in the form picker
//            and produce a multi-line text-area-friendly summary.
//            The output renders inline below the cluster picker
//            (per AD-12, FR-12) so the operator sees ALL findings
//            for ALL selected clusters before clicking Submit.
//
// PHASE:     form-time
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-FORM]
//
// INPUTS:
//   selectedClusters         (Array/VC:ClusterComputeResource)
//                            — Clusters the operator selected.
//                              May be empty (form not ready) — in
//                              which case the action returns a
//                              friendly "no clusters selected"
//                              placeholder rather than failing.
//   depotItem                (Properties)  — Selected depot item
//                                            from getDepotItemsForVcenter,
//                                            or null.
//   smallClusterAcknowledged (boolean)     — Current Ack2 state.
//   ignoreWarnings           (boolean)     — Current advanced toggle
//                                            state.
//
// RETURNS: string — Multi-line summary suitable for display in a
//                   monospace text-area. Each cluster gets its own
//                   block. CRITICAL findings get a prominent header
//                   with "⚠ CRITICAL WARNINGS" so the operator
//                   cannot miss them.
//
// REQUIREMENT TRACE:
//   Implements: AD-12 (Validation Summary inline in cluster
//               selection section), FR-12 (text-area composition).
//
// FORMAT:
//   No clusters selected →
//     "Select one or more clusters above to see validation results."
//
//   Clusters selected (one or more) →
//     ============================================================
//     VALIDATION SUMMARY (3 cluster(s) selected)
//     ============================================================
//
//     ⚠ CRITICAL WARNINGS — SUBMISSION WILL BE BLOCKED ⚠
//
//     [cluster: prod-01] BLOCKED
//       ✗ CRITICAL: 3-node cluster blocked per AD-04 hybrid policy.
//
//     ------------------------------------------------------------
//
//     [cluster: prod-02] WARNING
//       ⚠ WARNING: 2 host(s) in lockdown — will be skipped.
//       ⚠ WARNING: vSAN health: 1 non-green finding.
//
//     ------------------------------------------------------------
//
//     [cluster: prod-03] READY
//       ✓ All checks passed.
//
//     ============================================================
//
//   The action wraps long messages at ~78 columns to prevent
//   horizontal scrolling in the form text-area.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-FORM]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 4) {
    throw new Error(
        "buildClusterValidationSummary requires 4 inputs: " +
        "(selectedClusters, depotItem, smallClusterAcknowledged, ignoreWarnings)."
    );
}
var selectedClusters         = arguments[0];
var depotItem                = arguments[1];
var smallClusterAcknowledged = arguments[2];
var ignoreWarnings           = arguments[3];

if (typeof smallClusterAcknowledged !== "boolean") smallClusterAcknowledged = false;
if (typeof ignoreWarnings !== "boolean") ignoreWarnings = false;

// -------------------------------------------------------------------
// Empty / not-ready case.
// -------------------------------------------------------------------

if (selectedClusters == null || !(selectedClusters instanceof Array)
    || selectedClusters.length === 0) {
    return "Select one or more clusters above to see validation results.";
}

// -------------------------------------------------------------------
// Pull depot filename if available.
// -------------------------------------------------------------------

var depotName = "";
if (depotItem != null) {
    try {
        var fn = depotItem.get("itemFileName");
        if (fn != null) depotName = String(fn);
    } catch (e) { /* continue */ }
}

// -------------------------------------------------------------------
// Run pre-flight per cluster, then assemble the summary text.
// -------------------------------------------------------------------

var preflight = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");

// Constants for formatting.
var SEPARATOR_THICK = "============================================================";
var SEPARATOR_THIN  = "------------------------------------------------------------";
var WRAP_COLS = 76;

// Internal: word-wrap a long string to <= WRAP_COLS chars per line,
// preserving an indentation prefix on continuation lines.
function wrap(text, indent) {
    if (text == null) return "";
    var s = String(text);
    if (s.length <= WRAP_COLS) return s;

    var lines = [];
    var remaining = s;
    var first = true;
    var contIndent = indent != null ? indent : "  ";

    while (remaining.length > WRAP_COLS) {
        // Find a space at or before WRAP_COLS to break on.
        var breakAt = WRAP_COLS;
        var spaceIdx = remaining.lastIndexOf(" ", WRAP_COLS);
        if (spaceIdx > 20) {
            breakAt = spaceIdx;
        }
        var chunk = remaining.substring(0, breakAt);
        if (first) {
            lines.push(chunk);
            first = false;
        } else {
            lines.push(contIndent + chunk);
        }
        remaining = remaining.substring(breakAt).replace(/^ +/, "");
    }
    if (remaining.length > 0) {
        if (first) {
            lines.push(remaining);
        } else {
            lines.push(contIndent + remaining);
        }
    }
    return lines.join("\n");
}

var clusterBlocks = [];
var anyCritical = false;
var anyWarning = false;

for (var i = 0; i < selectedClusters.length; i++) {
    var cluster = selectedClusters[i];
    if (cluster == null) continue;

    var clusterName = "(unknown)";
    try {
        clusterName = String(cluster.name);
    } catch (e) {
        continue;
    }

    var pf = null;
    var pfError = null;
    try {
        pf = preflight.evaluateClusterPreflightCheap(
            cluster,
            depotName,
            smallClusterAcknowledged,
            ignoreWarnings
        );
    } catch (e) {
        pfError = e.message;
    }

    var blockLines = [];
    blockLines.push("[cluster: " + clusterName + "] " +
                    (pfError != null ? "PROBE_ERROR" : pf.get("status")));

    if (pfError != null) {
        blockLines.push("  ✗ Pre-flight evaluation failed: " + pfError);
        anyCritical = true;
    } else {
        var findings = pf.get("findings");
        if (findings == null || findings.length === 0) {
            blockLines.push("  ✓ All checks passed.");
        } else {
            var hasContent = false;
            for (var fi = 0; fi < findings.length; fi++) {
                var finding = findings[fi];
                if (finding == null) continue;

                var marker;
                if (finding.severity === "CRITICAL") {
                    marker = "  ✗ CRITICAL: ";
                    anyCritical = true;
                } else if (finding.severity === "WARNING") {
                    marker = "  ⚠ WARNING:  ";
                    anyWarning = true;
                } else {
                    marker = "  ℹ INFO:     ";
                }
                hasContent = true;
                blockLines.push(marker + wrap(finding.message, "                "));
            }
            if (!hasContent) {
                blockLines.push("  ✓ All checks passed.");
            }
        }
    }

    clusterBlocks.push(blockLines.join("\n"));
}

// -------------------------------------------------------------------
// Compose final output.
// -------------------------------------------------------------------

var out = [];
out.push(SEPARATOR_THICK);
out.push("VALIDATION SUMMARY (" + selectedClusters.length + " cluster(s) selected)");
out.push(SEPARATOR_THICK);
out.push("");

if (anyCritical) {
    out.push("⚠ CRITICAL WARNINGS — SUBMISSION WILL BE BLOCKED ⚠");
    out.push("");
} else if (anyWarning && !ignoreWarnings) {
    out.push("⚠ Warnings present — review before submitting,");
    out.push("  or check 'Ignore preflight warnings' in Advanced.");
    out.push("");
}

for (var b = 0; b < clusterBlocks.length; b++) {
    out.push(clusterBlocks[b]);
    if (b < clusterBlocks.length - 1) {
        out.push("");
        out.push(SEPARATOR_THIN);
        out.push("");
    }
}

out.push("");
out.push(SEPARATOR_THICK);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", anyCritical ? "FAIL" : (anyWarning ? "WARN" : "OK"),
    "Built validation summary | clusters=" + selectedClusters.length +
    " | critical=" + anyCritical + " | warning=" + anyWarning
);

return out.join("\n");
