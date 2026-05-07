// ===================================================================
// ACTION:    getClusterCustomAttributes
// MODULE:    com.broadcom.pso.vc.esxi.remediation.detect
// PURPOSE:   Read all custom attributes (vSphere Custom Fields) set
//            on a cluster and return them as a Properties bag of
//            key→value pairs. Used by identifyClusterType to
//            positively classify VxRail clusters via the
//            "VxRail-IP" custom attribute and other potential
//            classifiers, and used for diagnostic logging when
//            cluster classification is ambiguous.
//
// PHASE:     DISCOVER
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-DETECT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource) — A vCenter cluster object
//                                          from the vCenter plugin
//                                          inventory.
//
// RETURNS: Properties — Key/value pairs where key is the custom
//                       field name (e.g. "VxRail-IP") and value is
//                       the string value set on the cluster. Custom
//                       fields with no value set on this cluster are
//                       omitted.
//
// REQUIREMENT TRACE:
//   Implements: support for FR-15 (cluster type detection) and
//               AD-06 (PowerFlex out of scope, requires positive
//               VxRail identification).
//
// NOTES:
//   - vSphere Custom Fields are defined globally per-vCenter
//     (CustomFieldDef objects) and assigned per-managed-entity as
//     CustomFieldValue objects. To map values back to names we
//     iterate cluster.availableField (the global definitions
//     visible to this cluster) and cluster.customValue (the values
//     set on this specific cluster), correlating by .key.
//   - Custom Fields can be edited through the vSphere client by
//     anyone with appropriate permission. The classification logic
//     in identifyClusterType DOES treat the VxRail-IP attribute as
//     authoritative — but this is acceptable because the alternative
//     (extension API enumeration) is more fragile across VxRail
//     versions. Operators with permission to fake VxRail-IP can
//     also break the cluster in many other ways.
//   - The action is read-only. It never modifies cluster state.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-DETECT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

// -------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------

if (arguments.length < 1) {
    throw new Error("getClusterCustomAttributes requires 1 input: cluster (VC:ClusterComputeResource).");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("getClusterCustomAttributes: 'cluster' must not be null.");
}

// -------------------------------------------------------------------
// Build the field-key → field-name lookup. cluster.availableField is
// an array of CustomFieldDef objects. Each has .key (numeric ID
// stable for the lifetime of the field) and .name (human-readable).
//
// Some custom fields are vCenter-wide; some are cluster-scoped.
// availableField contains all that apply to this entity.
// -------------------------------------------------------------------

var keyToName = {};
var availableField = cluster.availableField;

if (availableField != null) {
    for (var i = 0; i < availableField.length; i++) {
        var def = availableField[i];
        if (def != null && def.key != null && def.name != null) {
            keyToName[String(def.key)] = String(def.name);
        }
    }
}

// -------------------------------------------------------------------
// Walk the values set on this cluster. cluster.customValue is an
// array of CustomFieldValue objects, each with .key (matching the
// def.key) and .value (the string value).
// -------------------------------------------------------------------

var result = new Properties();
var customValues = cluster.customValue;

if (customValues != null) {
    for (var j = 0; j < customValues.length; j++) {
        var cv = customValues[j];
        if (cv == null || cv.key == null) {
            continue;
        }
        var fieldName = keyToName[String(cv.key)];
        if (fieldName == null) {
            // Defensive: a value without a corresponding def.
            // Use the numeric key as the name to avoid losing data,
            // but flag it so callers aware of this corner case can
            // handle it.
            fieldName = "_unknownField_" + String(cv.key);
        }
        // cv.value may be empty string — that's still a "set" value
        // in vSphere semantics; preserve it as-is.
        result.put(fieldName, cv.value != null ? String(cv.value) : "");
    }
}

auditLogger.auditLog(
    LOG_PREFIX, "DISCOVER", "OK",
    "Read cluster custom attributes | cluster=" + cluster.name +
    " | attributeCount=" + result.keys.length
);

return result;
