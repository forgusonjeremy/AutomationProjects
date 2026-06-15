/* ============================================================================
 *  WORKFLOW: Prepare Linux VM Shell
 *  PATH:     Library / Production / VCF Automation / VM Deployments
 *  DISPLAY:  Prepare Linux VM Shell
 *  WF ID:    67025543-da95-4f1f-9850-7b4837c13a19
 * ----------------------------------------------------------------------------
 *  PURPOSE
 *    compute.provision.post orchestration for the Linux shell-VM use case.
 *    A throwaway OS template is deployed to satisfy the VCFA guest-up gate;
 *    this workflow then reshapes it into a clean ISO-install target:
 *    read request properties -> power off (waited) -> recreate the boot disk
 *    empty -> mount the selected ISO -> (workflow element) -> user interaction.
 *
 *  PROVISIONING MODEL
 *    Invoked by a compute.provision.post subscription with a single
 *    inputProperties {Properties} payload (same model as the Windows parent).
 *
 *  FAILURE SEMANTICS
 *    On failure VCFA destroys the VM and marks the deployment Failed; no
 *    re-run idempotency is attempted (consistent with the Windows chain).
 *
 *  INPUT:  inputProperties {Properties}
 *  ATTRIBUTES:
 *    vm               {VC:VirtualMachine}
 *    connectAtPowerOn {boolean}
 *    deviceType       {string}
 *    filePath         {string}
 *    vmHost           {VC:HostSystem}
 * ============================================================================
 * ==========================================================================*/


/* ============================================================================
 * item7 — Set Log Marker   (Scriptable Task   [ROOT])
 * NEXT: item2
 * ==========================================================================*/
System.setLogMarker("Workflow Name:" + workflow.name + "-Workflow Run ID:" + workflow.id);
System.log("Begin Workflow Execution");


/* ============================================================================
 * item2 — Get Properties   (Scriptable Task)
 * IN:  inputProperties
 * OUT: vm, filePath, vmHost
 * NEXT: item8
 * ==========================================================================*/
filePath = inputProperties.customProperties.isoPath
var vmId = inputProperties.externalIds[0]


 
System.log("Attach ISO: vmId=" + vmId);
System.log("Attach ISO: isoPath=" + filePath);


var vm = null;
var allVMs = Server.findAllForType("VC:Virtualmachine");
for (var i = 0; i < allVMs.length; i++) {
    if (allVMs[i].instanceId == vmId) {
        vm = allVMs[i];
        break;
    }
}

System.log("Attach ISO: resolved VM '" + vm.name + "'.");

vmHost = vm.vmHost;


/* ============================================================================
 * item8 — Power off virtual machine and wait   (Workflow link)
 * IN:  vm
 * NEXT: item9
 * linked-workflow-id: BD80808080808080808080808080808058C180800122528313869552e41805bb1
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item9 — Recreate Boot Disk   (Workflow link)
 * IN:  vm
 * NEXT: item1
 * linked-workflow-id: 71e5a14d-b1e3-4353-907c-8845d846c652
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item1 — Mount CD-ROM   (Workflow link)
 * IN:  vm, connectAtPowerOn, deviceType, filePath
 * NEXT: item10
 * linked-workflow-id: f146b992-71d3-431d-872e-2b22eb3b0f78
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item10 — Workflow element   (Workflow link)
 * NEXT: item0
 * linked-workflow-id: None
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */


/* ============================================================================
 * item6 — User interaction   (User Interaction)
 * IN:  security.group, security.assignees, security.assignee.groups, timeout.date
 * NEXT: item5
 * ==========================================================================*/

