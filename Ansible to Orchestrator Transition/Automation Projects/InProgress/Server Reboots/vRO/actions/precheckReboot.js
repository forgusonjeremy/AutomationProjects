/**
 * Action: precheckReboot
 * Module: com.corp.serverreboot
 *
 * Read-only safety gate. Confirms a VM is eligible for a GRACEFUL guest reboot.
 * NEVER mutates the VM. If this returns ok:false, the caller SKIPS the server
 * (it is never hard-booted) - satisfying the "no corruption" invariant.
 *
 * @param {VC:VirtualMachine} vm
 * @returns {Properties} { ok:Boolean, reason:String, message:String }
 */

if (!vm) {
    return { ok: false, reason: "NO_VM", message: "No VM object supplied." };
}

// Power state must be poweredOn.
try {
    if (vm.runtime.powerState != VcVirtualMachinePowerState.poweredOn) {
        return {
            ok: false,
            reason: "POWERED_OFF",
            message: "Power state is " + vm.runtime.powerState.value + "; skipping."
        };
    }
} catch (e) {
    return { ok: false, reason: "STATE_UNKNOWN", message: "Cannot read power state: " + e };
}

// VMware Tools must be running - required for graceful rebootGuest().
try {
    var toolsRunning = String(vm.guest.toolsRunningStatus); // "guestToolsRunning" | "guestToolsNotRunning" | ...
    if (toolsRunning !== "guestToolsRunning") {
        return {
            ok: false,
            reason: "TOOLS_NOT_RUNNING",
            message: "VMware Tools status is '" + toolsRunning +
                "'; graceful reboot not possible - skipping (no hard reboot)."
        };
    }
} catch (e) {
    return { ok: false, reason: "TOOLS_UNKNOWN", message: "Cannot read Tools status: " + e };
}

return { ok: true, reason: "OK", message: "Powered on, Tools running." };
