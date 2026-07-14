/**
 * Action: rebootGuestSafe
 * Module: com.corp.serverreboot
 *
 * Issue a GRACEFUL, Tools-mediated guest reboot. This is the ONLY place the
 * automation ever touches VM power, and it is graceful-only by construction:
 * it calls rebootGuest() (never reset()/powerOff()). rebootGuest() throws if
 * Tools are not running - which precheckReboot already gates - and any throw
 * is captured and returned, never propagated (continue-on-failure).
 *
 * @param {VC:VirtualMachine} vm
 * @returns {Properties} { issued:Boolean, reason:String, message:String }
 */

if (!vm) {
    return { issued: false, reason: "NO_VM", message: "No VM object supplied." };
}

try {
    System.log("[reboot] Issuing graceful rebootGuest() for VM '" + vm.name + "'.");
    vm.rebootGuest(); // graceful OS restart via VMware Tools
    return { issued: true, reason: "ISSUED", message: "rebootGuest() accepted by VMware Tools." };
} catch (e) {
    return {
        issued: false,
        reason: "REBOOT_ERROR",
        message: "rebootGuest() failed: " + e
    };
}
