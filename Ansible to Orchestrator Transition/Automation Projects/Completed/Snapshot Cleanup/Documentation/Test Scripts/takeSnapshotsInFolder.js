/**
 * vCenter Orchestrator Action: takeSnapshotsInFolder
 *
 * Description:
 *   Takes sequential snapshots of all VMs in a specified vCenter VM folder at
 *   3-minute intervals for a specified duration. One random snapshot per VM
 *   receives the description "Snapshot used by Content Library", and that
 *   designated snapshot index is randomized independently per VM so they don't
 *   all share the same "content library" snapshot.
 *
 * Input Parameters:
 *   @param {VC:VmFolder}  vmFolder          - The vCenter VM folder containing the target VMs
 *   @param {number}       durationMinutes   - Total duration (in minutes) to run the snapshot loop
 *
 * Output:
 *   @return {string} - Summary log of all snapshot operations performed
 *
 * Recommended Action Settings (vRO):
 *   - Timeout: Set to durationMinutes + 10 minutes buffer
 *   - Run as: vCenter service account with snapshot privileges
 *
 * Privileges Required on vCenter:
 *   - VirtualMachine.State.CreateSnapshot
 *   - VirtualMachine.Provisioning.ReadCustSpecs (for folder traversal)
 */

// ─── Input Parameters ────────────────────────────────────────────────────────
// vmFolder       : VC:VmFolder  — The VM folder to operate on
// durationMinutes: number       — How long (minutes) to keep taking snapshots

// ─── Constants ───────────────────────────────────────────────────────────────
var INTERVAL_MS          = 3 * 60 * 1000;   // 3 minutes in milliseconds
var CONTENT_LIB_DESC     = "Snapshot used by Content Library";
var SNAPSHOT_NAME_PREFIX = "snapshot-";

// ─── Utility: Sleep ──────────────────────────────────────────────────────────
/**
 * Blocks execution for the specified number of milliseconds.
 * vRO uses Java threading under the hood so Thread.sleep is available.
 */
function sleep(ms) {
    java.lang.Thread.sleep(ms);
}

// ─── Utility: Get all VMs in a folder (recursive) ────────────────────────────
/**
 * Recursively collects all VirtualMachine objects from a VC:VmFolder.
 * Handles nested sub-folders.
 *
 * @param  {VC:VmFolder} folder
 * @return {Array.<VC:VirtualMachine>}
 */
function getVmsFromFolder(folder) {
    var vms = [];
    var children = folder.childEntity;

    if (!children || children.length === 0) {
        return vms;
    }

    for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var childType = System.getObjectType(child);

        if (childType === "VC:VirtualMachine") {
            vms.push(child);
        } else if (childType === "VC:VmFolder") {
            // Recurse into sub-folders
            var subVms = getVmsFromFolder(child);
            for (var j = 0; j < subVms.length; j++) {
                vms.push(subVms[j]);
            }
        }
    }

    return vms;
}

// ─── Utility: Assign random "content library" snapshot index per VM ──────────
/**
 * For each VM, picks a random round index (1-based) in [1, totalRounds] that
 * will receive the Content Library description. The index is chosen
 * independently per VM so they are not all the same.
 *
 * @param  {Array.<VC:VirtualMachine>} vms
 * @param  {number}                    totalRounds
 * @return {Object}  Map of vm.name -> contentLibRoundIndex (1-based)
 */
function assignContentLibRounds(vms, totalRounds) {
    var assignments = {};
    for (var i = 0; i < vms.length; i++) {
        var vmName = vms[i].name;
        // Math.random() in [0,1), scale to [1, totalRounds]
        var randomRound = Math.floor(Math.random() * totalRounds) + 1;
        assignments[vmName] = randomRound;
    }
    return assignments;
}

// ─── Main Logic ──────────────────────────────────────────────────────────────

var log = [];

function logLine(msg) {
    var ts = new Date().toISOString();
    var line = "[" + ts + "] " + msg;
    System.log(line);
    log.push(line);
}

// Validate inputs
if (!vmFolder) {
    throw new Error("Input 'vmFolder' is required and must be a VC:VmFolder object.");
}
if (!durationMinutes || durationMinutes <= 0) {
    throw new Error("Input 'durationMinutes' must be a positive number.");
}

var durationMs  = durationMinutes * 60 * 1000;
var totalRounds = Math.floor(durationMs / INTERVAL_MS);

if (totalRounds < 1) {
    throw new Error(
        "durationMinutes (" + durationMinutes + ") is too short to complete even one " +
        "3-minute interval. Please specify at least 3 minutes."
    );
}

logLine("=== takeSnapshotsInFolder started ===");
logLine("Folder      : " + vmFolder.name);
logLine("Duration    : " + durationMinutes + " minutes");
logLine("Total rounds: " + totalRounds + " (one per 3-minute interval)");

// Discover VMs
var vms = getVmsFromFolder(vmFolder);
if (vms.length === 0) {
    logLine("WARNING: No VMs found in folder '" + vmFolder.name + "'. Exiting.");
    return log.join("\n");
}
logLine("VMs found   : " + vms.length);
for (var v = 0; v < vms.length; v++) {
    logLine("  VM[" + v + "]: " + vms[v].name);
}

// Assign per-VM content library snapshot round
var contentLibAssignments = assignContentLibRounds(vms, totalRounds);
logLine("Content Library snapshot assignments (round index per VM):");
for (var v = 0; v < vms.length; v++) {
    var vmName = vms[v].name;
    logLine("  " + vmName + " -> " + SNAPSHOT_NAME_PREFIX + contentLibAssignments[vmName]);
}

// ─── Snapshot Loop ───────────────────────────────────────────────────────────
var startTime = new Date().getTime();

for (var round = 1; round <= totalRounds; round++) {

    logLine("--- Round " + round + " of " + totalRounds + " ---");

    for (var v = 0; v < vms.length; v++) {
        var vm          = vms[v];
        var vmName      = vm.name;
        var snapName    = SNAPSHOT_NAME_PREFIX + round;
        var isContentLib = (contentLibAssignments[vmName] === round);
        var snapDesc    = isContentLib ? CONTENT_LIB_DESC : "";
        var memory      = false;  // Do not snapshot memory state
        var quiesce     = false;  // Do not quiesce guest filesystem
                                  // (set true if VMware Tools installed & desired)

        try {
            logLine(
                "  Snapshotting VM '" + vmName + "': name='" + snapName + "'" +
                (isContentLib ? " [CONTENT LIBRARY]" : "") +
                ", desc='" + snapDesc + "'"
            );

            var task = vm.createSnapshot_Task(snapName, snapDesc, memory, quiesce);

            // Wait for the snapshot task to complete before moving to the next VM.
            // vRO provides System.waitForTask or we can poll manually.
            System.getModule("com.vmware.library.vc.vm.snapshot").waitForTask(task);

            logLine("  SUCCESS: Snapshot '" + snapName + "' created on '" + vmName + "'");

        } catch (e) {
            // Log errors per-VM but continue so one failing VM doesn't block others
            logLine(
                "  ERROR: Failed to create snapshot '" + snapName +
                "' on VM '" + vmName + "': " + e.message
            );
        }
    }

    // After the final round, don't sleep — we're done
    if (round < totalRounds) {
        logLine("Round " + round + " complete. Sleeping 3 minutes before next round...");
        sleep(INTERVAL_MS);
    }
}

var endTime   = new Date().getTime();
var elapsedMs = endTime - startTime;
var elapsedMin = (elapsedMs / 60000).toFixed(1);

logLine("=== takeSnapshotsInFolder complete ===");
logLine("Total rounds executed : " + totalRounds);
logLine("Total VMs processed   : " + vms.length);
logLine("Total snapshots taken : " + (totalRounds * vms.length) + " (minus any errors above)");
logLine("Elapsed time          : " + elapsedMin + " minutes");

return log.join("\n");
