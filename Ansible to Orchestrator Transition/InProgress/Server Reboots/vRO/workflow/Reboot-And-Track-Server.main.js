/**
 * Workflow scriptable task: Reboot-And-Track-Server (CHILD, async unit of work)
 * Module: com.corp.serverreboot
 *
 * One execution per server. The parent launches this asynchronously and monitors
 * its run state. It performs the full reboot lifecycle for a single VM and always
 * COMPLETES carrying a structured `result` (it does not throw for handled
 * outcomes) so the parent can read the outcome reliably even for failures.
 *
 * ---- INPUTS ----
 *   vm                   : VC:VirtualMachine   (already resolved by the parent)
 *   adName               : string
 *   fqdn                 : string
 *   postRebootTimeoutSec : number   (e.g. 600)
 *   pollIntervalSec      : number   (e.g. 15)
 *
 * ---- OUTPUT ----
 *   result : Properties  { adName, fqdn, matchedVmName, status, reason,
 *                          message, elapsedSec, timestamp }
 *
 * Actions used: precheckReboot, rebootGuestSafe, waitForGuestBack
 */

var MOD = "com.corp.serverreboot";
function nowIso() { return new Date().toISOString(); }

result = {
    adName: adName,
    fqdn: fqdn,
    matchedVmName: (vm ? vm.name : null),
    status: "SKIPPED",
    reason: "",
    message: "",
    elapsedSec: 0,
    timestamp: nowIso()
};

if (!vm) {
    result.reason = "NO_VM";
    result.message = "No VM supplied to child workflow.";
} else {
    try {
        // 1) Read-only gate: power + Tools. No Tools => skip, never hard-boot.
        var pc = System.getModule(MOD).getAction("precheckReboot").call(vm);
        if (!pc.ok) {
            result.status = "SKIPPED";
            result.reason = pc.reason;
            result.message = pc.message;
        } else {
            // 2) Graceful, Tools-mediated reboot (only power call anywhere).
            var rb = System.getModule(MOD).getAction("rebootGuestSafe").call(vm);
            if (!rb.issued) {
                result.status = "FAILED";
                result.reason = rb.reason;
                result.message = rb.message;
            } else {
                // 3) Confirm it cycled and returned within the timeout.
                var back = System.getModule(MOD).getAction("waitForGuestBack")
                    .call(vm, postRebootTimeoutSec, pollIntervalSec, 120);
                result.elapsedSec = back.elapsedSec;
                if (back.online) {
                    result.status = "SUCCESS";
                    result.reason = "REBOOTED";
                    result.message = "Rebooted and back online in " + back.elapsedSec +
                        "s (observedDown=" + back.observedDown + ").";
                } else {
                    result.status = "FAILED";
                    result.reason = "NOT_RETURNED";
                    result.message = "Reboot issued but host did not return within " +
                        postRebootTimeoutSec + "s.";
                }
            }
        }
    } catch (e) {
        // Handled here so the run still COMPLETES with a usable result.
        result.status = "FAILED";
        result.reason = "UNEXPECTED_ERROR";
        result.message = "" + e;
    }
}

System.log("[reboot-child] " + result.adName + " -> " + result.status +
    " (" + result.reason + ")");
