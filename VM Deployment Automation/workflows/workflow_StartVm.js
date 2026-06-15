/* ============================================================================
 *  WORKFLOW: Start virtual machine
 *  PATH:     Library / Production / VCF Automation / VM Deployments / Helpers
 *  DISPLAY:  Start virtual machine
 *  WF ID:    e3386cbb-2a22-45ed-b63e-299b0e734b1b
 * ----------------------------------------------------------------------------
 *  PURPOSE
 *    Idempotent VM power-on helper. If the VM is already poweredOn, do nothing;
 *    otherwise issue startVM and wait for the task (answering any pending VM
 *    question via the library "Wait for task and answer" workflow).
 *
 *  INPUT:  vm {VC:VirtualMachine}, host {VC:HostSystem}
 *  ATTRIBUTES:
 *    task {VC:Task}
 * ============================================================================
 * ==========================================================================*/


/* ============================================================================
 * item1 — VM is poweredOn?   (Decision / custom-condition   [ROOT])
 * IN:  vm
 *   true  -> item7
 *   false -> item0
 * ==========================================================================*/
return vm.runtime.powerState.value == "poweredOn";


/* ============================================================================
 * item7 — Already started   (Scriptable Task)
 * NEXT: item2
 * ==========================================================================*/
System.log("VM already started");


/* ============================================================================
 * item0 — startVM   (Scriptable Task)
 * IN:  vm, host
 * OUT: actionResult -> task
 * NEXT: item3
 * ==========================================================================*/
//Auto generated script, cannot be modified !
actionResult = System.getModule("com.vmware.library.vc.vm.power").startVM(vm,host) ;


/* ============================================================================
 * item3 — Wait for task and answer virtual machine question   (Workflow link)
 * IN:  vm, task
 * NEXT: item2
 * linked-workflow-id: B8808080808080808080808080808080C480808001231146624761b79546544c2
 * ==========================================================================*/
/* (No scriptable body — workflow link.) */

