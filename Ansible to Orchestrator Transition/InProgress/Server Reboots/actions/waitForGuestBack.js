/**
 * Action: waitForGuestBack
 * Module: com.corp.serverreboot
 *
 * After a graceful reboot, confirm the guest actually cycled: observe VMware
 * Tools go DOWN (server rebooting) then come back UP (Tools running + heartbeat
 * green) within timeoutSec. If it does not return in time -> online:false and
 * the caller records the server as FAILED / NOT_RETURNED.
 *
 * Note on the "fast reboot" edge: if the OS reboots faster than the poll
 * interval we may never catch the down phase. We therefore treat a confirmed
 * UP state as success even if we did not observe the down transition, and log
 * observedDown for transparency. (Tune pollIntervalSec down to catch it.)
 *
 * @param {VC:VirtualMachine} vm
 * @param {number} timeoutSec       - overall budget, e.g. 600 (10 min)
 * @param {number} pollIntervalSec  - poll cadence, e.g. 15
 * @param {number} downConfirmSec   - max time to wait to observe it go down, e.g. 120
 * @returns {Properties} { online:Boolean, observedDown:Boolean,
 *                         elapsedSec:Number, message:String }
 */

if (!vm) {
    return { online: false, observedDown: false, elapsedSec: 0, message: "No VM object." };
}

var timeout = (timeoutSec && timeoutSec > 0) ? timeoutSec : 600;
var pollMs = ((pollIntervalSec && pollIntervalSec > 0) ? pollIntervalSec : 15) * 1000;
var downWindowMs = ((downConfirmSec && downConfirmSec > 0) ? downConfirmSec : 120) * 1000;

var start = System.getCurrentTime();
var deadline = start + timeout * 1000;
var downDeadline = Math.min(deadline, start + downWindowMs);

function toolsUp() {
    try { return String(vm.guest.toolsRunningStatus) === "guestToolsRunning"; }
    catch (e) { return false; }
}
function heartbeatGreen() {
    try { return vm.guestHeartbeatStatus == VcManagedEntityStatus.green; }
    catch (e) { return false; }
}
function elapsed() { return Math.round((System.getCurrentTime() - start) / 1000); }

System.log("[reboot] Waiting for VM '" + vm.name + "' to cycle (timeout " +
    timeout + "s, poll " + (pollMs / 1000) + "s).");

// Stage 1 - observe the guest go down (best effort within downConfirm window).
var observedDown = false;
while (System.getCurrentTime() < downDeadline) {
    if (!toolsUp()) { observedDown = true; break; }
    System.sleep(pollMs);
}
if (!observedDown) {
    System.warn("[reboot] '" + vm.name + "' never observed going down within " +
        (downWindowMs / 1000) + "s (fast reboot possible); requiring UP state to confirm.");
}

// Stage 2 - wait for the guest to be fully back: Tools running + heartbeat green.
while (System.getCurrentTime() < deadline) {
    if (toolsUp() && heartbeatGreen()) {
        System.log("[reboot] '" + vm.name + "' is back online after " + elapsed() + "s.");
        return {
            online: true,
            observedDown: observedDown,
            elapsedSec: elapsed(),
            message: "Back online (Tools running, heartbeat green)."
        };
    }
    System.sleep(pollMs);
}

return {
    online: false,
    observedDown: observedDown,
    elapsedSec: elapsed(),
    message: "Did not return to a healthy state within " + timeout + "s."
};
