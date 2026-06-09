/**
 * ============================================================================
 *  WORKFLOW: Attach ISO to VM
 *  PATH:     Library / Production / VCF Automation / VM Deployments
 *  DISPLAY:  Attach ISO to Linux VM
 * ----------------------------------------------------------------------------
 *  PURPOSE
 *    Compute Post Provision (compute.provision.post) extensibility action for
 *    the Linux shell-VM use case. Resolves the VM from the VCFA request payload,
 *    reads the user-selected ISO full path, finds the VM's existing CD/DVD
 *    device (template ships with one, backed by Client Device), and edits that
 *    device to an ISO datastore backing — connected at power-on. Single
 *    reconfigVM_Task, waited to completion.
 *
 *  PROVISIONING MODEL
 *    Same as the Windows parent: a compute.provision.post subscription invokes
 *    this workflow with a single inputProperties {Properties} payload. The ISO
 *    path arrives as a custom property set from the blueprint input (isoPath).
 *
 *  FAILURE SEMANTICS
 *    On failure VCFA destroys the VM and marks the deployment Failed. There is
 *    no partially-configured VM to re-run against, so no re-run idempotency is
 *    attempted here (consistent with the Windows chain decision).
 *
 *  CANVAS (1:1 with elements; IN/OUT/NEXT annotated)
 *    item1 Get Properties from VM Request
 *      -> item2 Get VM for ID
 *      -> item3 Resolve & Validate ISO Path
 *      -> item4 Attach ISO (reconfigVM)
 *      -> item0 End
 *    Error handler: item5 Log error -> item6 End
 *
 *  API VALIDATION (vroapi.com / Broadcom TechDocs)
 *    - VcVirtualMachine.config.hardware.device[]  -> VcVirtualDevice[]
 *    - VcVirtualCdrom (instanceof check to find the CD/DVD device)
 *    - VcVirtualCdromIsoBackingInfo { fileName }
 *    - VcVirtualDeviceConnectInfo { connected, startConnected, allowGuestControl }
 *    - VcVirtualDeviceConfigSpec { operation = edit|add, device }
 *    - VcVirtualMachineConfigSpec { deviceChange = [ VcVirtualDeviceConfigSpec ] }
 *    - VcVirtualMachine.reconfigVM_Task(spec) -> VcTask
 *    - createRequest body-as-3rd-arg / setContent rules are REST-only; N/A here.
 * ============================================================================
 */
 
/* ============================================================================
 *  item1  —  Get Properties from VM Request
 *  IN  : inputProperties : Properties     // VCFA compute.provision.post payload
 *  OUT : vmId            : string         // resource external id (MoRef value)
 *        isoPath         : string         // full datastore path of the ISO
 *  NEXT: item2
 * ----------------------------------------------------------------------------
 *  The VCFA payload nests the machine custom properties under customProperties.
 *  isoPath is the blueprint input bound to the getIsoList dropdown; its value
 *  is a full datastore path "[ds] folder/file.iso".
 * ============================================================================ */
// --- item1 body ---
var props = inputProperties;
if (props === null || props === undefined) {
    throw "Attach ISO: inputProperties payload is null.";
}
 
// VM identity: VCFA exposes the managed-object id of the provisioned VM.
// 'resourceId' / 'externalId' carry the vCenter MoRef value depending on phase;
// prefer externalId, fall back to resourceId.
var vmId = props.get("externalId");
if (vmId === null || vmId === undefined || ("" + vmId).length === 0) {
    vmId = props.get("resourceId");
}
if (vmId === null || vmId === undefined || ("" + vmId).length === 0) {
    throw "Attach ISO: could not determine VM id from inputProperties "
        + "(externalId/resourceId both empty).";
}
 
// ISO path: custom properties arrive under 'customProperties'. Guard for the
// double-encoding pattern seen elsewhere in this solution (string-of-a-string).
var customProperties = props.get("customProperties");
var isoPath = null;
if (customProperties !== null && customProperties !== undefined) {
    // customProperties may be a Properties object or a JSON string.
    if (typeof customProperties === "string") {
        var cpParsed = JSON.parse(customProperties);
        if (typeof cpParsed === "string") {
            cpParsed = JSON.parse(cpParsed); // double-encoded guard
        }
        isoPath = cpParsed.isoPath;
    } else {
        isoPath = customProperties.get
            ? customProperties.get("isoPath")
            : customProperties.isoPath;
    }
}
// Fallback: some bindings surface the input at the top level.
if (isoPath === null || isoPath === undefined) {
    isoPath = props.get("isoPath");
}
 
System.log("Attach ISO: vmId=" + vmId);
System.log("Attach ISO: isoPath=" + isoPath);
 
 
/* ============================================================================
 *  item2  —  Get VM for ID
 *  IN  : vmId   : string
 *  OUT : vm     : VcVirtualMachine
 *  NEXT: item3
 * ----------------------------------------------------------------------------
 *  Resolve the VcVirtualMachine across the connected vCenter(s). Reuses the
 *  same lookup strategy as the Windows parent's "Get VM for ID".
 * ============================================================================ */
// --- item2 body ---
var vm = null;
var sdkConnections = VcPlugin.allSdkConnections;
var s, vms, i;
for (s = 0; s < sdkConnections.length && vm === null; s++) {
    try {
        vms = VcPlugin.getAllVirtualMachines(null, "xpath:matches(id,'" + vmId + "')");
        if (vms !== null && vms.length > 0) {
            for (i = 0; i < vms.length; i++) {
                if (vms[i].reference.value === vmId || vms[i].id === vmId) {
                    vm = vms[i];
                    break;
                }
            }
            if (vm === null && vms.length === 1) {
                vm = vms[0];
            }
        }
    } catch (e) {
        System.warn("Attach ISO: VM lookup attempt failed: " + e);
    }
}
if (vm === null) {
    throw "Attach ISO: could not resolve VcVirtualMachine for id '" + vmId + "'.";
}
System.log("Attach ISO: resolved VM '" + vm.name + "'.");
 
 
/* ============================================================================
 *  item3  —  Resolve & Validate ISO Path
 *  IN  : isoPath : string
 *  OUT : isoPath : string   // validated/normalized
 *  NEXT: item4
 * ----------------------------------------------------------------------------
 *  No-op attach is invalid: a Linux shell VM with no ISO has nothing to boot.
 *  Validate shape "[datastore] path/file.iso". We do NOT re-search datastores
 *  here — the form already produced a real path via getIsoList.
 * ============================================================================ */
// --- item3 body ---
if (isoPath === null || isoPath === undefined || ("" + isoPath).length === 0) {
    throw "Attach ISO: no ISO path supplied (isoPath empty). A Linux shell VM "
        + "requires an ISO to boot.";
}
isoPath = ("" + isoPath).replace(/^\s+|\s+$/g, "");
if (!/^\[[^\]]+\]\s*.+\.iso$/i.test(isoPath)) {
    throw "Attach ISO: isoPath '" + isoPath + "' is not a valid datastore ISO "
        + "path of the form '[datastore] folder/file.iso'.";
}
System.log("Attach ISO: validated isoPath '" + isoPath + "'.");
 
 
/* ============================================================================
 *  item4  —  Attach ISO (reconfigVM)
 *  IN  : vm      : VcVirtualMachine
 *        isoPath : string
 *  OUT : (none)
 *  NEXT: item0
 * ----------------------------------------------------------------------------
 *  Find the existing CD/DVD device and EDIT it to an ISO backing. ADD a device
 *  only if the template unexpectedly has none. Connected at power-on.
 * ============================================================================ */
// --- item4 body ---
var devices = vm.config.hardware.device;   // VcVirtualDevice[]
var cdrom = null;
var k;
for (k = 0; k < devices.length; k++) {
    if (devices[k] instanceof VcVirtualCdrom) {
        cdrom = devices[k];
        break;                             // edit the first CD/DVD device
    }
}
 
// Build the ISO backing.
var isoBacking = new VcVirtualCdromIsoBackingInfo();
isoBacking.fileName = isoPath;
 
// Connect-at-power-on state.
var connectInfo = new VcVirtualDeviceConnectInfo();
connectInfo.connected = true;          // attached now (VM is powered off pre-boot)
connectInfo.startConnected = true;     // connected at power-on (boot from ISO)
connectInfo.allowGuestControl = true;
 
var deviceConfigSpec = new VcVirtualDeviceConfigSpec();
 
if (cdrom !== null) {
    // EDIT path: reuse the existing device's key/controllerKey/unitNumber.
    cdrom.backing = isoBacking;
    cdrom.connectable = connectInfo;
    deviceConfigSpec.operation = VcVirtualDeviceConfigSpecOperation.edit;
    deviceConfigSpec.device = cdrom;
    System.log("Attach ISO: editing existing CD/DVD device (key=" + cdrom.key + ").");
} else {
    // ADD path (defensive; template should already have a CD/DVD device).
    // Attach to an existing IDE controller; find one on the VM.
    var ideKey = null;
    for (k = 0; k < devices.length; k++) {
        if (devices[k] instanceof VcVirtualIDEController) {
            ideKey = devices[k].key;
            break;
        }
    }
    if (ideKey === null) {
        throw "Attach ISO: no existing CD/DVD device and no IDE controller "
            + "found to attach a new one. Template is missing expected hardware.";
    }
    var newCd = new VcVirtualCdrom();
    newCd.key = -1;                    // negative key = let vCenter assign
    newCd.controllerKey = ideKey;
    newCd.backing = isoBacking;
    newCd.connectable = connectInfo;
    deviceConfigSpec.operation = VcVirtualDeviceConfigSpecOperation.add;
    deviceConfigSpec.device = newCd;
    System.warn("Attach ISO: no CD/DVD device present; adding one on IDE key "
        + ideKey + ".");
}
 
var configSpec = new VcVirtualMachineConfigSpec();
configSpec.deviceChange = [ deviceConfigSpec ];
 
var task = vm.reconfigVM_Task(configSpec);
var basic = System.getModule("com.vmware.library.vc.basic");
basic.vim3WaitTaskEnd(task, true, 2);   // throws on task failure
 
System.log("Attach ISO: '" + isoPath + "' attached to '" + vm.name
    + "' (connected at power-on).");
 
 
/* ============================================================================
 *  item0  —  End (success)
 * ============================================================================ */
// (no body)
 
 
/* ============================================================================
 *  item5  —  Log error (error handler)
 *  IN  : errorCode : string
 *  NEXT: item6
 * ============================================================================ */
// --- item5 body ---
// System.error("Attach ISO failed: " + errorCode);
 
/* ============================================================================
 *  item6  —  End (error)
 * ============================================================================ */
// (no body)
 
