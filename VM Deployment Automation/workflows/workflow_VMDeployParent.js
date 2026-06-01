/**
 * Workflow: workflow_VMDeployParent
 * Module: com.vcf.guestcustomization
 *
 * Workflow Inputs:
 *   inputProperties {Properties} - VCFA Compute Post Provision extensibility payload
 *
 * Workflow Outputs:
 *   deploymentSummary {string}
 *
 * inputProperties keys used:
 *   resourceNames[0]                    - VM name
 *   customProperties.osType             - "windows" or "linux"
 *   customProperties.vcenterFqdn        - vCenter FQDN
 *   customProperties.guestUsername      - Pre-rename admin account name
 *   customProperties.guestPassword      - Pre-update password
 *   customProperties.newAdminName       - Target admin account name
 *   customProperties.newPassword        - New password
 *   customProperties.additionalDisks    - JSON array or empty string
 */

// =========================================================================
// [CANVAS ELEMENT 1 — Scriptable Task: validateAndParseInputs]
/*==========================================
Inputs: 
inputProperties {properties}

Outputs: 
disks               {string}
diskCounts          {number}
guestPassword       {SecureString}
guestUsername       {string}
hasDisks            {boolean}
newAdminName        {string}
newAdminPassword    {SecureString}
ostype          {string}
vmExtId         {string}
*/

osType = inputProperties.customProperties.osType
vmExtId = inputProperties.customProperties.externalIds[0]

if (osType.toLowerCase() == 'windows'){
    var adminActConfigElemeName = inputProperties.customProperties.adminActConfigElemName;

    //Get the values needed to update the default admin account within the Windows guest OS
    var configElems = Server.findAllForType("ConfigurationElement")

    for each (var configElem in configElems){
        if (configElem.name == adminActConfigElementName){
            adminActConfigElement = configElem;
            break;
        }
    }

    guestPassword = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminPwAttr).value;
    guestUsername = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminAttr).value;
    newAdminName = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminNewNameAttr).value;
    newAdminPassword = adminActConfigElement.getAttributeWithKey(inputProperties.customProperties.defaultAdminNewPwAttr).value;
}

try{
    var rawDisks = inputProperties.customProperties.additionalDisks
}
catch (err){
    System.warn("No additional disks being added to the VM '" + inputProperties.resourceNames[0] + "'")
}

if (rawDisks){
    disks     = JSON.stringify(parsedDisks);
    hasDisks  = (parsedDisks && parsedDisks.length > 0);
    diskCount = parsedDisks.length;

    System.log("workflow_VMDeployParent: Starting — VM=" + vmName +
            " OS=" + osTypeLower + " AdditionalDisks=" + diskCount);
}



// =========================================================================
// [CANVAS ELEMENT 2 — Scriptable Task: resolveVM]
// Inputs:
//   vmName  {string}
// Outputs:
//   vm      {VC:VirtualMachine}
//   summary {Array}
// =========================================================================

vm      = null;
summary = [];

var allVMs = VcPlugin.getAllVirtualMachines();
for (var v = 0; v < allVMs.length; v++) {
    if (allVMs[v].name === vmName) {
        vm = allVMs[v];
        break;
    }
}

if (!vm) {
    throw new Error(
        "VM '" + vmName + "' not found in vCenter inventory. " +
        "Verify VM name matches the 'name' property in the VCFA blueprint " +
        "and that provisioning completed successfully."
    );
}

System.log("workflow_VMDeployParent: VM resolved — " + vm.name + " (" + vm.reference.value + ")");
summary.push("VM resolved: " + vm.name);

// =========================================================================
// [CANVAS ELEMENT 3 — Scriptable Task: waitForTools]
// Inputs:
//   vm      {VC:VirtualMachine}
//   summary {Array}
// Outputs:
//   summary {Array}
// =========================================================================

var TOOLS_WAIT_MAX_MS = 300000;
var TOOLS_POLL_MS     = 10000;
var elapsed           = 0;
var toolsRunning      = false;

while (elapsed < TOOLS_WAIT_MAX_MS) {
    var toolsStatus = null;
    try {
        toolsStatus = vm.guest.toolsRunningStatus;
    } catch (statusErr) {
        System.warn("workflow_VMDeployParent: Could not read toolsRunningStatus: " + statusErr.message);
    }

    if (toolsStatus === "guestToolsRunning") {
        toolsRunning = true;
        break;
    }

    System.log("workflow_VMDeployParent: Tools status=" + toolsStatus + " — waiting... " + elapsed + "ms");
    System.sleep(TOOLS_POLL_MS);
    elapsed += TOOLS_POLL_MS;
}

if (!toolsRunning) {
    throw new Error(
        "VMware Tools not running on VM '" + vm.name + "' after " +
        TOOLS_WAIT_MAX_MS + "ms. " +
        "Verify Tools is installed and the VM has fully booted."
    );
}

System.log("workflow_VMDeployParent: VMware Tools running on " + vm.name);
summary.push("VMware Tools: running");

// =========================================================================
// [CANVAS ELEMENT 4 — Decision: hasDisks?]
// Condition: hasDisks === true
//   TRUE  → extractDiskUUIDs (Element 5)
//   FALSE → workflow_RenameLocalAdmin (Element 6)
// =========================================================================

// =========================================================================
// [CANVAS ELEMENT 5 — Action: extractDiskUUIDs]             (TRUE branch)
// Module: com.vcf.guestcustomization
// Inputs:
//   vm        {VC:VirtualMachine}
//   diskCount {number}
// Outputs:
//   diskUuidMapJson {string}
// =========================================================================

diskUuidMapJson = System.getModule("com.vcf.guestcustomization")
                        .extractDiskUUIDs(vm, diskCount);

System.log("workflow_VMDeployParent: Disk UUIDs extracted: " + diskUuidMapJson);
summary.push("Disk UUIDs extracted: " + diskCount + " disk(s)");

// =========================================================================
// [CANVAS ELEMENT 6 — Workflow: workflow_RenameLocalAdmin]
// In vRO editor: nested Workflow element
// Inputs:
//   vm            {VC:VirtualMachine}
//   osType        {string}            - bind osTypeLower
//   guestUsername {string}
//   guestPassword {SecureString}
//   newAdminName  {string}
// Outputs:
//   executionResult {string}          → renameResult
// =========================================================================

System.log("workflow_VMDeployParent: Invoking workflow_RenameLocalAdmin.");
summary.push("RenameLocalAdmin: completed");

// =========================================================================
// [CANVAS ELEMENT 7 — Workflow: workflow_UpdateLocalAdminPassword]
// In vRO editor: nested Workflow element
// IMPORTANT: guestUsername binds to newAdminName  (post-rename account)
//            guestPassword binds to guestPassword (pre-update — current password)
// Inputs:
//   vm            {VC:VirtualMachine}
//   osType        {string}            - bind osTypeLower
//   guestUsername {string}            - bind newAdminName
//   guestPassword {SecureString}      - bind guestPassword
//   newPassword   {SecureString}
// Outputs:
//   executionResult {string}          → passwordResult
// =========================================================================

System.log("workflow_VMDeployParent: Invoking workflow_UpdateLocalAdminPassword (username=" + newAdminName + ").");
summary.push("UpdateLocalAdminPassword: completed");

// =========================================================================
// [CANVAS ELEMENT 8 — Decision: hasDisks?]
// Condition: hasDisks === true
//   TRUE  → Decision: isWindows? (Element 9)
//   FALSE → logSummary (Element 12)
// =========================================================================

// =========================================================================
// [CANVAS ELEMENT 9 — Decision: isWindows?]                 (TRUE branch)
// Condition: osTypeLower === "windows"
//   TRUE  → workflow_MountFormatDisks_Windows (Element 10)
//   FALSE → workflow_MountFormatDisks_Linux   (Element 11)
// =========================================================================

// =========================================================================
// [CANVAS ELEMENT 10 — Workflow: workflow_MountFormatDisks_Windows]
// In vRO editor: nested Workflow element
// IMPORTANT: guestUsername binds to newAdminName (post-rename)
//            guestPassword binds to newPassword  (post-update)
// Inputs:
//   vm              {VC:VirtualMachine}
//   guestUsername   {string}           - bind newAdminName
//   guestPassword   {SecureString}     - bind newPassword
//   additionalDisks {string}           - bind disks
//   diskUuidMapJson {string}
// Outputs:
//   executionSummary {string}          → diskResult
// =========================================================================

System.log("workflow_VMDeployParent: Invoking workflow_MountFormatDisks_Windows.");
summary.push("MountFormatDisks_Windows: completed (" + diskCount + " disk(s))");

// =========================================================================
// [CANVAS ELEMENT 11 — Workflow: workflow_MountFormatDisks_Linux]
// In vRO editor: nested Workflow element
// IMPORTANT: guestUsername binds to newAdminName (post-rename)
//            guestPassword binds to newPassword  (post-update)
// Inputs:
//   vm              {VC:VirtualMachine}
//   guestUsername   {string}           - bind newAdminName
//   guestPassword   {SecureString}     - bind newPassword
//   additionalDisks {string}           - bind disks
//   diskUuidMapJson {string}
// Outputs:
//   executionSummary {string}          → diskResult
// =========================================================================

System.log("workflow_VMDeployParent: Invoking workflow_MountFormatDisks_Linux.");
summary.push("MountFormatDisks_Linux: completed (" + diskCount + " disk(s))");

// =========================================================================
// [CANVAS ELEMENT 12 — Scriptable Task: logSummary]
// Inputs:
//   vm      {VC:VirtualMachine}
//   summary {Array}
// Outputs:
//   deploymentSummary {string}
// =========================================================================

deploymentSummary = "VM: " + vm.name + "\n" + summary.join("\n");
System.log("workflow_VMDeployParent: COMPLETED.\n" + deploymentSummary);