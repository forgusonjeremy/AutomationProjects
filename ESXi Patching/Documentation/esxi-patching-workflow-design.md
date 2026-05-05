# ESXi Patching Workflow — Design Document (Phase 3)

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail)
> **Document version:** 1.0 (DRAFT — built on Phase 2 requirements with provisional defaults)
> **Date:** 2026-05-04
> **Companion documents:** `esxi-patching-workflow-open-items.md`, `esxi-patching-workflow-requirements.md`

---

## How to read this document

This document defines the implementation architecture for the requirements specified in the Phase 2 Requirements Document. It is structured per the system prompt's Phase 3 specification:

- **Section 3a** — Scripting runtime selection and rationale.
- **Section 3b** — Workflow and Action element inventory (the master parts list).
- **Section 3c** — Workflow canvas layouts with phase decomposition for each of the three layered workflows.
- **Section 3d** — Module path naming convention.
- **Section 3e** — Text-based canvas diagrams for each workflow.
- **Section 3f** (additional) — Configuration Element schemas.
- **Section 3g** (additional) — Cross-cutting design patterns (locking, error propagation, logging, result objects).
- **Section 3h** (additional) — Verified API references and unverified items requiring architect review.

Phase 4 (code generation) follows architect approval of this document.

---

## 3a — Scripting Runtime Recommendation

### Primary recommendation: **JavaScript (Rhino)** for all workflows and Actions.

The recommendation is unanimous across all workflow elements for the following reasons:

1. **Plugin-first principle (per system prompt).** This workflow makes extensive use of vCenter plugin objects (`VcSdkConnection`, `VcClusterComputeResource`, `VcHostSystem`, `VcHostServiceSystem`, `VcContentLibraryItem`, `VcDatastore`, `VcFileManager`, `VcTask`). JavaScript is the **only** runtime with direct access to these plugin objects. Using PowerShell, Python, or PowerCLI would require us to replace plugin calls with REST equivalents — significantly more code, slower, and less reliable.

2. **SSH plugin is JavaScript-native.** The `SSHSession` class used by the `Patch ESXi Host` workflow's `PATCH_LIST` and `PATCH_INSTALL` phases is a JavaScript-only plugin object. PowerShell or Python would have to use their own native SSH libraries, which are out of scope per CON-01 and CON-02.

3. **`LockingSystem` is JavaScript-native.** The cluster-scope locking pattern uses `LockingSystem.lockAndWaitForOwnership` and `LockingSystem.unlock`, which are vRO platform APIs accessible only from JavaScript.

4. **Mail plugin is JavaScript-native.** The `com.vmware.library.mail.sendMail` Action is a JavaScript-based Action that wraps the `Mail:SMTPClient` inventory object.

5. **Workflow execution APIs are JavaScript-native.** `Workflow.executeAsync()` and `WorkflowToken.waitState()`, which power the `runWithParallelism` reusable Action, are JavaScript-only.

6. **No data processing requires Python.** The data shapes we work with (host build numbers, esxcli output parsing, HTML report assembly) are all string-manipulation tasks that JavaScript handles fine. No regex-heavy parsing or numeric/scientific computation that would justify Python.

7. **PowerCLI is explicitly not required (per discovery batch 5e).** All vSphere operations needed by this workflow are covered by the vCenter plugin's native objects and methods.

### Custom scripting environment requirement: **None.**

This workflow uses only out-of-box vRO 9.x JavaScript runtime capabilities. No custom scripting environment needs to be created.

### One important Rhino constraint to flag

The vRO JavaScript runtime is **Rhino-based, not Node.js**. The following modern JavaScript features are **not available** and the code must avoid them:

- `let` and `const` — use `var` only.
- Arrow functions (`(x) => x + 1`) — use traditional `function` syntax.
- Template literals (backtick strings with `${}`) — use string concatenation with `+`.
- `Promise`, `async`/`await` — use synchronous code; for async workflow waits, use `WorkflowToken.waitState()`.
- `Map`, `Set`, `for...of` (works in some contexts but unreliable) — use `Object` literals and traditional `for` loops.
- Spread operator (`...args`) — use `arguments` or explicit array iteration.
- Default parameter values (`function f(x = 1) {}`) — check `arguments.length` and assign defaults inside the function.
- `Array.prototype.includes`, `Array.prototype.find`, `Array.prototype.findIndex` — use `indexOf` or manual loops.

All code in Phase 4 will be written to these constraints and the architect will see no ES6+ syntax.

---

## 3b — Workflow and Action Element Inventory

This section enumerates every element the project will create, organized by workflow layer and Action category.

### 3b.1 Workflow Inventory

Five workflows total:

| # | Workflow Name | Folder Path | Layer | Catalog Item | Purpose |
|---|---|---|---|---|---|
| WF-01 | **Patch ESXi vCenter** | `Library/PSO/ESXi Patching/` | Layer 1 | YES | Top-level operator-facing workflow. Owns the request form, vCenter-level orchestration, and results aggregation. |
| WF-02 | **Patch ESXi Cluster** | `Library/PSO/ESXi Patching/Internal/` | Layer 2 | NO | Per-cluster orchestrator. Owns the cluster-scope lock, per-cluster pre-flight, sequential host iteration, halt-on-host-failure logic. |
| WF-03 | **Patch ESXi Host** | `Library/PSO/ESXi Patching/Internal/` | Layer 3 | NO | Per-host KB 000345284 procedure. |
| WF-04 | **Validate ESXi Patching Prerequisites** | `Library/PSO/ESXi Patching/` | Sibling utility | YES (pending C-06) | Read-only validation workflow that runs all pre-flight checks against an operator-selected scope and produces a go/no-go report without making changes. |
| WF-05 | **Release ESXi Patch Locks** | `Library/PSO/ESXi Patching/Operations/` | Auxiliary utility | NO (admin-only) | Manual cleanup of orphaned cluster-scope locks. |

### 3b.2 Action Inventory — Reusable Library (`com.broadcom.pso.common.*`)

These Actions are general-purpose and added to the architect's reusable library. They are **NEW** (the existing reusable library is minimal per discovery batch 3a).

| Module Path | Action Name | Inputs | Returns | Purpose |
|---|---|---|---|---|
| `com.broadcom.pso.common.logging` | `initWorkflowLogging` | `prefix: string` | `void` | Sets workflow log marker (`WorkflowName:<name> WorkflowRunId:<id>`) and emits the WorkflowStart audit log line. Standard workflow preamble. |
| `com.broadcom.pso.common.logging` | `debugLog` | `prefix: string`, `phase: string`, `status: string`, `message: string`, `debugEnabled: boolean` | `void` | Conditional debug-level logging. No-op when `debugEnabled = false`. |
| `com.broadcom.pso.common.logging` | `auditLog` | `prefix: string`, `phase: string`, `status: string`, `message: string` | `void` | Unconditional audit-level logging with the standard structured format. |
| `com.broadcom.pso.common.workflow` | `runWithParallelism` | `workItems: Array/Properties`, `workerWorkflow: Workflow`, `inputBuilder: string` (Action reference name as string), `parallelismCap: number`, `pollIntervalSeconds: number` | `Array/Properties` (results in same order as workItems) | Asynchronous fan-out with bounded parallelism and asymmetric scheduling. The `inputBuilder` parameter is the name of an Action that takes a single work item and returns a `Properties` object of inputs for the worker workflow. |
| `com.broadcom.pso.common.workflow` | `releaseAllLocksHeldByWorkflow` | `workflowRunId: string` | `number` (locks released) | Releases all `LockingSystem` locks owned by a given workflow run. Used in the default error handler. |
| `com.broadcom.pso.common.config` | `getConfigurationElementValue` | `pathOrName: string`, `attributeName: string` | `any` | Reads a value from a Configuration Element by path/name and attribute name. Handles encrypted attributes transparently. Throws if not found. |
| `com.broadcom.pso.common.config` | `getEncryptedConfigurationElementValue` | `pathOrName: string`, `attributeName: string` | `SecureString` | Reads an encrypted-attribute value from a Configuration Element. Returns a SecureString-typed value to prevent leakage in logs. |

**Reusability impact:** Any future workflow needing log markers, debug logging, fan-out parallelism, or Configuration Element reads uses these. The `runWithParallelism` Action in particular is high-value — it codifies a pattern the existing library lacks.

### 3b.3 Action Inventory — ESXi Patching Specific (`com.broadcom.pso.vc.esxi.patching.*`)

These Actions are specific to this project. Organized by sub-module by function.

#### `com.broadcom.pso.vc.esxi.patching.form` — Form-time external-value Actions

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `getRegisteredVcenters` | (none) | `Array/Properties` (label, value) | Lists all `VC:SdkConnection` inventory connections. Form-time vCenter picker source. |
| `getClustersForVcenter` | `vcenter: VC:SdkConnection` | `Array/Properties` (label, value) | Lists all clusters in the selected vCenter, each labeled with type and health per FR-09 (`(VXRAIL — READY)`, `(POWERFLEX — NOT SUPPORTED)`, etc.). |
| `getDepotItemsForVcenter` | `vcenter: VC:SdkConnection`, `contentLibraryName: string` | `Array/Properties` (label, value) | Lists Content Library items in the named CL on the selected vCenter, filtered to ESXi depot pattern. |

#### `com.broadcom.pso.vc.esxi.patching.detect` — Cluster type identification

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `identifyClusterType` | `cluster: VcClusterComputeResource` | `string` (`VXRAIL` / `POWERFLEX` / `VSAN-ONLY` / `OTHER`) | Positively classifies a cluster. VxRail detection uses the `VxRail-IP` custom attribute on the cluster (verified — see Section 3h). PowerFlex detection uses VIB inventory on the cluster's hosts (see Section 3h for verification status). vSAN-only is detected via `cluster.configurationEx.vsanConfigInfo.enabled` AND no VxRail custom attribute. |
| `isVxRailCluster` | `cluster: VcClusterComputeResource` | `boolean` | Wrapper around `identifyClusterType` returning true only for `VXRAIL`. |
| `getClusterCustomAttributes` | `cluster: VcClusterComputeResource` | `Properties` | Reads all custom attributes on a cluster and returns as a key/value map. Used by `identifyClusterType` and for diagnostic logging. |

#### `com.broadcom.pso.vc.esxi.patching.preflight` — Pre-flight gates

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `evaluateClusterPreflightCheap` | `cluster: VcClusterComputeResource` | `Properties` (status: READY/WARNING/BLOCKED, reason: string, details: Properties) | Form-time check: cluster type, HA enabled, DRS automated, host count ≥ 4, no host in MM. |
| `evaluateClusterPreflightFull` | `cluster: VcClusterComputeResource`, `ignoreWarnings: boolean` | `Properties` (status, reason, details) | Workflow-start-time check: all cheap checks plus active vSAN resync detection and recent-task analysis. |
| `checkClusterHaHealth` | `cluster: VcClusterComputeResource` | `Properties` (enabled, healthy, reason) | HA-specific evaluation. |
| `checkClusterDrsHealth` | `cluster: VcClusterComputeResource` | `Properties` (enabled, automated, reason) | DRS-specific evaluation. |
| `checkClusterHostsHealthy` | `cluster: VcClusterComputeResource` | `Properties` (allHealthy, hostsInMM: Array, hostsDisconnected: Array) | Host connection state evaluation. |
| `checkVsanResyncIdle` | `cluster: VcClusterComputeResource` | `Properties` (idle, activeResync: Properties) | Detects active vSAN resync. |
| `checkClusterRecentTaskActivity` | `cluster: VcClusterComputeResource`, `lookbackMinutes: number` | `Properties` (clean, suspiciousTasks: Array) | Heuristic check for recent VxRail Manager / vLCM activity. |

#### `com.broadcom.pso.vc.esxi.patching.staging` — Patch staging

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `resolveContentLibraryItemPath` | `clItem: Properties`, `vcenter: VC:SdkConnection` | `Properties` (datastoreName, datastorePath, fileName, isShared) | Resolves a CL item to its on-disk path on the backing datastore. Determines whether the backing datastore is shared across all hosts in scope (governs which `patchStagingMode` is viable). |
| `findClusterStagingDatastore` | `cluster: VcClusterComputeResource`, `requiredFreeBytes: number` | `VcDatastore` | Finds a cluster-shared VMFS or NFS datastore with sufficient free space. Returns the highest-free-space candidate. |
| `stageDepotToDatastore` | `sourceDatastorePath: string`, `targetDatastore: VcDatastore`, `targetDirectory: string`, `vcenter: VC:SdkConnection` | `string` (full path on target datastore) | Copies the depot ZIP using the vSphere `FileManager.copyDatastoreFile_Task` API. |
| `cleanupStagedDepot` | `targetDatastore: VcDatastore`, `targetPath: string`, `vcenter: VC:SdkConnection` | `boolean` (success) | Best-effort cleanup of staged depot file via `FileManager.deleteDatastoreFile_Task`. Failure logs warning but does not throw. |

#### `com.broadcom.pso.vc.esxi.patching.credentials` — Credential retrieval

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `getEsxiSshCredentials` | `vcenterFqdn: string`, `clusterMoRef: string` | `Properties` (sshUsername: string, sshPassword: SecureString) | Reads SSH credentials from the keyed Configuration Element. Throws if not found for the cluster. |

#### `com.broadcom.pso.vc.esxi.patching.host` — Per-host operations

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `setHostSshServiceState` | `host: VcHostSystem`, `enabled: boolean` | `Properties` (success, prevState) | Starts or stops `TSM-SSH` via `host.configManager.serviceSystem`. |
| `verifyHostNotInMaintenanceMode` | `host: VcHostSystem` | `boolean` | Real-time check for FR-19 step 1. |
| `verifyClusterHasNoOtherHostsInMM` | `cluster: VcClusterComputeResource`, `excludeHostMoRef: string` | `Properties` (clean, otherHostsInMM: Array) | The pre-MM-entry safety check from FR-19 step 1. |
| `enterMaintenanceModeEnsureAccessibility` | `host: VcHostSystem`, `timeoutSeconds: number` | `Properties` (success, taskMoRef) | Enter MM with `EnsureObjectAccessibility` data movement option. |
| `exitMaintenanceMode` | `host: VcHostSystem`, `timeoutSeconds: number` | `Properties` (success) | Standard MM exit. |
| `runEsxcliProfileList` | `host: VcHostSystem`, `depotPath: string`, `sshCreds: Properties` | `Properties` (success, profiles: Array, standardProfileName: string, rawOutput: string) | SSH executes `esxcli software sources profile list --depot=<path>` and parses the output to extract profile names, identifying the `-standard` variant. |
| `runEsxcliProfileUpdate` | `host: VcHostSystem`, `depotPath: string`, `profileName: string`, `bypassHardwareCheck: boolean`, `sshCreds: Properties` | `Properties` (success, exitCode, vibsInstalled, vibsRemoved, vibsSkipped, rawOutput) | SSH executes `esxcli software profile update -p <profile> --depot=<path>` (with optional `--no-hardware-warning`) and parses the structured output. |
| `rebootHostAndWaitReconnect` | `host: VcHostSystem`, `timeoutMinutes: number`, `pollIntervalSeconds: number` | `Properties` (success, durationSeconds, reasonIfFailed) | Initiates host reboot via `host.rebootHost_Task` and polls `host.runtime.connectionState` until `connected` or timeout. |
| `getHostBuildNumber` | `host: VcHostSystem` | `Properties` (build: string, fullVersion: string, productLineId: string) | Reads `host.config.product.build` and related fields. |
| `verifyHostBuildChanged` | `host: VcHostSystem`, `expectedDifferentFromBuild: string` | `Properties` (changed, currentBuild) | Compares post-patch build to pre-patch build. |

#### `com.broadcom.pso.vc.esxi.patching.locking` — Lock management

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `acquireClusterPatchLock` | `vcenterFqdn: string`, `clusterMoRef: string`, `workflowRunId: string`, `waitSeconds: number` | `Properties` (acquired, lockOwner: string, lockOwnerRunId: string) | Attempts to acquire `ESXI_PATCH_<vcenter>_<cluster>` lock. Returns lock owner info on failure (does not throw). |
| `releaseClusterPatchLock` | `vcenterFqdn: string`, `clusterMoRef: string`, `workflowRunId: string` | `boolean` (released) | Releases the lock. Always called from finally / default error handler. |

#### `com.broadcom.pso.vc.esxi.patching.results` — Result-object construction

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `buildHostResultProperties` | (many — full result payload) | `Properties` | Constructs the structured per-host result per AD-07 contract. Centralized so the format is consistent everywhere. |
| `buildClusterResultProperties` | (many — full cluster result payload) | `Properties` | Constructs the structured per-cluster result per AD-07 contract. |
| `buildVcenterResultProperties` | (many — full vCenter result payload) | `Properties` | Constructs the top-level result per AD-07 contract. |

#### `com.broadcom.pso.vc.esxi.patching.report` — HTML report and notifications

| Action Name | Inputs | Returns | Purpose |
|---|---|---|---|
| `composeHtmlRunReport` | `vcenterResult: Properties`, `runMetadata: Properties` | `string` (HTML body) | Generates the full HTML report. Used both for email body and for the `runReportHtml` deployment output. |
| `composeInterventionEmailHtml` | `hostResult: Properties`, `clusterResult: Properties`, `runMetadata: Properties` | `string` | Generates the immediate-intervention email body for a single host failure requiring manual recovery. |
| `sendNotificationEmail` | `recipients: Array/string`, `subject: string`, `htmlBody: string`, `smtpHost: Mail:SMTPClient` | `Properties` (sentAt: Date, success, recipientsActuallySent) | Sends email via the Mail plugin. Logs send result to audit. |

### 3b.4 Reuse Determination

Per the Phase 2 reusable assets section, **none** of the Actions above currently exist in the customer's library. All are new. The library Actions in `com.broadcom.pso.common.*` are intentionally generic so they can be reused by future projects without modification.

### 3b.5 Configuration Elements

Three Configuration Elements support this project:

| CE Path / Name | Purpose | Schema |
|---|---|---|
| `PSO/ESXi Patching/Settings` | Project-level settings (non-secret). | `esxiPatchContentLibraryName: string` (default `ESXi-Patches`), `defaultMaxParallelClusters: number` (default 3), `defaultHostRebootTimeoutMinutes: number` (default 25), `notificationFixedCcList: Array/string` (default empty), `intervention.emailSubjectPrefix: string` (default `[ACTION REQUIRED]`), `report.workflowDocumentationUrl: string` (default empty, for footer link in emails). |
| `PSO/ESXi Patching/Credentials/<vcenter-fqdn>` | One Configuration Element per vCenter, holding the per-cluster ESXi root credentials. | One attribute per cluster, named `<cluster-moref>`, type `Properties` containing `{ sshUsername: string, sshPassword: SecureString (encrypted) }`. **Pending C-05** — schema may shift to per-host if customer responds with per-host password rotation. |
| `PSO/ESXi Patching/SmtpReference` | Reference to the SMTP host inventory record (in case there are multiple SMTP hosts and we need to pin to a specific one). | `smtpHostName: string` (matches `Mail:SMTPClient.name`). If empty, workflow uses `Server.findAllForType("Mail:SMTPClient")[0]`. |

---

## 3c — Workflow Canvas Layouts (Phase Decomposition)

Each workflow's canvas is structured per the system prompt's phase-decomposition guidance: every Scriptable Task represents a single function within a clearly named phase, every branch is a visible Decision element, and every external operation that has reusable utility is an Action element on the canvas (not inlined script).

### 3c.1 `Patch ESXi vCenter` (WF-01) Canvas

**Workflow attributes:**

| Attribute | Type | Purpose |
|---|---|---|
| `wfLogPrefix` | string | `[ESXI-PATCH-VC]` — used in all log lines from this workflow. |
| `wfRunId` | string | Captured at startup from `workflow.id`. |
| `clusterWorkItems` | Array/Properties | List of cluster-processing work items built in Discovery phase, consumed in Execute phase. |
| `clusterResults` | Array/Properties | Aggregated results from all `Patch ESXi Cluster` runs. |
| `emailsSent` | Array/Properties | All emails dispatched during this run. |
| `vcenterResult` | Properties | Final top-level result (the source of all output bindings). |
| `runStartTime` | Date | Run start timestamp. |
| `runEndTime` | Date | Run end timestamp. |

**Canvas elements (left-to-right):**

| # | Element | Type | Phase | Function |
|---|---|---|---|---|
| 1 | Start | (start) | — | Workflow start. |
| 2 | Initialize Logging | Scriptable Task | STARTUP | Set log marker, audit-log workflow start, capture `wfRunId` and `runStartTime`, log all input parameters at audit level. |
| 3 | Validate Inputs | Scriptable Task | VALIDATE | Sanity-check the operator's inputs (e.g., `targetClusters` is non-empty, `notificationEmailRecipients` is well-formed). On invalid → throw to default error handler. |
| 4 | Decision: Acknowledgement Checked? | Decision | VALIDATE | Defense in depth — even though the form gates this, re-verify in code. Branch FALSE → end with error. |
| 5 | Resolve SMTP Host | Scriptable Task | AUTH | Look up the SMTP host inventory record for use later. Errors here don't fail the run; emails just won't send (logged and surfaced in run summary). |
| 6 | Pre-flight: Identify VxRail Clusters | Scriptable Task (calls Action `identifyClusterType` per cluster) | DISCOVER | For each `targetClusters` entry, call `identifyClusterType`. Any non-VXRAIL cluster is **immediately rejected** (log, add to `clustersSkipped`, do not include in workItems). |
| 7 | Pre-flight: Full Health Checks | Scriptable Task (calls Action `evaluateClusterPreflightFull` per cluster) | DISCOVER | For each VxRail cluster, run the full check. Failures move the cluster to `clustersSkipped` with reason. |
| 8 | Decision: Any clusters eligible? | Decision | DECIDE | If zero clusters survived pre-flight → branch to End-with-Summary (no Execute phase). |
| 9 | Build Cluster Work Items | Scriptable Task | DECIDE | Construct the `clusterWorkItems` array — each item is a Properties bag containing the inputs for one `Patch ESXi Cluster` invocation. |
| 10 | Decision: dryRun? | Decision | DECIDE | Logged here for transparency. Execution path is the same either way; `dryRun` is passed through to the cluster workflow which honors it per FR-21. |
| 11 | Execute: Patch Clusters in Parallel | Action `runWithParallelism` (canvas Action element) | EXECUTE | Calls the reusable Action with `workerWorkflow = WF-02 Patch ESXi Cluster`, `parallelismCap = maxParallelClusters`, `inputBuilder = <Action that builds per-cluster inputs>`. Returns array of `clusterResults`. |
| 12 | Aggregate Results | Scriptable Task | VERIFY | Walks `clusterResults` to compute counts, classify overall `runStatus`, and assemble the `vcenterResult` object. |
| 13 | Compose HTML Report | Scriptable Task (calls Action `composeHtmlRunReport`) | VERIFY | Generate the full HTML report. Stored as `runReportHtml`. |
| 14 | Send Final Email | Scriptable Task (calls Action `sendNotificationEmail`) | VERIFY | Send the run-summary email to all recipients. Records send attempt in `emailsSent`. |
| 15 | Bind Outputs | Scriptable Task | CLEANUP | Bind workflow outputs from `vcenterResult` for VCF Automation visibility. |
| 16 | Log Run Summary | Scriptable Task | CLEANUP | Emit the final audit log lines per FR-31 (and Run Summary block per the system prompt's logging section). |
| 17 | End | (end) | — | Normal completion. |
| **DEH** | Default Error Handler | (error path) | ERROR | Catches any uncaught exception. Calls `releaseAllLocksHeldByWorkflow(wfRunId)`, attempts to send a final intervention email if recipients are known, logs error at FAIL audit level, ends workflow with error. |

**Element count: 16 + DEH = 17.** Above the 8-element guideline from the system prompt — the rationale is that this is the orchestrator workflow with rich pre/post phases, and the heavy lifting is delegated to child workflows. Sub-workflows are not warranted because the structure here is naturally linear; splitting it would just push the same elements into a less visible place.

### 3c.2 `Patch ESXi Cluster` (WF-02) Canvas

**Workflow attributes:**

| Attribute | Type | Purpose |
|---|---|---|
| `wfLogPrefix` | string | `[ESXI-PATCH-CL]` |
| `wfRunId` | string | Captured at startup. |
| `clusterFqdnLabel` | string | Human-readable cluster identifier for logs (`<vcenter>/<clusterName>`). |
| `lockAcquired` | boolean | Tracks lock state for cleanup. |
| `targetHosts` | Array/VcHostSystem | Hosts in scope, ordered alphabetically. |
| `depotPathOnHost` | string | Resolved path the hosts use to read the depot. |
| `stagedFilePath` | string | If `CLUSTER_DATASTORE_STAGE`, the path of the staged copy (for cleanup). |
| `hostResults` | Array/Properties | Per-host results accumulated during iteration. |
| `clusterResult` | Properties | Final result returned to parent. |
| `haltedReason` | string | If cluster halted, the reason. |

**Canvas elements:**

| # | Element | Type | Phase | Function |
|---|---|---|---|---|
| 1 | Start | (start) | — | |
| 2 | Initialize Logging | Scriptable Task | STARTUP | Set log marker (correlates with parent via `parentRunId` in inputs), audit-log cluster start. |
| 3 | Acquire Cluster Lock | Action `acquireClusterPatchLock` (canvas Action element) | AUTH | Acquire `ESXI_PATCH_<vc>_<cluster>` lock. |
| 4 | Decision: Lock Acquired? | Decision | AUTH | If FALSE → branch to "Build Skipped Result" (cluster classified SKIPPED with lock-owner info). |
| 5 | Pre-flight Re-validation | Scriptable Task | VALIDATE | Re-run cheap + full checks. State may have changed since vCenter-level pre-flight. If FAILED → set `haltedReason`, branch to cleanup. |
| 6 | Sort Hosts Alphabetically | Scriptable Task | DISCOVER | Build the `targetHosts` array sorted by hostname per FR-19 ordering. |
| 7 | Resolve Depot Path | Scriptable Task (calls Action `resolveContentLibraryItemPath`) | DISCOVER | Determine the on-disk path of the depot ZIP. |
| 8 | Decision: Staging Mode | Decision | DECIDE | Branch on `patchStagingMode`. |
| 9 | Stage Depot to Cluster Datastore | Scriptable Task (calls Action `findClusterStagingDatastore` then `stageDepotToDatastore`) | EXECUTE | Only on the `CLUSTER_DATASTORE_STAGE` branch. Sets `depotPathOnHost` and `stagedFilePath`. |
| 10 | Use Direct CL Path | Scriptable Task | EXECUTE | The `CONTENT_LIBRARY_DIRECT` branch. Sets `depotPathOnHost` from the resolved CL path. |
| 11 | Process Hosts (Sequential Loop) | Foreach element | EXECUTE | For each host in `targetHosts`, call WF-03 Patch ESXi Host **synchronously**. Capture each result into `hostResults`. **Halt-on-failure logic** is implemented within the loop body: after each child returns, check outcome; if FAILED, break the loop. |
| 12 | Aggregate Cluster Result | Scriptable Task (calls Action `buildClusterResultProperties`) | VERIFY | Compute counts, set `outcome`, assemble `clusterResult`. |
| 13 | Cleanup Staged Depot | Scriptable Task (calls Action `cleanupStagedDepot`) | CLEANUP | Best-effort cleanup. Skipped on `CONTENT_LIBRARY_DIRECT` mode. |
| 14 | Release Cluster Lock | Action `releaseClusterPatchLock` (canvas Action element) | CLEANUP | Release the lock. |
| 15 | Log Cluster Summary | Scriptable Task | CLEANUP | Audit log per FR-31. |
| 16 | End | (end) | — | Returns `clusterResult` to parent. |
| **DEH** | Default Error Handler | (error path) | ERROR | Releases lock if held, cleans up staged depot if staged, logs error, builds a FAILED `clusterResult` and **returns normally** (does not rethrow — per AD-07 error propagation). The exception is caught here so the parent gets a structured result. The exception is preserved in the result's `failureReason` field. |

The `Process Hosts` Foreach element is the heart of the workflow. Inside the loop body:

```
For each host in targetHosts:
    1. Call WF-03 Patch ESXi Host (synchronous)
    2. Append result to hostResults
    3. If result.outcome == FAILED:
        - Set haltedReason = "Host <hostFqdn> failed at <failurePhase>"
        - Break loop
    4. If result.outcome == SUCCESS or DRY_RUN: continue
```

Implementation note: vRO's Foreach element doesn't natively support "break on condition." The pattern is to wrap the foreach in a Scriptable Task that uses a `while` loop or to use a "Foreach Item" sub-workflow that checks a flag attribute set by the worker. Phase 4 will pick the cleanest approach — likely an explicit `while` loop in a Scriptable Task that calls WF-03 directly, since this gives the cleanest break semantics.

### 3c.3 `Patch ESXi Host` (WF-03) Canvas

**Workflow attributes:**

| Attribute | Type | Purpose |
|---|---|---|
| `wfLogPrefix` | string | `[ESXI-PATCH-HOST]` |
| `wfRunId` | string | Captured at startup. |
| `hostFqdnLabel` | string | Human-readable host identifier for logs. |
| `preBuild` | string | Captured before patching. |
| `postBuild` | string | Captured after patching. |
| `sshWasEnabledByUs` | boolean | Tracks whether we enabled SSH (so cleanup can disable it). |
| `mmEnteredByUs` | boolean | Tracks whether we entered MM (so cleanup can exit it). |
| `failurePhase` | string | If failed, which phase. |
| `failureReason` | string | If failed, human-readable reason. |
| `interventionEmailSentAt` | Date | If intervention email was sent, when. |
| `runStartTime` | Date | |
| `hostResult` | Properties | Final result returned to parent. |

**Canvas elements (this workflow has the most phases — it implements the actual KB procedure):**

| # | Element | Type | Phase | Function |
|---|---|---|---|---|
| 1 | Start | (start) | — | |
| 2 | Initialize Logging | Scriptable Task | STARTUP | Log marker, audit start, capture `runStartTime`. |
| 3 | Capture Pre-Patch Build | Scriptable Task (calls Action `getHostBuildNumber`) | DISCOVER | Records `preBuild` for later comparison. |
| 4 | Pre-MM Check: Other Host in MM? | Scriptable Task (calls Action `verifyClusterHasNoOtherHostsInMM`) | VALIDATE | Per FR-19 step 1. If another host is in MM → set failurePhase=`MM_ENTER`, failureReason="Another host already in MM", branch to cleanup. |
| 5 | Decision: Cluster Clean? | Decision | VALIDATE | Branch on the check result. |
| 6 | Enable SSH | Action `setHostSshServiceState` (canvas Action element, enabled=true) | EXECUTE | Per FR-19 step 2. Sets `sshWasEnabledByUs = true`. |
| 7 | Decision: SSH Enable Successful? | Decision | EXECUTE | If FALSE → set failurePhase=`SSH_ENABLE`, branch to cleanup. |
| 8 | Enter Maintenance Mode | Action `enterMaintenanceModeEnsureAccessibility` (canvas Action element) | EXECUTE | Per FR-19 step 3. Sets `mmEnteredByUs = true`. |
| 9 | Decision: MM Entry Successful? | Decision | EXECUTE | If FALSE → set failurePhase=`MM_ENTER`, branch to cleanup. |
| 10 | List Patch Profiles | Action `runEsxcliProfileList` (canvas Action element) | EXECUTE | Per FR-19 step 4. Identifies `-standard` profile. |
| 11 | Decision: Profile Listed? | Decision | EXECUTE | If FALSE → set failurePhase=`PATCH_LIST`, branch to cleanup. |
| 12 | Decision: dryRun? | Decision | DECIDE | If TRUE → skip steps 13-17 (the actual patch+reboot+verify cycle), classify outcome=`DRY_RUN`, branch to cleanup. |
| 13 | Install Patch | Action `runEsxcliProfileUpdate` (canvas Action element) | EXECUTE | Per FR-19 step 5. |
| 14 | Decision: Install Successful? | Decision | EXECUTE | If FALSE → set failurePhase=`PATCH_INSTALL`, branch to cleanup. |
| 15 | Reboot and Wait | Action `rebootHostAndWaitReconnect` (canvas Action element) | EXECUTE | Per FR-19 steps 6-7. |
| 16 | Decision: Reconnected? | Decision | EXECUTE | If FALSE → set failurePhase=`RECONNECT`, branch to **intervention email** sub-flow then cleanup (this is the canonical "needs manual recovery" failure mode). |
| 17 | Verify Build Changed | Scriptable Task (calls Actions `getHostBuildNumber` then `verifyHostBuildChanged`) | VERIFY | Per FR-19 step 8. |
| 18 | Decision: Build Changed? | Decision | VERIFY | If FALSE → set failurePhase=`VERIFY_BUILD`, branch to intervention email + cleanup. |
| 19 | Mark Outcome SUCCESS | Scriptable Task | VERIFY | If we reach here, the patch worked. |
| 20 | Cleanup: Exit MM | Scriptable Task (calls Action `exitMaintenanceMode`) | CLEANUP | Conditional on `mmEnteredByUs = true`. Always attempted (best effort). |
| 21 | Cleanup: Disable SSH | Scriptable Task (calls Action `setHostSshServiceState`, enabled=false) | CLEANUP | Conditional on `sshWasEnabledByUs = true`. Always attempted (best effort). |
| 22 | Send Intervention Email (Conditional) | Scriptable Task (calls Action `composeInterventionEmailHtml` then `sendNotificationEmail`) | CLEANUP | Sent only when `failurePhase` is `RECONNECT` or `VERIFY_BUILD` (the two cases requiring manual recovery). For `MM_ENTER`, `SSH_ENABLE`, `PATCH_LIST`, `PATCH_INSTALL`, the host is in a recoverable state (not in MM, or in MM but no patch attempted) and the cluster halt is sufficient. |
| 23 | Build Host Result | Scriptable Task (calls Action `buildHostResultProperties`) | CLEANUP | Assemble `hostResult`. |
| 24 | Log Host Summary | Scriptable Task | CLEANUP | Audit log per FR-31. |
| 25 | End | (end) | — | Returns `hostResult` to parent. |
| **DEH** | Default Error Handler | (error path) | ERROR | Best-effort cleanup (exit MM if entered, disable SSH if enabled), capture exception in failureReason, build a FAILED hostResult, **return normally**. The cluster workflow above will see the FAILED result and halt the cluster. |

**Element count: 24 + DEH = 25.** This is a deliberately detailed workflow because it's implementing the KB step-by-step. Every step gets explicit visibility on the canvas. The architect reviewing this code can read the canvas and see the exact KB procedure mapped 1:1.

### 3c.4 `Validate ESXi Patching Prerequisites` (WF-04) Canvas

A simplified read-only version of WF-01's Discover/Decide phases. Same input form (sans Acknowledgement and Notification sections), same pre-flight Actions, output is a Properties object with per-cluster pass/fail/warn classification and a human-readable HTML report. No locking, no execution, no children invoked.

Element count: ~8. Phase 4 will produce the full canvas spec.

### 3c.5 `Release ESXi Patch Locks` (WF-05) Canvas

Admin utility. Inputs: `vcenter` (single, optional), `clusterMoRef` (string, optional), `confirm` (boolean, must be true). If `vcenter` and `clusterMoRef` are both provided, releases that specific lock. If only `vcenter` is provided, releases all `ESXI_PATCH_<vcenter-fqdn>_*` locks. If neither provided, requires explicit `releaseAll = true` flag and releases everything matching `ESXI_PATCH_*`. Logs every release at audit level.

Element count: ~6.

---

## 3d — Module Path Naming Convention

All Actions follow the system prompt's pattern:

```
com.<company>.library.<system>.<category>
```

Adapted for the architect's namespace (`com.broadcom.pso.*`):

| Module Path | Contents |
|---|---|
| `com.broadcom.pso.common.logging` | Reusable logging Actions (initWorkflowLogging, debugLog, auditLog). |
| `com.broadcom.pso.common.workflow` | Reusable workflow utility Actions (runWithParallelism, releaseAllLocksHeldByWorkflow). |
| `com.broadcom.pso.common.config` | Reusable Configuration Element accessor Actions. |
| `com.broadcom.pso.vc.esxi.patching.form` | Form-time external-value Actions (vCenter, cluster, depot pickers). |
| `com.broadcom.pso.vc.esxi.patching.detect` | Cluster type identification. |
| `com.broadcom.pso.vc.esxi.patching.preflight` | Pre-flight gate Actions. |
| `com.broadcom.pso.vc.esxi.patching.staging` | Patch staging Actions (CL resolution, datastore copy/cleanup). |
| `com.broadcom.pso.vc.esxi.patching.credentials` | SSH credential retrieval. |
| `com.broadcom.pso.vc.esxi.patching.host` | Per-host operations (MM enter/exit, SSH service, esxcli, reboot, verify). |
| `com.broadcom.pso.vc.esxi.patching.locking` | Cluster-scope lock Actions. |
| `com.broadcom.pso.vc.esxi.patching.results` | Result-object construction Actions. |
| `com.broadcom.pso.vc.esxi.patching.report` | HTML report generation and email send Actions. |

The convention reads `com.broadcom.pso.<system>.<category>` where:
- `<system>` is the target system or domain (`common` for cross-cutting, `vc.esxi.patching` for this project).
- `<category>` is the functional category within the system.

Workflows live in folders, not module paths:

| Folder Path | Workflow |
|---|---|
| `Library/PSO/ESXi Patching/` | WF-01 Patch ESXi vCenter, WF-04 Validate ESXi Patching Prerequisites |
| `Library/PSO/ESXi Patching/Internal/` | WF-02 Patch ESXi Cluster, WF-03 Patch ESXi Host |
| `Library/PSO/ESXi Patching/Operations/` | WF-05 Release ESXi Patch Locks |

---

## 3e — Text-Based Canvas Diagrams

### WF-01 Patch ESXi vCenter

```
[Start]
   │
   ▼
[Initialize Logging] ─────► [Validate Inputs]
                                │
                                ▼
                       (Decision: Acknowledged?)
                          │NO         │YES
                          │           │
                          ▼           ▼
                       [End w/    [Resolve SMTP Host]
                        Error]        │
                                      ▼
                       [Pre-flight: Identify VxRail Clusters]
                                      │
                                      ▼
                       [Pre-flight: Full Health Checks]
                                      │
                                      ▼
                       (Decision: Any clusters eligible?)
                          │NO                      │YES
                          │                        │
                          ▼                        ▼
                  [Send No-Op Email]      [Build Cluster Work Items]
                          │                        │
                          ▼                        ▼
                  [Bind Outputs]          (Decision: dryRun? — informational)
                          │                        │
                          ▼                        ▼
                       [End]              ╔════════════════════════════╗
                                          ║ Action: runWithParallelism ║
                                          ║ Worker: WF-02 Cluster      ║
                                          ║ Cap: maxParallelClusters   ║
                                          ╚════════════════════════════╝
                                                   │
                                                   ▼
                                          [Aggregate Results]
                                                   │
                                                   ▼
                                          [Compose HTML Report]
                                                   │
                                                   ▼
                                          [Send Final Email]
                                                   │
                                                   ▼
                                          [Bind Outputs]
                                                   │
                                                   ▼
                                          [Log Run Summary]
                                                   │
                                                   ▼
                                                 [End]

(Default Error Handler) ◄── any uncaught exception from above ──
   │
   ▼
[Release Locks Held] ─► [Send Best-Effort Intervention Email] ─► [End w/ Error]
```

### WF-02 Patch ESXi Cluster

```
[Start]
   │
   ▼
[Initialize Logging]
   │
   ▼
[Action: acquireClusterPatchLock]
   │
   ▼
(Decision: Lock acquired?)
   │NO                  │YES
   ▼                    ▼
[Build Skipped     [Pre-flight Re-validation]
 Result]               │
   │                   ▼
   ▼            (Decision: Pre-flight passed?)
[End]              │NO            │YES
                   ▼              ▼
            [Set haltedReason]  [Sort Hosts Alphabetically]
                   │              │
                   ▼              ▼
            [Aggregate     [Resolve Depot Path]
             Cluster              │
             Result]              ▼
                   │       (Decision: Staging Mode)
                   ▼          │DIRECT       │STAGE
            [Release Lock]     ▼             ▼
                   │      [Use Direct  [Stage Depot to
                   ▼       CL Path]    Cluster Datastore]
                [End]          │             │
                               └─────┬───────┘
                                     │
                                     ▼
                          [Process Hosts Loop]
                          (sequential, halt-on-failure)
                          ┌─────────────────────┐
                          │ For each host:       │
                          │   Call WF-03 (sync)  │
                          │   Append result      │
                          │   If FAILED: break   │
                          └─────────────────────┘
                                     │
                                     ▼
                          [Aggregate Cluster Result]
                                     │
                                     ▼
                          [Cleanup Staged Depot]
                                     │
                                     ▼
                          [Action: releaseClusterPatchLock]
                                     │
                                     ▼
                          [Log Cluster Summary]
                                     │
                                     ▼
                                   [End]

(Default Error Handler) ◄── uncaught exception ──
   │
   ▼
[Best-Effort Cleanup: Release Lock + Cleanup Staged Depot] ─► [Build FAILED Result] ─► [End normally]
```

### WF-03 Patch ESXi Host (the heart of the procedure)

```
[Start]
   │
   ▼
[Initialize Logging]
   │
   ▼
[Capture Pre-Patch Build]
   │
   ▼
[Pre-MM Check: Other Host in MM?]
   │
   ▼
(Decision: Cluster clean?)
   │NO                  │YES
   ▼                    ▼
[failurePhase =    [Action: setHostSshServiceState (enable)]
 MM_ENTER]              │
   │                    ▼
   │              (Decision: SSH enabled?)
   │                 │NO            │YES
   │                 ▼              ▼
   │            [failurePhase = [Action: enterMaintenanceMode
   │             SSH_ENABLE]    EnsureAccessibility]
   │                 │              │
   │                 │              ▼
   │                 │        (Decision: MM entered?)
   │                 │           │NO            │YES
   │                 │           ▼              ▼
   │                 │      [failurePhase = [Action: runEsxcliProfileList]
   │                 │       MM_ENTER]            │
   │                 │           │                ▼
   │                 │           │          (Decision: Profile listed?)
   │                 │           │             │NO          │YES
   │                 │           │             ▼            ▼
   │                 │           │        [failurePhase  (Decision: dryRun?)
   │                 │           │         = PATCH_LIST]   │YES        │NO
   │                 │           │             │           ▼           ▼
   │                 │           │             │         [Mark      [Action: runEsxcli
   │                 │           │             │         outcome=   ProfileUpdate]
   │                 │           │             │         DRY_RUN]      │
   │                 │           │             │           │           ▼
   │                 │           │             │           │     (Decision: Install OK?)
   │                 │           │             │           │       │NO       │YES
   │                 │           │             │           │       ▼         ▼
   │                 │           │             │           │  [failurePhase [Action: rebootAnd
   │                 │           │             │           │   = PATCH_     WaitReconnect]
   │                 │           │             │           │    INSTALL]      │
   │                 │           │             │           │       │          ▼
   │                 │           │             │           │       │    (Decision: Reconnected?)
   │                 │           │             │           │       │      │NO       │YES
   │                 │           │             │           │       │      ▼         ▼
   │                 │           │             │           │       │ [failurePhase [Verify Build
   │                 │           │             │           │       │  = RECONNECT]  Changed]
   │                 │           │             │           │       │      │            │
   │                 │           │             │           │       │      │            ▼
   │                 │           │             │           │       │      │     (Decision: Changed?)
   │                 │           │             │           │       │      │       │NO      │YES
   │                 │           │             │           │       │      │       ▼        ▼
   │                 │           │             │           │       │      │  [failurePhase [Mark
   │                 │           │             │           │       │      │   = VERIFY_     outcome=
   │                 │           │             │           │       │      │   BUILD]       SUCCESS]
   │                 │           │             │           │       │      │       │        │
   ▼                 ▼           ▼             ▼           ▼       ▼      ▼       ▼        ▼
                                  ┌─── all converge to ──────────────────────────────────────┐
                                  │                                                            │
                                  ▼                                                            ▼
                          [Cleanup: Exit MM (if entered)]                          [Cleanup: Exit MM]
                                  │                                                            │
                                  ▼                                                            ▼
                          [Cleanup: Disable SSH (if enabled)]                       [Cleanup: Disable SSH]
                                  │                                                            │
                                  ▼                                                            ▼
                          (Decision: Send Intervention Email?)
                          (TRUE only if failurePhase ∈ {RECONNECT, VERIFY_BUILD})
                                  │YES         │NO
                                  ▼            ▼
                          [Send Intervention Email]
                                  │            │
                                  └────┬───────┘
                                       ▼
                              [Build Host Result]
                                       │
                                       ▼
                              [Log Host Summary]
                                       │
                                       ▼
                                     [End]

(Default Error Handler) ◄── any uncaught exception ──
   │
   ▼
[Best-Effort Cleanup: Exit MM if entered, Disable SSH if enabled] ─► [Build FAILED Result with Exception Detail] ─► [End normally]
```

This canvas is dense — by design. Every KB step has its own visible canvas element, every failure path has its own visible decision. The architect can verify KB compliance by walking the canvas top-to-bottom.

---

## 3f — Configuration Element Schemas (Detail)

### CE-01: `PSO/ESXi Patching/Settings`

**Type:** Standard Configuration Element. Non-secret values.

| Attribute | Type | Default | Description |
|---|---|---|---|
| `esxiPatchContentLibraryName` | string | `ESXi-Patches` | Name of the Content Library to filter for patch depots (FR-10, C-09). |
| `defaultMaxParallelClusters` | number | 3 | Default for the form's `maxParallelClusters` input (FR-12). |
| `defaultHostRebootTimeoutMinutes` | number | 25 | Default for the form's `hostRebootTimeoutMinutes` input (FR-12, C-10). |
| `notificationFixedCcList` | Array/string | `[]` (empty) | Fixed cc list for all notification emails (FR-13, C-07). Empty = operator-supplied recipients only. |
| `interventionEmailSubjectPrefix` | string | `[ACTION REQUIRED]` | Prefix for intervention email subject lines (FR-36). |
| `runReportWorkflowDocumentationUrl` | string | (empty) | Optional URL to internal documentation, included in email footer. |
| `defaultPatchStagingMode` | string | `CONTENT_LIBRARY_DIRECT` | Default for the staging-mode form input (FR-11, C-01). |

### CE-02: `PSO/ESXi Patching/Credentials/<vcenter-fqdn>`

**Type:** Configuration Element with encrypted attributes. **One CE per vCenter.**

The path includes the vCenter FQDN (e.g., `PSO/ESXi Patching/Credentials/vcenter01.example.com`) so credentials are scoped per vCenter. Within each CE, attributes are keyed by cluster MoRef.

| Attribute Name | Type | Encrypted? | Description |
|---|---|---|---|
| `<cluster-moref>` (e.g., `domain-c123`) | Properties | YES | `{ sshUsername: string, sshPassword: SecureString }`. One attribute per cluster. **Pending C-05** — schema may shift to per-host if customer requires. |

**Naming convention:** Attribute names are the cluster MoRef (not name) because MoRefs are stable and unique while cluster names can be renamed. The `getEsxiSshCredentials` Action reads by `(vcenterFqdn, clusterMoRef)` and converts to the CE path + attribute name.

**Migration path if C-05 returns "per-host":** Attribute name pattern changes from `<cluster-moref>` to `<host-moref>` (or `<host-fqdn>`). Code change is isolated to the `getEsxiSshCredentials` Action.

### CE-03: `PSO/ESXi Patching/SmtpReference`

**Type:** Standard Configuration Element. Non-secret.

| Attribute | Type | Default | Description |
|---|---|---|---|
| `smtpHostName` | string | (empty) | Name of the `Mail:SMTPClient` inventory record to use. Empty = use the first one found via `Server.findAllForType`. |

---

## 3g — Cross-Cutting Design Patterns

### 3g.1 Locking Pattern

**Lock name format:** `ESXI_PATCH_<vcenter-fqdn>_<cluster-moref>`

Example: `ESXI_PATCH_vcenter01.example.com_domain-c123`

**Acquisition pattern (Action `acquireClusterPatchLock`):**

```
LockingSystem.lockAndWaitForOwnership(lockName, ownerRunId, timeoutMs)
```

Where `ownerRunId` is the `Patch ESXi Cluster` workflow's run ID and `timeoutMs` is small (e.g., 5 seconds). If the call times out → return `{acquired: false, lockOwnerRunId: <other run>}` rather than throw. The caller decides what to do (cluster classified SKIPPED).

**Release pattern (Action `releaseClusterPatchLock`):**

```
LockingSystem.unlock(lockName, ownerRunId)
```

Always called from the cleanup path AND the default error handler.

**Orphan cleanup:** WF-05 enumerates locks via `LockingSystem.retrieveAll()` (verified — see Section 3h), filters by name pattern, and unlocks each one with a forced ownership claim.

### 3g.2 Error Propagation Pattern (per AD-07)

**The rule:** Child workflows catch known failures and return them as `outcome=FAILED` results. Only truly unexpected exceptions propagate up as exceptions.

**Implementation in WF-02 and WF-03:** The default error handler (DEH) on the canvas catches any uncaught exception. The DEH:

1. Performs best-effort cleanup (release lock, exit MM, disable SSH, etc., as appropriate to the layer).
2. Logs the exception at FAIL audit level with full stack trace.
3. Builds a structured FAILED result with the exception's message in `failureReason`.
4. **Returns normally** (does not rethrow). The parent receives the FAILED result and proceeds with normal flow control.

**The parent's view:** The parent never has to wrap child invocations in try/catch. It just reads `outcome` from the result and branches accordingly.

**The exception:** WF-01 (the top workflow) does NOT catch exceptions in its DEH — instead, it re-throws after cleanup, ending the workflow with error. This is because at the top layer there's no parent to absorb a structured FAILED result; VCF Automation needs to see the workflow ended in error to flag the deployment as failed.

### 3g.3 Logging Pattern

**Marker setup (every workflow's first task):**

```javascript
var wfName = workflow.name;
var wfRunId = workflow.id;
var marker = "WorkflowName:" + wfName + " WorkflowRunId:" + wfRunId;
System.setLogMarker(marker);
System.log("WorkflowStart:" + marker);
System.getModule("com.broadcom.pso.common.logging").initWorkflowLogging(wfLogPrefix);
```

**Audit log format:**

```
[<PREFIX>] [<PHASE>] [<STATUS>] <message>
```

Where `<PREFIX>` is `[ESXI-PATCH-VC]`, `[ESXI-PATCH-CL]`, or `[ESXI-PATCH-HOST]` depending on layer.

**Debug log gating:**

```javascript
System.getModule("com.broadcom.pso.common.logging").debugLog(
    wfLogPrefix, "DISCOVER", "OK",
    "Cluster MoRef=" + clusterMoRef + " hostCount=" + hosts.length,
    debugLogging
);
```

When `debugLogging = false`, the function is a no-op. When `true`, it logs at the same structured format as audit lines but adds `[DEBUG]` to the message body.

**Run summary emission (per FR-31, last task in WF-01):** Per the system prompt's logging template, with run ID, outcome, dryRun flag, counts, and explicit `===== END SUMMARY =====` markers for log grep-ability.

### 3g.4 Result Object Construction

All result objects are constructed by dedicated Actions (`buildHostResultProperties`, `buildClusterResultProperties`, `buildVcenterResultProperties`) so the schema is centralized. This makes it easy to add a new field — change one Action and rebuild — and prevents subtle schema drift between layers.

The result objects are `Properties` objects. Nested arrays of Properties (`hostResults` inside cluster, `clusterResults` inside vCenter) work natively in Rhino JavaScript.

### 3g.5 SSH Plugin Usage Pattern

The vRO SSH plugin's `SSHSession` class is used for `runEsxcliProfileList` and `runEsxcliProfileUpdate`. The pattern:

```javascript
var session = null;
try {
    session = new SSHSession(host.config.network.dnsConfig.hostName, 22);
    session.connectWithPassword(sshUsername, sshPassword);
    session.executeCommand(command, true); // true = throwOnError disabled; we inspect exitCode
    var result = new Properties();
    result.put("exitCode", session.exitCode);
    result.put("stdout", session.output);
    result.put("stderr", session.error);
    return result;
} finally {
    if (session !== null) {
        try { session.disconnect(); } catch (e) { /* ignore */ }
    }
}
```

**Important:** SSH host key verification is NOT performed (the procedure runs immediately after enabling SSH — the host key may be new and not in any known_hosts file). This is a calculated trade-off; the security boundary is the encrypted credential and the brief SSH window, not host key pinning.

### 3g.6 Idempotency Pattern (NFR-10)

Before entering MM, `Patch ESXi Host` calls `getHostBuildNumber` and compares against the build extracted from the depot ZIP filename (e.g., `VMware-ESXi-8.0U2d-24585300-depot.zip` → build `24585300`). If `host.config.product.build === expectedBuild`, the host is classified `SKIPPED` with reason "Already at target build" — MM is not entered, esxcli is not run.

This pattern enables safe re-runs after partial failures.

---

## 3h — Verified API References and Unverified Items

### 3h.1 Verified during Phase 3 design

| API / Pattern | Verification source | Status |
|---|---|---|
| VxRail cluster detection via `VxRail-IP` Custom Attribute on the cluster | Dell community post documented this technique with PowerCLI script. The same data is accessible via vCenter SDK as `cluster.customValue` array; entries with name field starting `VxRail` indicate VxRail-managed. | VERIFIED (best practice, customer-confirmed pattern) |
| VCF Automation custom form Multi-Value Picker with external-value action | Broadcom techdocs documents that Multi-Value Picker supports an Orchestrator action returning `Array/Properties` with `label` and `value` keys. | VERIFIED |
| VCF Automation form-time external actions are gated by dependency-field validity | Broadcom techdocs and VMware blog explicitly document this behavior. | VERIFIED — has implications for our form design (the cluster picker won't populate until vCenter is selected, which is desired). |
| `LockingSystem.lockAndWaitForOwnership` and `LockingSystem.unlock` are vRO platform APIs | vRO 9.x platform documentation (long-standing API). | VERIFIED |
| `LockingSystem.retrieveAll()` for orphan-lock enumeration | vRO 9.x platform documentation. | VERIFIED |
| `Workflow.executeAsync()` and `WorkflowToken.waitState()` | vRO 9.x platform documentation. | VERIFIED |
| `host.configManager.serviceSystem.startService("TSM-SSH")` and `.stopService("TSM-SSH")` | vCenter SDK documentation; service key `TSM-SSH` is the standard ESXi SSH service identifier. | VERIFIED |
| `host.enterMaintenanceMode_Task(timeout, evacuatePoweredOffVms, maintenanceSpec)` with `vsanMode = ensureObjectAccessibility` | vCenter SDK documentation. The `HostMaintenanceSpec.vsanMode.objectAction = ensureObjectAccessibility` setting is the correct one for KB 000345284's "Ensure Accessibility" option. | VERIFIED |
| `cluster.customValue` Array access pattern for reading custom attributes | vCenter SDK documentation. | VERIFIED |

### 3h.2 Unverified — flagged for Phase 4 verification

| Item | Why unverified | Phase 4 action |
|---|---|---|
| `cluster.configurationEx.vsanConfigInfo.enabled` exact path | Path may have changed across vSphere SDK versions. | Verify against current vSphere 8.x SDK reference before generating `identifyClusterType` code. |
| `host.config.product.build` exact field name | Confident this is correct but should verify against vSphere 8.x SDK to make sure it hasn't been deprecated for `productLineId` or similar. | Verify in Phase 4. |
| esxcli output parsing — exact string format of "Update Result" / "VIBs Installed" lines | Format has been stable across ESXi versions but the exact regex needs validation against actual ESXi 8.x output. | Phase 4: validate parsing against captured output samples or use `--formatter=json` if available on ESXi 8.x. |
| PowerFlex SDC VIB detection (for the `identifyClusterType` Action's PowerFlex branch) | Approach is to query `host.configManager.imageConfigManager` for installed VIBs and look for the SDC VIB name. The exact VIB name pattern (`scaleio-sdc`, `vmware-esx-scaleio-sdc`, etc.) needs verification. | Phase 4: verify against PowerFlex 4.x documentation. Marked `// UNVERIFIED — architect review required` in code. |
| `FileManager.copyDatastoreFile_Task` exact signature for cross-datastore copy | API exists; signature variants exist across SDK versions. | Phase 4: verify against current SDK and test with a sample copy. |
| VxRail Manager extension namespace (used as a secondary signal in `identifyClusterType` for robustness) | The vCenter extension key for VxRail Manager has varied across VxRail versions (`com.vmware.vxrail`, `com.dellemc.vxrail`, etc.). | Phase 4: test in customer environment to determine the actual extension key, or rely solely on the custom-attribute-based detection (which is verified). |

### 3h.3 Items deliberately not verified (out-of-scope verifications)

- **VCF Automation Deployment REST API for self-delete (Pattern A).** Not used per AD-07 / C-11 (Pattern B selected). No verification needed.
- **CyberArk CCP integration.** Out of scope per AD-05 / C-08.
- **Cross-major-version ESXi upgrade procedures.** Out of scope per AD-01 / EX-03 / C-14.

---

## Document control

**Status:** DRAFT — pending architect approval.

**On approval, this document moves to APPROVED status and Phase 4 (Code Generation) begins.**

**Pending customer responses (tracked in companion file) do not block architect review of this design document. Architect review is encouraged in parallel with customer follow-up.** When customer responses arrive, the affected sections will be updated:
- C-01 (CL backing) → Section 3b.3 staging Actions, Section 3c.2 Cluster canvas, Section 3f CE-01.
- C-03 (SSH policy) → Section 3c.3 Host canvas (no change to design, possible documentation note).
- C-05 (credentials scheme) → Section 3f CE-02 schema.
- C-06 (validation workflow) → Section 3b.1 (drop WF-04 if no), Section 3c.4.
- C-07 (cc list) → Section 3f CE-01 default.
- C-09 (CL name) → Section 3f CE-01 default.
- C-10 (reboot timeout) → Section 3f CE-01 default.
- C-14 (within-major-version) → no design change unless they say cross-major is needed.

