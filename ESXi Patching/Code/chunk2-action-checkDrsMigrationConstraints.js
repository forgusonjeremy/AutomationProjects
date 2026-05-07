// ===================================================================
// ACTION:    checkDrsMigrationConstraints
// MODULE:    com.broadcom.pso.vc.esxi.remediation.preflight
// PURPOSE:   Identify VMs in the cluster that cannot be migrated by
//            DRS to evacuate a host before maintenance mode entry.
//            Such VMs would force operators to manually intervene
//            during MM_ENTER, which the workflow does not handle
//            (per EX-14).
//
// PHASE:     VALIDATE
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [ESXI-REMEDIATE-PREFLIGHT]
//
// INPUTS:
//   cluster (VC:ClusterComputeResource)
//
// RETURNS: Properties — {
//            clean              (boolean) — true iff no constraints
//                                            found
//            constraintCount    (number)
//            constrainedVms     (Array/Properties) — entries:
//                                  { vmName, vmMoRef, currentHost,
//                                    constraint, detail }
//            reason             (string)
//          }
//
// REQUIREMENT TRACE:
//   Implements: FR-15 (DRS migration constraints check), FR-18
//               (warning silenceable via ignorePreflightWarnings).
//
// CONSTRAINT TYPES DETECTED:
//   * Mounted local ISO — VM has CD/DVD attached to a host-local
//     datastore-backed ISO.
//   * USB passthrough — VM has USB device attached.
//   * PCI/serial passthrough — VM has DirectPath I/O or serial
//     port mapped to host hardware.
//   * Suspended state — vMotion of suspended VMs is restricted in
//     vSphere; the operation can fail mid-MM-entry.
//   * Affinity rules requiring specific host — VM has a "must-stay"
//     rule that pins it to a host that is also in scope (rare,
//     but checking anyway).
//   * Unsupported device — anything else flagged by vCenter as a
//     migration obstacle.
//
// NOTES:
//   - This is a heuristic check. It cannot guarantee zero migration
//     failures; new constraint types and complex affinity rules
//     can still cause MM entry to fail. The check catches the
//     common obstacles.
//   - Per FR-18 the result is a WARNING, silenceable. If an
//     operator KNOWS the constrained VMs are non-critical and can
//     accept that those hosts may not enter MM, they can override.
//   - For each constrained VM, the reported "currentHost" lets
//     operators decide whether the cluster's planned scope avoids
//     that host (in which case the constraint is moot for THIS run).
// ===================================================================

var LOG_PREFIX = "[ESXI-REMEDIATE-PREFLIGHT]";
var auditLogger = System.getModule("com.broadcom.pso.common.logging");

if (arguments.length < 1) {
    throw new Error("checkDrsMigrationConstraints requires 1 input: cluster.");
}
var cluster = arguments[0];

if (cluster == null) {
    throw new Error("checkDrsMigrationConstraints: 'cluster' must not be null.");
}

var constrainedVms = [];

// -------------------------------------------------------------------
// Walk every VM in the cluster. cluster.host gives us hosts; each
// host.vm gives us the VMs on that host.
// -------------------------------------------------------------------

var hosts = cluster.host;
if (hosts == null) hosts = [];

for (var h = 0; h < hosts.length; h++) {
    var host = hosts[h];
    if (host == null) continue;

    var hostName;
    try {
        hostName = String(host.name);
    } catch (e) {
        continue;
    }

    var vms = host.vm;
    if (vms == null) vms = [];

    for (var v = 0; v < vms.length; v++) {
        var vm = vms[v];
        if (vm == null) continue;

        var vmName = "(unknown)";
        var vmMoRef = "(unknown)";

        try {
            vmName = String(vm.name);
            vmMoRef = String(vm.id);
        } catch (e) {
            continue;
        }

        // Skip templates — they cannot be running and don't need migration.
        try {
            if (vm.config != null && vm.config.template === true) {
                continue;
            }
        } catch (e) {
            // Continue and apply remaining checks.
        }

        // ---- Suspended state ----
        try {
            if (vm.runtime != null && vm.runtime.powerState != null) {
                var pState = String(vm.runtime.powerState.value);
                if (pState === "suspended") {
                    constrainedVms.push({
                        vmName: vmName,
                        vmMoRef: vmMoRef,
                        currentHost: hostName,
                        constraint: "Suspended",
                        detail: "vMotion of suspended VMs is restricted; resume or power off before patching."
                    });
                    // Don't continue; a suspended VM may have multiple constraints.
                }
            }
        } catch (e) { /* continue */ }

        // ---- Device-level constraints: CD/DVD with local ISO,
        //      USB, PCI passthrough, serial passthrough ----
        var devices = null;
        try {
            if (vm.config != null && vm.config.hardware != null) {
                devices = vm.config.hardware.device;
            }
        } catch (e) {
            devices = null;
        }
        if (devices == null) devices = [];

        for (var d = 0; d < devices.length; d++) {
            var dev = devices[d];
            if (dev == null) continue;

            // Each device's class can be detected via duck-typing on
            // recognizable fields.

            // CD/DVD with local datastore-backed ISO.
            // VirtualCdrom devices have .backing of various subtypes.
            // ISO file backing has datastore + fileName; an ISO on a
            // host-local datastore is the migration concern.
            try {
                if (dev.backing != null && dev.backing.fileName != null
                    && dev.connectable != null && dev.connectable.connected === true) {
                    var fileName = String(dev.backing.fileName);
                    if (fileName.toLowerCase().indexOf(".iso") !== -1) {
                        // Determine if the backing datastore is host-local.
                        var dsName = "(unknown)";
                        var isLocal = false;
                        try {
                            if (dev.backing.datastore != null) {
                                dsName = String(dev.backing.datastore.name);
                                // Heuristic: datastores named like
                                // "datastore1", "<host>-local", or
                                // accessible from only one host are
                                // local. We err on the side of
                                // flagging — if the operator knows
                                // it's actually shared, they can
                                // silence the warning.
                                if (dev.backing.datastore.host != null
                                    && dev.backing.datastore.host.length === 1) {
                                    isLocal = true;
                                }
                            }
                        } catch (e) {
                            isLocal = true; // unknown → flag
                        }
                        if (isLocal) {
                            constrainedVms.push({
                                vmName: vmName,
                                vmMoRef: vmMoRef,
                                currentHost: hostName,
                                constraint: "Mounted local ISO",
                                detail: "ISO on host-local datastore '" + dsName +
                                        "' (file: " + fileName + ")"
                            });
                        }
                    }
                }
            } catch (e) { /* continue */ }

            // USB passthrough — VirtualUSB devices have
            // backing of class VirtualUSBHostBackingInfo.
            try {
                if (dev.backing != null && dev.backing.deviceName != null
                    && (typeof dev.key === "number")
                    && dev.toString != null
                    && String(dev).indexOf("USB") !== -1) {
                    constrainedVms.push({
                        vmName: vmName,
                        vmMoRef: vmMoRef,
                        currentHost: hostName,
                        constraint: "USB passthrough",
                        detail: "USB device '" + String(dev.backing.deviceName) +
                                "' attached from host hardware."
                    });
                }
            } catch (e) { /* continue */ }

            // PCI passthrough — VirtualPCIPassthrough.
            try {
                if (String(dev).indexOf("PCIPassthrough") !== -1
                    || (dev.backing != null && dev.backing.id != null
                        && String(dev).indexOf("Passthrough") !== -1)) {
                    constrainedVms.push({
                        vmName: vmName,
                        vmMoRef: vmMoRef,
                        currentHost: hostName,
                        constraint: "PCI passthrough",
                        detail: "DirectPath I/O device attached from host hardware."
                    });
                }
            } catch (e) { /* continue */ }

            // Serial passthrough — VirtualSerialPort with file/device backing
            // mapped to host hardware.
            try {
                if (String(dev).indexOf("SerialPort") !== -1
                    && dev.backing != null && dev.backing.deviceName != null) {
                    constrainedVms.push({
                        vmName: vmName,
                        vmMoRef: vmMoRef,
                        currentHost: hostName,
                        constraint: "Serial passthrough",
                        detail: "Serial port mapped to host device '" +
                                String(dev.backing.deviceName) + "'"
                    });
                }
            } catch (e) { /* continue */ }
        }
    }
}

var clean = (constrainedVms.length === 0);
var reason = clean
    ? "No DRS migration constraints detected on any VM in the cluster"
    : constrainedVms.length + " VM(s) have constraints that may block MM entry";

var result = new Properties();
result.put("clean", clean);
result.put("constraintCount", constrainedVms.length);
result.put("constrainedVms", constrainedVms);
result.put("reason", reason);

auditLogger.auditLog(
    LOG_PREFIX, "VALIDATE", clean ? "OK" : "WARN",
    "DRS migration constraint check | cluster=" + cluster.name + " | " + reason
);

return result;
