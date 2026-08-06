/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ADAPTIVE SNAPSHOT DELETE TASK  (Wrapper Workflow — Single Scriptable Task)
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the scriptable task inside the "#Adaptive Snapshot Cleanup Delete
 * Task" child workflow. ST-06 (Process Powered-On VMs) dispatches this
 * workflow asynchronously via wrapperWf.execute(props) to run each snapshot
 * deletion in its own workflow token, enabling parallel execution with
 * per-VM serialisation.
 *
 * The wrapper exists because vRO scriptable tasks are synchronous — a single
 * scriptable task cannot dispatch multiple vCenter operations in parallel.
 * By wrapping _deleteSnapshot in a child workflow, ST-06 can start multiple
 * instances and poll their tokens for completion.
 *
 * This workflow contains exactly one scriptable task (this file) with no
 * Decision elements, no Exception Handler, and no additional logic. It is
 * a pure pass-through to the _deleteSnapshot action.
 *
 * ── WORKFLOW INPUTS ──────────────────────────────────────────────────────────
 *   Name                   vRO Type          Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   vcenterSdkConnection   VC:SdkConnection  The vCenter connection to use for this deletion.
 *                                            Passed by ST-06 from the per-vCenter connection
 *                                            lookup built during adaptive dispatch.
 *   vmMoRef                string            vm.id of the target VM. Used by _deleteSnapshot
 *                                            to locate the VM in the vCenter inventory tree.
 *   snapshotName           string            Name of the snapshot to delete. Resolved from
 *                                            the live snapshot tree at deletion time.
 *   snapshotCreatedMs      number            Creation timestamp (epoch ms) of the snapshot.
 *                                            Used to disambiguate when multiple snapshots
 *                                            share the same name.
 *   vmName                 string            Display name of the VM. Used in log messages.
 *   datastoreMoRefsJson    string            JSON array of datastore.id strings for the
 *                                            datastores this VM uses. Passed to _deleteSnapshot
 *                                            for pre/post metric sampling.
 *   dryRun                 boolean           When true, _deleteSnapshot skips the actual
 *                                            vCenter task submission. Always false when
 *                                            dispatched by ST-06 (ST-06 handles dry-run
 *                                            inline without dispatching the wrapper).
 *   taskTimeoutSeconds     number            Maximum seconds to wait for the vCenter
 *                                            snapshot removal task to complete.
 *
 * ── WORKFLOW OUTPUTS ─────────────────────────────────────────────────────────
 *   Name           vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────────────────────
 *   resultJson     string    JSON result object from _deleteSnapshot. Contains:
 *                            success (boolean), skipped (boolean), skipReason (string|null),
 *                            preMetricsJson (string), postMetricsJson (string),
 *                            durationMs (number), error (string|null).
 *                            ST-06 reads this via token.getOutputParameters().get("resultJson")
 *                            during its harvest cycle.
 *
 * ── CANVAS LAYOUT ────────────────────────────────────────────────────────────
 *   [Start] → [Scriptable Task: Delete Snapshot] → [End]
 *
 *   No error handling — if _deleteSnapshot throws, the workflow token enters
 *   the "failed" state. ST-06's harvest loop detects this via the token state
 *   check and logs it as an error with the globalException message.
 *
 * ── SETUP IN VRO DESIGNER ────────────────────────────────────────────────────
 *   1. Create a new workflow named "#Adaptive Snapshot Cleanup Delete Task"
 *      in the same folder as the main workflow.
 *   2. Add the eight inputs listed above on the Inputs tab with their
 *      respective types.
 *   3. Add one output "resultJson" of type string on the Outputs tab.
 *   4. Drop a single Scriptable Task element on the canvas.
 *   5. Paste this script into the Scriptable Task.
 *   6. Bind all eight inputs as IN bindings on the Scriptable Task.
 *   7. Bind resultJson as an OUT binding on the Scriptable Task.
 *   8. Wire: Start → Scriptable Task → End.
 *   9. In the main workflow (#Adaptive Snapshot Cleanup--Multi-vCenter),
 *      create a workflow attribute "wrapperWf" of type Workflow and hardset
 *      it to this workflow object.
 * ─────────────────────────────────────────────────────────────────────────────
 */

var MODULE = "com.broadcom.pso.vc.vm.snapshots";

System.log("[SNAPSHOT-CLEANUP] [PROCESSING] [OK]      Wrapper executing: " +
    "VM='" + vmName + "'  snap='" + snapshotName + "'  dryRun=" + dryRun);

resultJson = System.getModule(MODULE)._deleteSnapshot(
    vcenterSdkConnection,
    vmMoRef,
    snapshotName,
    snapshotCreatedMs || 0,
    vmName,
    datastoreMoRefsJson,
    dryRun,
    taskTimeoutSeconds || 1800
);

System.log("[SNAPSHOT-CLEANUP] [PROCESSING] [OK]      Wrapper complete: " +
    "VM='" + vmName + "'  snap='" + snapshotName + "'");
