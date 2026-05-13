// ===================================================================
// ACTION:    getRegisteredVcenters
// MODULE:    com.broadcom.pso.vc.esxi.remediation.form
// PURPOSE:   List all VC:SdkConnection inventory items in vRO,
//            formatted as label/value pairs for use as the source
//            of the form's vCenter picker (Section 2 of the
//            request form).
//
// PHASE:     form-time
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-FORM]
//
// INPUTS: (none)
//
// RETURNS: Array/Properties — One entry per registered vCenter:
//                              { label: "<displayName>",
//                                value: <VC:SdkConnection> }
//                              Sorted alphabetically by label.
//
// REQUIREMENT TRACE:
//   Implements: FR-7 (Section 2 vCenter picker), C-13 (reuse
//               inventory connections).
//
// NOTES:
//   - VCF Automation custom forms with Multi-Value Picker can use
//     the result of an Orchestrator action whose return type is
//     Array/Properties with 'label' and 'value' keys per entry
//     (verified, Section 3h.1).
//   - The 'value' is the VC:SdkConnection plugin object itself —
//     the form binds this directly to the workflow input of type
//     VC:SdkConnection. No FQDN string conversion needed.
//   - Action filters out any VC:SdkConnection that is not in a
//     healthy state (e.g. credential expired, not reachable).
//     Healthy = sdkConnection.about != null AND we can read
//     about.fullName without exception.
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-FORM]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

// -------------------------------------------------------------------
// Find all VC:SdkConnection inventory entries. The vRO server
// findAllForType API returns all instances of the given plugin type.
// -------------------------------------------------------------------

var allVcConnections = Server.findAllForType("VC:SdkConnection");
if (allVcConnections == null) {
    allVcConnections = [];
}

var entries = [];

for (var i = 0; i < allVcConnections.length; i++) {
    var conn = allVcConnections[i];
    if (conn == null) continue;

    var name = "(unknown)";
    var healthy = false;

    try {
        // Connection name is the inventory display name. Typically
        // the FQDN of the vCenter.
        name = String(conn.name);

        // Health check: read about info; throws if connection is
        // unhealthy.
        if (conn.about != null && conn.about.fullName != null) {
            healthy = true;
        }
    } catch (e) {
        healthy = false;
    }

    if (!healthy) {
        // Skip unhealthy connections. Log the skip for diagnostics.
        auditLogger.auditLog(
            LOG_PREFIX, "DISCOVER", "SKIP",
            "Skipped unhealthy VC connection | name=" + name
        );
        continue;
    }

    var entry = new Properties();
    entry.put("label", name);
    entry.put("value", conn);
    entries.push(entry);
}

// -------------------------------------------------------------------
// Sort alphabetically by label so the picker is predictable.
// -------------------------------------------------------------------

entries.sort(function(a, b) {
    var la = String(a.get("label")).toLowerCase();
    var lb = String(b.get("label")).toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
});

auditLogger.auditLog(
    LOG_PREFIX, "DISCOVER", "OK",
    "Listed registered vCenters | count=" + entries.length
);

return entries;
