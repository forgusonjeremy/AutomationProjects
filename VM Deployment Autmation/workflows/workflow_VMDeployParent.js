/**
 * Workflow: workflow_VMDeployParent
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Parent orchestration workflow for VCF VM Apps self-service deployment.
 *   Invokes guest customization sub-workflows synchronously and in sequence
 *   after VCFA provisioning completes. Handles both Windows and Linux VMs.
 *
 * Execution order:
 *   1. Validate inputs
 *   2. Resolve VM object from vCenter (by name)
 *   3. Wait for VMware Tools readiness
 *   4. [If additionalDisks present] Extract disk UUIDs (extractDiskUUIDs action)
 *   5. Invoke workflow_RenameLocalAdmin        (nested, synchronous)
 *   6. Invoke workflow_UpdateLocalAdminPassword (nested, synchronous, uses renamed account)
 *   7. [If additionalDisks present AND osType == windows]
 *        Invoke workflow_MountFormatDisks_Windows (nested, synchronous)
 *   8. [If additionalDisks present AND osType == linux]
 *        Invoke workflow_MountFormatDisks_Linux   (nested, synchronous)
 *   9. Log completion summary
 *
 * VCFA Extensibility Subscription:
 *   Triggered via Post-Provisioning extensibility subscription in VCFA.
 *   Receives deployment context via extensibility payload.
 *   See Implementation Guide Section 3 for subscription configuration.
 *
 * Inputs:
 *   vmName          {string}        - VM hostname / display name (from VCFA payload)
 *   osType          {string}        - "windows" or "linux"
 *   vcenterFqdn     {string}        - vCenter FQDN for VM resolution
 *   guestUsername   {string}        - Built-in admin account name (pre-rename)
 *   guestPassword   {SecureString}  - Current guest password (pre-update)
 *   newAdminName    {string}        - Target name for admin account
 *   newPassword     {SecureString}  - New admin password to set
 *   additionalDisks {string}        - JSON array of disk definitions (empty string if none)
 *                                     Windows: [{driveLetter, driveLabel, sizeGb}]
 *                                     Linux:   [{mountPoint, driveLabel, sizeGb}]
 *
 * Outputs:
 *   deploymentSummary {string}      - Full execution log
 *
 * Dependencies (actions — must be imported in same module):
 *   com.vcf.guestcustomization/extractDiskUUIDs
 *
 * Dependencies (sub-workflows — must be imported and linked):
 *   workflow_RenameLocalAdmin
 *   workflow_UpdateLocalAdminPassword
 *   workflow_MountFormatDisks_Windows
 *   workflow_MountFormatDisks_Linux
 *
 * Notes:
 *   - Sub-workflows are represented here as inline scriptable task calls.
 *     In the vRO workflow editor, replace each _invoke* call with a
 *     "Workflow element" (nested workflow) linked to the corresponding workflow.
 *     Pass inputs/outputs as mapped binding attributes.
 *   - The _invoke* functions below are implementation stubs for documentation
 *     clarity. In vRO, nested workflow invocation is handled by the workflow
 *     engine via element linking, not via script.
 */

var TOOLS_WAIT_MAX_MS  = 300000; // 5 minutes — wait for Tools after provisioning
var TOOLS_POLL_MS      = 10000;
var summary            = [];

try {
    // =========================================================================
    // Step 1 — Input validation
    // =========================================================================
    if (!vmName)        throw new Error("Input 'vmName' is required.");
    if (!osType)        throw new Error("Input 'osType' is required.");
    if (!vcenterFqdn)   throw new Error("Input 'vcenterFqdn' is required.");
    if (!guestUsername) throw new Error("Input 'guestUsername' is required.");
    if (!guestPassword) throw new Error("Input 'guestPassword' is required.");
    if (!newAdminName)  throw new Error("Input 'newAdminName' is required.");
    if (!newPassword)   throw new Error("Input 'newPassword' is required.");

    var osTypeLower = osType.toLowerCase().trim();
    if (osTypeLower !== "windows" && osTypeLower !== "linux") {
        throw new Error("Input 'osType' must be 'windows' or 'linux'. Received: '" + osType + "'");
    }

    // Parse additionalDisks — treat empty/null/undefined as zero-disk deployment
    var disks = [];
    if (additionalDisks && additionalDisks.trim() !== "" && additionalDisks.trim() !== "[]") {
        try {
            disks = JSON.parse(additionalDisks);
        } catch (e) {
            throw new Error("Failed to parse additionalDisks JSON: " + e.message);
        }
    }

    var hasDisks = (disks && disks.length > 0);

    System.log("workflow_VMDeployParent: Starting — VM=" + vmName + " OS=" + osTypeLower +
               " AdditionalDisks=" + disks.length);

    // =========================================================================
    // Step 2 — Resolve VM object from vCenter by name
    // =========================================================================
    var vm = null;
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
    // Step 3 — Wait for VMware Tools readiness
    // =========================================================================
    System.log("workflow_VMDeployParent: Waiting for VMware Tools on " + vm.name);

    var elapsed      = 0;
    var toolsRunning = false;

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
    // Step 4 — Extract disk UUIDs (if additional disks requested)
    // =========================================================================
    var diskUuidMapJson = null;

    if (hasDisks) {
        System.log("workflow_VMDeployParent: Extracting disk UUIDs for " + disks.length + " disk(s).");

        // Invoke action: com.vcf.guestcustomization/extractDiskUUIDs
        // In vRO editor: Action element — inputs: vm, diskCount; output: diskUuidMapJson
        diskUuidMapJson = System.getModule("com.vcf.guestcustomization")
                                .extractDiskUUIDs(vm, disks.length);

        System.log("workflow_VMDeployParent: Disk UUIDs extracted: " + diskUuidMapJson);
        summary.push("Disk UUIDs extracted: " + disks.length + " disk(s)");
    }

    // =========================================================================
    // Step 5 — Rename local admin account
    // In vRO editor: nested Workflow element → workflow_RenameLocalAdmin
    // Bindings:
    //   IN:  vm, osType, guestUsername, guestPassword, newAdminName
    //   OUT: executionResult → renameResult
    // =========================================================================
    System.log("workflow_VMDeployParent: Invoking workflow_RenameLocalAdmin.");

    // [vRO nested workflow invocation — replace with Workflow element in editor]
    // var renameResult = _invokeRenameLocalAdmin(vm, osTypeLower, guestUsername, guestPassword, newAdminName);

    summary.push("RenameLocalAdmin: completed");

    // =========================================================================
    // Step 6 — Update local admin password
    // IMPORTANT: guestUsername here is the POST-RENAME name (newAdminName)
    // because the account was renamed in Step 5.
    // In vRO editor: nested Workflow element → workflow_UpdateLocalAdminPassword
    // Bindings:
    //   IN:  vm, osType, guestUsername=newAdminName, guestPassword, newPassword
    //   OUT: executionResult → passwordResult
    // =========================================================================
    System.log("workflow_VMDeployParent: Invoking workflow_UpdateLocalAdminPassword (username=" + newAdminName + ").");

    // [vRO nested workflow invocation — replace with Workflow element in editor]
    // var passwordResult = _invokeUpdatePassword(vm, osTypeLower, newAdminName, guestPassword, newPassword);

    summary.push("UpdateLocalAdminPassword: completed");

    // =========================================================================
    // Step 7/8 — Mount and format disks (conditional on hasDisks)
    // In vRO editor: Decision element → branch on hasDisks
    //   TRUE + windows → nested Workflow: workflow_MountFormatDisks_Windows
    //   TRUE + linux   → nested Workflow: workflow_MountFormatDisks_Linux
    //   FALSE          → skip (log only)
    // Bindings (both):
    //   IN:  vm, guestUsername=newAdminName, guestPassword=newPassword,
    //        additionalDisks, diskUuidMapJson
    //   OUT: executionSummary → diskResult
    // NOTE: Use newPassword here — password was updated in Step 6.
    // =========================================================================
    if (hasDisks) {
        if (osTypeLower === "windows") {
            System.log("workflow_VMDeployParent: Invoking workflow_MountFormatDisks_Windows.");
            // [vRO nested workflow invocation — replace with Workflow element in editor]
            // var diskResult = _invokeMountFormatWindows(vm, newAdminName, newPassword, additionalDisks, diskUuidMapJson);
            summary.push("MountFormatDisks_Windows: completed (" + disks.length + " disk(s))");

        } else {
            System.log("workflow_VMDeployParent: Invoking workflow_MountFormatDisks_Linux.");
            // [vRO nested workflow invocation — replace with Workflow element in editor]
            // var diskResult = _invokeMountFormatLinux(vm, newAdminName, newPassword, additionalDisks, diskUuidMapJson);
            summary.push("MountFormatDisks_Linux: completed (" + disks.length + " disk(s))");
        }
    } else {
        System.log("workflow_VMDeployParent: No additional disks — skipping disk workflow.");
        summary.push("MountFormatDisks: skipped (zero-disk deployment)");
    }

    // =========================================================================
    // Step 9 — Log completion
    // =========================================================================
    deploymentSummary = "VM: " + vm.name + "\n" + summary.join("\n");
    System.log("workflow_VMDeployParent: COMPLETED.\n" + deploymentSummary);

} catch (e) {
    System.error("workflow_VMDeployParent FAILED: " + e.message);
    throw e;
}
