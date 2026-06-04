/**
 * Workflow: Customize Guest OS (parent)
 * Module:   com.broadcom.pso.vcfa.vm  (parent)
 *
 * Inputs:   inputProperties {Properties} - VCFA compute.provision.post payload
 * Outputs:  executionResult {string}, executionSummary {string}
 *
 * CANVAS FLOW:
 *   Start -> Set Log Marker (item5) -> Get Properties from VM Request (item1)
 *         -> Get VM for ID (item4) -> Initialize Guest Ops Check Counter (item9)
 *         -> [D] Guest Ops Check Threshold Exceeded (item13)
 *               true  -> Log Readiness Error (item14) -> End (item15)
 *               false -> Get processes from guest (item21)
 *         -> [D] VM Ready for Guest Operations? (item11)
 *               false -> Sleep (item16) -> Increase counter (item17) -> item13
 *               true  -> Set CD-ROM Drive Letter to Y (item23)   *** NEW ***
 *         -> Rename Local Admin Account (item2)
 *         -> Change Local Admin Password (item20)
 *         -> [D] Additional Disks? (item24)                       *** NEW ***
 *               true  -> Mount Drives in Windows Guest (item22) -> End (item0)
 *               false -> End (item0)
 */


/* ============================================================================
 * ST1 — Set Log Marker   (Scriptable Task)
 * ==========================================================================*/
System.setLogMarker("Workflow Name:" + workflow.name + "-Workflow Run ID:" + workflow.id);
System.log("Begin Workflow Execution");


/* ============================================================================
 * ST2 — Get Properties from VM Request   (Scriptable Task)
 * IN:  inputProperties
 * OUT: guestPassword, guestUsername, newAdminName, osType, vmExtId,
 *      newAdminPassword, hasDisks, diskCount, attachedDisks
 * ==========================================================================*/
osType  = inputProperties.customProperties.osType;
vmExtId = inputProperties.externalIds[0];

if (osType.toLowerCase() == 'windows') {
    var adminActConfigElementName = inputProperties.customProperties.adminActConfigElemName;

    // Get the values needed to update the default admin account within the Windows guest OS
    var configElems = Server.findAllForType("ConfigurationElement");
    var adminActConfigElement = null;
    for (var i = 0; i < configElems.length; i++) {
        if (configElems[i].name == adminActConfigElementName) {
            adminActConfigElement = configElems[i];
            break;
        }
    }

    guestPassword    = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminPwAttr).value;
    guestUsername    = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminAttr).value;
    newAdminName     = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminNewNameAttr).value;
    newAdminPassword = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminNewPwAttr).value;
}

var rawDisks = null;
try {
    rawDisks = inputProperties.customProperties.dataDisks;
} catch (err) {
    System.warn("No additional disks for VM '" + inputProperties.resourceNames[0] + "'");
}

if (rawDisks) {
    // Peel to the actual array (handles single- or double-encoded JSON)
    var parsedDisks = JSON.parse(rawDisks);
    if (typeof parsedDisks === "string") { parsedDisks = JSON.parse(parsedDisks); }

    diskCount     = parsedDisks.length;
    hasDisks      = diskCount > 0;
    attachedDisks = JSON.stringify(parsedDisks);   // single-encoded for child/action
} else {
    diskCount     = 0;
    hasDisks      = false;
    attachedDisks = "[]";
}

System.log("Starting guest customization of VM: " + inputProperties.resourceNames[0] +
           ", OS=" + osType.toLowerCase() + ", AdditionalDisks=" + diskCount);


/* ============================================================================
 * ST3 — Get VM for ID   (Scriptable Task)
 * IN:  vmExtId
 * OUT: vm, summary, vcenter
 * ==========================================================================*/
var allVMs = Server.findAllForType("VC:Virtualmachine");
for (var i = 0; i < allVMs.length; i++) {
    if (allVMs[i].instanceId == vmExtId) {
        vm = allVMs[i];
        break;
    }
}
vcenter = vm.sdkConnection;


/* ============================================================================
 * ST4 — Initialize Guest Ops Check Counter   (Scriptable Task)
 * OUT: guestOpsCheckCounter
 * ==========================================================================*/
guestOpsCheckCounter = 0;


/* ============================================================================
 * DE1 — [Decision] Guest Ops Check Threshold Exceeded
 * IN:  guestOpsCheckCounter, guestOpsCheckThreshold
 *   true  (counter > threshold) -> item14 (Log Readiness Error)
 *   false                        -> item21 (Get processes from guest)
 * ==========================================================================*/
// if (guestOpsCheckCounter > guestOpsCheckThreshold) return true; else return false;


/* ============================================================================
 * ST5 — Log Guest Customization Readiness error   (Scriptable Task)  -> item15 (End)
 * ==========================================================================*/
System.error("Unable to perform guest customizations on VM: " + vm.name +
    ".  VM failed to enter 'guest customization ready' state.  Please check VMware tools running status");


/* ============================================================================
 * WF1 — Get processes from guest   (Library Workflow link)
 * IN:  vmUsername<-guestUsername, vmPassword<-guestPassword, vm<-vm
 * OUT: result -> vmProcessList
 * ==========================================================================*/


/* ============================================================================
 * DE2 — [Decision] VM Ready for Guest Operations?
 * IN:  vmProcessList
 *   true  (vmProcessList.length > 0) -> item23 (Set CD-ROM Drive Letter to Y)   *** rewired ***
 *   false                            -> item16 (Sleep)
 * ==========================================================================*/
// if (vmProcessList.length > 0) return true; else return false;


/* ============================================================================
 * S1 — Sleep   (Library) -> item17
 * IN: sleepTime <- guestCustCheckSleepSeconds
 * ============================================================================
 * item17 — Increase counter   (Library) -> item13
 * IN/OUT: counter <- guestOpsCheckCounter
 * ==========================================================================*/


/* ============================================================================
 * WF1 — Set CD-ROM Drive Letter to Y   (Workflow link)   *** NEW ***
 * linked-workflow-id: workflow_SetCdromDriveLetter_Windows
 * IN:  vm            <- vm
 *      guestUsername <- guestUsername     (ORIGINAL bootstrap account; pre-rename)
 *      guestPassword <- guestPassword     (ORIGINAL bootstrap password)
 * OUT: executionResult -> executionResult
 * ==========================================================================*/


/* ============================================================================
 * WF2 — Rename Local Admin Account   (Workflow link)
 * IN:  newAdminName<-newAdminName, vm<-vm, osType<-osType,
 *      guestUsername<-guestUsername, guestPassword<-guestPassword, vcenter<-vcenter
 * OUT: executionResult -> executionResult
 * ==========================================================================*/


/* ============================================================================
 * WF3 — Change Local Admin Password   (Workflow link)
 * IN:  vm<-vm, osType<-osType, guestUsername<-newAdminName (post-rename),
 *      guestPassword<-guestPassword (still original pw), newPassword<-newAdminPassword,
 *      vcenter<-vcenter
 * OUT: executionResult -> executionResult                         *** rewired ***
 * ==========================================================================*/


/* ============================================================================
 * DE3 — [Decision] Additional Disks?                     *** NEW ***
 * IN:  hasDisks
 *   true  -> item22 (Mount Drives in Windows Guest)
 *   false -> item0  (End)
 * ==========================================================================*/
// if (hasDisks == true) return true; else return false;


/* ============================================================================
 * WF4 — Mount Drives in Windows Guest   (Workflow link)
 * IN:  vm<-vm, guestUsername<-newAdminName (post-rename),
 *      guestPassword<-newAdminPassword (post-rotation), additionalDisks<-attachedDisks
 * OUT: executionSummary -> executionSummary
 * NEXT: item0 (End)
 * ==========================================================================*/