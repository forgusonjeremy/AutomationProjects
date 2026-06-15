/* ============================================================================
 * Workflow: Customize Windows VM Guest   (parent)
 * Module:   com.broadcom.pso.vcfa.vm
 * WF ID:    7f97799b-9aff-49a5-9cd1-3a75ec6a6c89
 *
 * Inputs:   inputProperties {Properties} - VCFA compute.provision.post payload
 * Outputs:  (none declared on the workflow)
 *
 * Error handler: item20 (User interaction -> item19 End)
 *
 * CANVAS FLOW (root = item1):
 *   item1 (Set Log Marker)
 *     -> item2 (Get Properties from VM Request)
 *     -> item3 (Get VM for ID)
 *     -> item4 (Initialize Guest Ops Check Counter)
 *     -> item6 [Decision: Guest Ops Check Threshold Exceeded?]
 *           true  -> item7 (Log Readiness error) -> item0 (End)
 *           false -> item8 (Get processes from guest  [LIBRARY link])
 *     -> item10 [Decision: VM Ready for Guest Ops?]
 *           true  -> item13 (Configure CD Drive Letter)
 *           false -> item12 (Sleep) -> item11 (Increase counter) -> item6
 *     -> item13 (Configure CD Drive Letter  [link])
 *     -> item14 (Rename Windows Local Admin  [link])
 *     -> item15 (Change Local Account Password  [link])
 *     -> item17 [Decision: Has Data Disks?]
 *           true  -> item18 (Format Disks (Windows) [link]) -> item5 (End)
 *           false -> item16 (End)
 *
 * ATTRIBUTES:
 *   guestPassword          {SecureString}
 *   guestUsername          {string}
 *   newAdminName           {string}
 *   vmExtId                {string}
 *   newAdminPassword       {SecureString}
 *   hasDisks               {boolean} = false
 *   diskCount              {number}
 *   attachedDisks          {string}
 *   vm                     {VC:VirtualMachine}
 *   vcenter                {VC:SdkConnection}
 *   guestOpsCheckCounter   {number}
 *   guestOpsCheckThreshold {number} = 10
 *   vmProcessList          {Array/CompositeType...:GuestProcessInfoType} = []
 *   guestOpsCheckSleep     {number} = 60
 *   cdDriveLetter          {string} = "Y"
 *   executionResult        {string}
 * ==========================================================================*/


/* ============================================================================
 * item1 — Set Log Marker   (Scriptable Task   [ROOT])
 * NEXT: item2
 * ==========================================================================*/
System.setLogMarker("Workflow Name:" + workflow.name + "-Workflow Run ID:" + workflow.id);
System.log("Begin Workflow Execution");


/* ============================================================================
 * item2 — Get Properties from VM Request   (Scriptable Task)
 * IN:  inputProperties
 * OUT: guestPassword, guestUsername, newAdminName, vmExtId, newAdminPassword, hasDisks, diskCount, attachedDisks
 * NEXT: item3
 * ==========================================================================*/
vmExtId = inputProperties.externalIds[0];

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
System.log("config element: " + adminActConfigElement)

guestPassword    = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminPwAttr).value;
guestUsername    = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminAttr).value;
newAdminName     = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminNewNameAttr).value;
newAdminPassword = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminNewPwAttr).value;

System.log("current admin user: " + guestUsername)
System.log("current password: " + guestPassword)

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

System.log("Starting guest customization of VM: " + inputProperties.resourceNames[0] + ", AdditionalDisks=" + diskCount);


/* ============================================================================
 * item3 — Get VM for ID   (Scriptable Task)
 * IN:  vmExtId
 * OUT: vm, vcenter
 * NEXT: item4
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
 * item4 — Initialize Guest Ops Check Counter   (Scriptable Task)
 * OUT: guestOpsCheckCounter
 * NEXT: item6
 * ==========================================================================*/
guestOpsCheckCounter = 0;


/* ============================================================================
 * item6 — Guest Ops Check Threshold Exceeded?   (Decision / custom-condition)
 * IN:  guestOpsCheckCounter, guestOpsCheckThreshold
 *   true  -> item7
 *   false -> item18
 * ==========================================================================*/
if (guestOpsCheckCounter > guestOpsCheckThreshold) {
    return true;
}
else {
    return false;
}


/* ============================================================================
 * item7 — Log Guest Customization Readiness error   (Scriptable Task)
 * IN:  vm
 * NEXT: item0
 * ==========================================================================*/
System.error("Unable to perform guest customizations on VM: " + vm.name +
    ".  VM failed to enter 'guest customization ready' state.  Please check VMware tools running status");


/* ============================================================================
 * item18 — Format Disks (Windows)   (Workflow link)
 * IN:  vm, guestUsername <- newAdminName, guestPassword <- newAdminPassword, additionalDisks <- attachedDisks
 * OUT: executionSummary -> executionResult
 * NEXT: item5
 * linked-workflow-id: 2114fa72-0162-4928-8016-3ab0002472b6
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item8 — Get processes from guest   (Workflow link)
 * IN:  vmUsername <- guestUsername, vmPassword <- guestPassword, vm
 * OUT: result -> vmProcessList
 * NEXT: item10
 * linked-workflow-id: C98080808080808080808080808080800180808001322751030482b80adf61e7c
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item10 — VM Ready for Guest Ops?   (Decision / custom-condition)
 * IN:  vmProcessList
 *   true  -> item13
 *   false -> item12
 * ==========================================================================*/
if (vmProcessList.length > 0){
    return true;
}
else {
    return false;
} 


/* ============================================================================
 * item11 — Increase counter   (Scriptable Task)
 * IN:  counter <- guestOpsCheckCounter
 * OUT: counter -> guestOpsCheckCounter
 * NEXT: item6
 * ==========================================================================*/
//Auto-generated script
counter = counter + 1;


/* ============================================================================
 * item12 — Sleep   (Scriptable Task)
 * IN:  sleepTime <- guestOpsCheckSleep
 * NEXT: item11
 * ==========================================================================*/
//Auto-generated script
if ( sleepTime !== null )  {
	System.sleep(sleepTime * 1000);
}else  {
	throw "'sleepTime' is NULL"; 
}


/* ============================================================================
 * item13 — Configure CD Drive Letter   (Workflow link)
 * IN:  vm, guestUsername, guestPassword, cdDriveLetter
 * OUT: executionResult
 * NEXT: item14
 * linked-workflow-id: 36328d1b-186d-460c-ad00-d667323d3384
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item14 — Rename Windows Local Admin   (Workflow link)
 * IN:  vm, guestUsername, guestPassword, newAdminName
 * OUT: executionResult
 * NEXT: item15
 * linked-workflow-id: f0be1eb7-54c3-4be7-a41d-05de7854671d
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item15 — Change Local Account Password   (Workflow link)
 * IN:  vm, guestUsername <- newAdminName, guestPassword, newPassword <- newAdminPassword
 * OUT: executionResult
 * NEXT: item17
 * linked-workflow-id: c20a1766-1780-4fe2-a4e6-d553fc4bd1b4
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item17 — Has Data Disks?   (Decision / custom-condition)
 * IN:  hasDisks
 *   true  -> item18
 *   false -> item16
 * ==========================================================================*/
return hasDisks;


/* ============================================================================
 * item20 — User interaction   (User Interaction)
 * IN:  security.group, security.assignees, security.assignee.groups, timeout.date
 * NEXT: item19
 * ==========================================================================*/

