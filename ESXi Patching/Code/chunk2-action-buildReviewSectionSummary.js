// ===================================================================
// ACTION:    buildReviewSectionSummary
// MODULE:    com.broadcom.pso.vc.esxi.remediation.form
// PURPOSE:   Generate the read-only Review section summary (Section
//            7 of the request form). Shows EVERY form value
//            including any whose value matches the default (per
//            FR-13 — operators have been bitten by silent defaults
//            in past projects, so we show all values explicitly,
//            and tag defaulted values with "(default)" so it's
//            clear what came from the form vs what is system-set).
//
// PHASE:     form-time
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-FORM]
//
// INPUTS: ALL workflow input values, passed in a single Properties
//          bag. Expected keys (matching workflow inputs from WF-01):
//            vmsaReference                 (string)
//            ack1Acknowledged              (boolean)
//            ack2SmallClusterAcknowledged  (boolean)   [optional]
//            ack3FinalAcknowledged         (boolean)
//            vcenter                       (VC:SdkConnection)
//            depotItem                     (Properties)
//            clusters                      (Array/VC:ClusterComputeResource)
//            notificationToList            (Array/string)
//            notificationCcList            (Array/string)
//            rebootBudgetMinutes           (number)
//            ignorePreflightWarnings       (boolean)
//            showAllVsanHealthGroups       (boolean)
//            maxParallelClusters           (number)
//            debugLogging                  (boolean)
//            recentTaskLookbackMinutes     (number)
//
//          Plus a parallel "defaults" Properties identifying which
//          fields are at their default values:
//            defaults.<key> = true if the field is at its default
//
//          Inputs are positional: arguments[0] is the values bag,
//          arguments[1] is the defaults bag.
//
// RETURNS: string — Multi-line review summary suitable for a
//                   read-only text-area.
//
// REQUIREMENT TRACE:
//   Implements: FR-13 (Section 7 review showing all values
//               regardless of defaults).
//
// FORMAT:
//   ============================================================
//   REVIEW — please verify ALL values before submitting
//   ============================================================
//
//   ─── Acknowledgements ────────────────────────────────────────
//     VMSA Reference         : VMSA-2024-0001
//     Read & Understood KB   : ✓
//     4-node Acknowledgement : (not applicable)
//     Final Acknowledgement  : ✓
//
//   ─── Target ──────────────────────────────────────────────────
//     vCenter                : vc01.example.com
//     Depot                  : VMware-ESXi-8.0U3-24585300-depot.zip
//     Library                : ESXi-Patches-Prod
//     Clusters (3)           : prod-01, prod-02, prod-03
//
//   ─── Notifications ───────────────────────────────────────────
//     To                     : ops@example.com
//     CC                     : (none)
//
//   ─── Advanced ────────────────────────────────────────────────
//     Reboot Budget (min)    : 25 (default)
//     Ignore Warnings        : false (default)
//     Show All vSAN Groups   : false (default)
//     Max Parallel Clusters  : 3 (default)
//     Debug Logging          : false (default)
//     Recent Task Lookback   : 60 (default)
//
//   ============================================================
//
// NOTES:
//   - "(default)" tags are appended ONLY when the corresponding
//     defaults bag has a true entry for that key. This is the
//     mechanism that meets FR-13's "show all values regardless of
//     default" requirement while still surfacing which values are
//     explicit choices.
//   - For VMSA reference: even though it's a required field with
//     no default, we render it in the Acknowledgements block.
//   - For 4-node acknowledgement: rendered as "(not applicable)"
//     when no selected cluster is 4-node, otherwise "✓" or "✗".
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-FORM]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error(
        "buildReviewSectionSummary requires 1-2 inputs: (values, [defaults])."
    );
}
var values   = arguments[0];
var defaults = arguments.length >= 2 && arguments[1] != null
                ? arguments[1]
                : new Properties();

if (values == null) {
    return "Form values not yet available.";
}

// -------------------------------------------------------------------
// Helpers.
// -------------------------------------------------------------------

var SEPARATOR_THICK = "============================================================";
var SECTION_RULE    = "─── ";
var SECTION_RULE_R  = " ────────────────────────────────────────────────────";

function ruleFor(name) {
    var s = SECTION_RULE + name + " ";
    while (s.length < 60) s += "─";
    return s;
}

// Format a key/value line with consistent column width. Key column
// is 22 chars wide.
function line(key, val, isDefault) {
    var paddedKey = key;
    while (paddedKey.length < 22) paddedKey += " ";
    var defaultTag = (isDefault === true) ? " (default)" : "";
    return "  " + paddedKey + ": " + (val != null ? val : "(none)") + defaultTag;
}

// Render a boolean as "✓" / "✗".
function boolGlyph(b) {
    return b === true ? "✓" : "✗";
}

// Get a value (possibly null/missing).
function v(key) {
    try {
        return values.get(key);
    } catch (e) {
        return null;
    }
}

// Was a value supplied as default?
function isDflt(key) {
    try {
        return defaults.get(key) === true;
    } catch (e) {
        return false;
    }
}

// -------------------------------------------------------------------
// Build the document.
// -------------------------------------------------------------------

var out = [];
out.push(SEPARATOR_THICK);
out.push("REVIEW — please verify ALL values before submitting");
out.push(SEPARATOR_THICK);
out.push("");

// ---- Acknowledgements ----
out.push(ruleFor("Acknowledgements"));

var vmsa = v("vmsaReference");
out.push(line("VMSA Reference", vmsa != null ? vmsa : "(missing)", false));
out.push(line("Read & Understood KB", boolGlyph(v("ack1Acknowledged") === true), false));

// 4-node acknowledgement: "applicable only if any 4-node cluster".
var clusters = v("clusters");
var any4Node = false;
if (clusters != null && clusters instanceof Array) {
    for (var ci = 0; ci < clusters.length; ci++) {
        try {
            if (clusters[ci] != null && clusters[ci].host != null
                && clusters[ci].host.length === 4) {
                any4Node = true;
                break;
            }
        } catch (e) { /* continue */ }
    }
}
if (any4Node) {
    out.push(line(
        "4-node Acknowledgement",
        boolGlyph(v("ack2SmallClusterAcknowledged") === true),
        false
    ));
} else {
    out.push(line("4-node Acknowledgement", "(not applicable)", false));
}

out.push(line("Final Acknowledgement", boolGlyph(v("ack3FinalAcknowledged") === true), false));
out.push("");

// ---- Target ----
out.push(ruleFor("Target"));

var vcenter = v("vcenter");
var vcenterName = "(missing)";
try {
    if (vcenter != null) vcenterName = String(vcenter.name);
} catch (e) { /* continue */ }
out.push(line("vCenter", vcenterName, false));

var depotItem = v("depotItem");
var depotFilename = "(missing)";
var depotLibrary = "(missing)";
if (depotItem != null) {
    try {
        var fn = depotItem.get("itemFileName");
        if (fn != null) depotFilename = String(fn);
        var lb = depotItem.get("libraryName");
        if (lb != null) depotLibrary = String(lb);
    } catch (e) { /* continue */ }
}
out.push(line("Depot", depotFilename, false));
out.push(line("Library", depotLibrary, false));

if (clusters != null && clusters instanceof Array && clusters.length > 0) {
    var clusterNames = [];
    for (var ck = 0; ck < clusters.length; ck++) {
        try {
            if (clusters[ck] != null) clusterNames.push(String(clusters[ck].name));
        } catch (e) { /* continue */ }
    }
    out.push(line(
        "Clusters (" + clusterNames.length + ")",
        clusterNames.join(", "),
        false
    ));
} else {
    out.push(line("Clusters (0)", "(none selected)", false));
}
out.push("");

// ---- Notifications ----
out.push(ruleFor("Notifications"));

var toList = v("notificationToList");
var ccList = v("notificationCcList");

var toStr = "(none)";
if (toList != null && toList instanceof Array && toList.length > 0) {
    toStr = toList.join(", ");
}
out.push(line("To", toStr, false));

var ccStr = "(none)";
if (ccList != null && ccList instanceof Array && ccList.length > 0) {
    ccStr = ccList.join(", ");
}
out.push(line("CC", ccStr, isDflt("notificationCcList") && ccStr === "(none)"));
out.push("");

// ---- Advanced ----
out.push(ruleFor("Advanced"));

var reboot = v("rebootBudgetMinutes");
out.push(line(
    "Reboot Budget (min)",
    reboot != null ? String(reboot) : "(unset)",
    isDflt("rebootBudgetMinutes")
));

out.push(line(
    "Ignore Warnings",
    String(v("ignorePreflightWarnings") === true),
    isDflt("ignorePreflightWarnings")
));

out.push(line(
    "Show All vSAN Groups",
    String(v("showAllVsanHealthGroups") === true),
    isDflt("showAllVsanHealthGroups")
));

var mpc = v("maxParallelClusters");
out.push(line(
    "Max Parallel Clusters",
    mpc != null ? String(mpc) : "(unset)",
    isDflt("maxParallelClusters")
));

out.push(line(
    "Debug Logging",
    String(v("debugLogging") === true),
    isDflt("debugLogging")
));

var rtl = v("recentTaskLookbackMinutes");
out.push(line(
    "Recent Task Lookback",
    rtl != null ? String(rtl) : "(unset)",
    isDflt("recentTaskLookbackMinutes")
));

out.push("");
out.push(SEPARATOR_THICK);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", "OK",
    "Built review summary | vcenter=" + vcenterName +
    " | clusters=" + (clusters != null ? clusters.length : 0) +
    " | depot=" + depotFilename
);

return out.join("\n");
