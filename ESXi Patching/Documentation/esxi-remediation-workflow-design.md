# vSphere Environment Remediation Workflow — Design Document (Phase 3)

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail)
> **Document version:** 2.0 (consolidated post-reconcile)
> **Date:** 2026-05-05
> **Companion documents:** `esxi-remediation-workflow-open-items.md`, `esxi-remediation-workflow-requirements.md`

---

## How to read this document

Structured per the system prompt's Phase 3 specification:
- **3a** — Scripting runtime selection.
- **3b** — Workflow and Action element inventory.
- **3c** — Workflow canvas layouts with phase decomposition.
- **3d** — Module path and folder path naming conventions.
- **3e** — Text-based canvas diagrams.
- **3f** — Configuration Element schemas.
- **3g** — Cross-cutting design patterns.
- **3h** — Verified API references and unverified items.

---

## 3a — Scripting Runtime Recommendation

**Primary recommendation: JavaScript (Rhino) for all workflows and Actions.**

Reasoning:
1. Plugin-first principle — extensive use of vCenter plugin objects (`VcSdkConnection`, `VcClusterComputeResource`, `VcHostSystem`, `VcHostServiceSystem`, `VcContentLibraryItem`, `VcDatastore`, `VcFileManager`, `VcHostLocalAccountManager`, `VcAuthorizationManager`, etc.). JavaScript is the only runtime with direct access.
2. SSH plugin (`SSHSession`) is JavaScript-native.
3. `LockingSystem` is JavaScript-native.
4. Mail plugin actions are JavaScript-native.
5. Workflow execution APIs (`executeAsync`, `WorkflowToken.waitState`, `Server.getWorkflowTokenById`) are JavaScript-only.
6. No data-processing complexity that justifies Python.
7. PowerCLI not required.

**Custom scripting environment requirement: None.**

**Rhino constraints (no ES6+):** Use `var` only. No arrow functions. No template literals. No Promise/async/await. No Map/Set. No spread operator. No default parameter values. No `Array.prototype.includes/find/findIndex`. All Phase 4 code conforms.

---

## 3b — Workflow and Action Element Inventory

### 3b.1 Workflow Inventory (7 workflows)

| # | Workflow Name | Folder | Layer / Type | Catalog Item |
|---|---|---|---|---|
| WF-01 | Remediate vSphere Environment | `Library/PSO/vCenter/ESXi/Remediation/` | Layer 1 (top) | YES |
| WF-02 | Remediate vSphere Cluster | `Library/PSO/vCenter/ESXi/Remediation/Internal/` | Layer 2 (middle) | NO |
| WF-03 | Remediate ESX Host | `Library/PSO/vCenter/ESXi/Remediation/Internal/` | Layer 3 (bottom) | NO |
| WF-04 | Validate vSphere Environment Remediation Prerequisites | `Library/PSO/vCenter/ESXi/Remediation/` | Sibling utility | YES (per C-06) |
| WF-05 | Release Cluster Remediation Locks | `Library/PSO/vCenter/ESXi/Remediation/Operations/` | Auxiliary admin | NO |
| WF-06 | Cleanup Orphan Remediation Accounts | `Library/PSO/vCenter/ESXi/Remediation/Operations/` | Auxiliary admin | NO |
| WF-07 | Reconcile Crashed Remediation Runs | `Library/PSO/vCenter/ESXi/Remediation/Operations/` | Scheduled reconciliation | NO (scheduled) |

### 3b.2 Reusable Library Actions (`com.broadcom.pso.common.*`)

| Module Path | Action | Inputs | Returns | Purpose |
|---|---|---|---|---|
| `com.broadcom.pso.common.logging` | `initWorkflowLogging` | `prefix: string` | `void` | Log marker setup + WorkflowStart audit log. |
| `com.broadcom.pso.common.logging` | `auditLog` | `prefix, phase, status, message: string` | `void` | Structured audit log line. Always emitted. |
| `com.broadcom.pso.common.logging` | `debugLog` | `prefix, phase, status, message, debugEnabled` | `void` | Gated debug log. No-op when `debugEnabled = false`. |
| `com.broadcom.pso.common.workflow` | `runWithParallelism` | `workItems: Array/Properties`, `workerWorkflow: Workflow`, `inputBuilderActionName: string`, `parallelismCap: number`, `pollIntervalSeconds: number` | `Array/Properties` | Async fan-out with bounded parallelism, asymmetric scheduling. |
| `com.broadcom.pso.common.workflow` | `releaseAllLocksHeldByWorkflow` | `workflowRunId: string` | `number` | Releases all `LockingSystem` locks owned by a run. DEH cleanup. |
| `com.broadcom.pso.common.workflow` | `withRetry` | `actionName: string`, `actionInputs: Properties`, `maxAttempts: number`, `backoffMs: number` | `any` | Retry-with-exponential-backoff wrapper for vCenter SDK calls. |
| `com.broadcom.pso.common.config` | `getConfigurationElementValue` | `pathOrName, attributeName: string` | `any` | Standard CE attribute accessor. |
| `com.broadcom.pso.common.config` | `getEncryptedConfigurationElementValue` | `pathOrName, attributeName: string` | `SecureString` | Encrypted CE attribute accessor. |

### 3b.3 Project-Specific Actions (`com.broadcom.pso.vc.esxi.remediation.*`)

#### `.form` — Form-time external-value Actions

| Action | Purpose |
|---|---|
| `getRegisteredVcenters` | Lists `VC:SdkConnection` inventory connections. |
| `getDepotItemsForVcenter` | Lists CL items matching name pattern in named CL. Per C-09 substring match. |
| `getClustersForVcenterAndPatch` | Lists clusters in selected vCenter with type+health labels (per FR-09) AND patch-version-aware decorations (per C-12 architect direction). |
| `buildClusterValidationSummary` | Aggregates form-time pre-flight checks across selected clusters into the multi-line summary text per FR-12. |
| `buildReviewSectionSummary` | Generates Section 7's read-only summary content (all form values regardless of defaults). |

#### `.detect` — Cluster type identification

| Action | Purpose |
|---|---|
| `identifyClusterType` | Classifies cluster as `VXRAIL` / `POWERFLEX` / `VSAN-ONLY` / `OTHER`. VxRail detection: `VxRail-IP` custom attribute present. PowerFlex: SDC VIB enumeration on hosts. Callers needing a VxRail boolean compare the result directly to `"VXRAIL"`. |
| `getClusterCustomAttributes` | Reads custom attributes on a cluster object. |

#### `.preflight` — Pre-flight gate Actions

| Action | Purpose |
|---|---|
| `evaluateClusterPreflightCheap` | Form-time check: cluster type, size policy, ESXi 8.x verification, HA, DRS, host states. |
| `evaluateClusterPreflightFull` | Workflow-start-time check: cheap checks + vSAN resync + recent task analysis. |
| `verifyAllHostsOn8x` | Pre-flight gate per C-14. Refuses cluster if any host is on pre-8.0 ESXi. |
| `checkClusterHaHealth` | HA-specific evaluation. |
| `checkClusterDrsHealth` | DRS-specific evaluation. |
| `checkClusterHostsHealthy` | Host connection state evaluation. |
| `checkVsanResyncIdle` | Active vSAN resync detection. |
| `checkClusterRecentTaskActivity` | Heuristic VxRail Manager / vLCM activity check. |
| `checkVsanHealth` | vSAN health check with `groupsToCheck` parameter. Caller passes the curated subset (per CE-01 `vsanHealthGroupsCurated`) by default, or the full list when `showAllVsanHealthGroups` advanced toggle is set. |
| `checkDrsMigrationConstraints` | Per-host enumeration of non-migratable VMs (must-stay rules, USB/PCI passthrough, mounted local ISOs, suspended state). |
| `checkDepotVersionCompatibility` | Depot major-version vs. cluster host major-version. |
| `evaluateResidualCapacity` | Dynamic per-host check before MM entry. Returns `{canProceed, reason, mode, currentMargin}`. Implements AD-04 hybrid policy. |
| `getLockdownModeStatus` | Per-host lockdown state (`lockdownDisabled`/`lockdownNormal`/`lockdownStrict`). |

#### `.staging` — Patch staging Actions

| Action | Purpose |
|---|---|
| `resolveContentLibraryItemPath` | Resolve CL item to on-disk path on backing datastore. |
| `findClusterStagingDatastore` | Find cluster-shared datastore with sufficient free space. |
| `stageDepotToDatastore` | Copy depot via `FileManager.copyDatastoreFile_Task`. |
| `cleanupStagedDepot` | Best-effort cleanup of staged copy. Accepts a `force` boolean for WF-07 reconciliation use (force = true bypasses ownership checks for orphan staged files from dead runs). |

#### `.account` — Ephemeral account lifecycle (per AD-08)

| Action | Purpose |
|---|---|
| `provisionEphemeralAccount` | Generates account name (`vro-patch-<short-runid>`, capped at 32 chars) and strong random password (32+ chars, full keyspace), then creates user via `accountManager.createUser` with `shellAccess = true`. Returns `{accountName, password, success}`. |
| `grantAdminRoleToAccount` | `setEntityPermissions` to grant Admin role. |
| `verifyEphemeralAccountReady` | Test SSH login + `esxcli system version get`. |
| `removeEphemeralAccountPermission` | Remove permission grant. Idempotent (handles `NotFound`). |
| `deleteEphemeralAccount` | Delete account via `removeUser`. Idempotent. |
| `enumerateOrphanPatchPermissions` | Find permission entries whose principal name matches `vro-patch-*` pattern. |
| `removeOrphanPermissionByEntry` | Remove orphan permission by direct entry reference. |

#### `.host` — Per-host operations

| Action | Purpose |
|---|---|
| `setHostSshServiceState` | Start/stop `TSM-SSH` via `HostServiceSystem`. |
| `verifyClusterHasNoOtherHostsInMM` | Pre-MM safety check; verifies the target host is not in MM AND no other host in the cluster is in MM. |
| `enterMaintenanceModeEnsureAccessibility` | MM enter with vSAN `EnsureObjectAccessibility` option. |
| `exitMaintenanceMode` | MM exit. Idempotent. |
| `runEsxcliProfileList` | SSH `esxcli software sources profile list`. Parses output; identifies `-standard` profile. |
| `runEsxcliProfileUpdate` | SSH `esxcli software profile update`. Parses output. |
| `rebootHostAndWaitReconnect` | Reboot via SDK + poll connection state to timeout. |
| `verifyHaAgentRejoined` | Poll `host.runtime.dasHostState.state` until `connectedToMaster` for stability period. |
| `getHostBuildNumber` | Read `host.config.product.build`. Pre/post comparison performed inline in WF-03 canvas Decision element (`preBuild !== postBuild`). |
| `assessHostUsabilityPostFailure` | Per AD-09: determine if host is usable post-failure (Scenario A/B/C classifier). |

#### `.cluster` — Per-cluster operations

| Action | Purpose |
|---|---|
| `evaluateClusterContinuationDecision` | Per AD-09: given recent host result, decide continue/halt. Combines cleanup outcome, host usability, residual capacity. |

#### `.locking` — Lock management

| Action | Purpose |
|---|---|
| `acquireClusterPatchLock` | Acquire `ESXI_PATCH_<vc>_<cluster>` lock. |
| `releaseClusterPatchLock` | Release. Idempotent. |
| `forceReleaseClusterPatchLock` | Used by WF-07 for orphan locks. |

#### `.tracking` — CE-05 run state tracking

| Action | Purpose |
|---|---|
| `registerWorkflowRun` | Add entry to CE-05. Acquires/releases `CE_05_RUN_TRACKER_LOCK` internally. |
| `updateHostPhaseStatus` | Update host phase/status in CE-05 entry. Acquires/releases `CE_05_RUN_TRACKER_LOCK` internally. |
| `removeHostFromRun` | Remove host (after AUTH_CLEANUP success). Acquires/releases lock internally. |
| `removeWorkflowRun` | Remove run entry on clean exit. Acquires/releases lock internally. |
| `getWorkflowRuns` | Read all CE-05 entries (used by WF-07). Acquires/releases lock internally for read consistency. |

#### `.reconcile` — WF-07 reconciliation Actions

| Action | Purpose |
|---|---|
| `queryWorkflowRunState` | Query vRO via `Server.getWorkflowTokenById` for actual run state. |
| `reconcileHost` | Per-host reconciliation: exit MM → disable SSH → remove permission → delete account. |
| `reconcileLock` | Force-release stuck cluster lock. |
| `purgeOldRunEntries` | Remove CE-05 entries older than `maxRetryAgeDays`. |
| `checkAnotherWf07Running` | Defensive startup check. |

#### `.results` — Result-object construction

| Action | Purpose |
|---|---|
| `buildHostResultProperties` | Per AD-07 host result contract. |
| `buildClusterResultProperties` | Per AD-07 cluster result contract. |
| `buildVcenterResultProperties` | Per AD-07 environment result contract. |

#### `.report` — Report and email Actions

| Action | Purpose |
|---|---|
| `composeHtmlRunReport` | Generate full HTML report. |
| `composeInterventionEmailHtml` | Per-host intervention email body. |
| `composeReconciliationSummaryEmail` | WF-07 summary email. |
| `sendNotificationEmail` | Send via Mail plugin. Records send result. |

---

## 3c — Workflow Canvas Layouts

### 3c.1 WF-01 Remediate vSphere Environment

**Workflow attributes:** `wfLogPrefix` (`[ESXI-REMEDIATE-VC]`), `wfRunId`, `clusterWorkItems`, `clusterResults`, `emailsSent`, `vcenterResult`, `runStartTime`, `runEndTime`, `registeredInCE05` (boolean), `childRuns` (Array of running WF-02 run IDs).

**Canvas elements (left-to-right):**

1. Start
2. Initialize Logging — sets log marker `Workflow Name:Remediate vSphere Environment-WorkflowRunId:<wf-01-run-id>` per FR-42 (propagates to children)
3. Validate Inputs (defense in depth — re-verify all three acknowledgements are checked)
4. Decision: All Acknowledgements Checked? (Ack1, Ack2 conditional, Ack3)
5. Resolve SMTP Host
6. Pre-flight: Identify VxRail Clusters (rejects non-VxRail per AD-06)
7. Pre-flight: Verify All Hosts On 8.x (rejects clusters with pre-8.0 hosts per C-14)
8. Pre-flight: Full Health Checks
9. Decision: Any clusters eligible?
10. Build Cluster Work Items (sorted alphabetically per FR-04)
11. Decision: dryRun? (informational logging branch)
12. **Action: Register WF-01 in CE-05** (per FR-35)
13. Action element: `runWithParallelism` (workerWorkflow = WF-02)
14. Aggregate Results
15. Compose HTML Report
16. Send Final Email
17. **Action: Remove WF-01 from CE-05**
18. Bind Outputs
19. Log Run Summary
20. End
21. **Default Error Handler:** Cancel running children → Compose best-effort report → Send best-effort email → Remove CE-05 entry → Throw to mark workflow failed

### 3c.2 WF-02 Remediate vSphere Cluster

**Workflow attributes:** `wfLogPrefix` (`[ESXI-REMEDIATE-CL]`), `wfRunId`, `lockAcquired`, `targetHosts`, `depotPathOnHost`, `stagedFilePath`, `hostResults`, `clusterResult`, `haltedReason`, `clusterContinuationState` (per AD-09 tracker).

**Canvas elements:**

1. Start
2. Initialize Logging
3. Acquire Cluster Lock
4. Decision: Lock acquired?
5. Pre-flight Re-validation (workflow-start-time, full)
6. Sort Hosts Alphabetically
7. Resolve Depot Path
8. Decision: Staging Mode
9. Stage Depot (if STAGE mode)
10. **Process Hosts Loop** — explicit `while` loop in Scriptable Task:
    - For each host (alphabetical order):
      - Call `evaluateResidualCapacity`. If fails, set `haltedReason = "Residual capacity floor reached"`, break.
      - Call WF-03 `Remediate ESX Host` synchronously.
      - Append result to `hostResults`.
      - Update CE-05 with host phase/status (per FR-36).
      - Call `evaluateClusterContinuationDecision` (per AD-09):
        - Scenario A → continue.
        - Scenario B → email immediately, continue.
        - Scenario C → email immediately, set `haltedReason = "Host unusable post-failure"`, break.
11. Aggregate Cluster Result
12. Cleanup Staged Depot (if staged)
13. Release Cluster Lock
14. Log Cluster Summary
15. End (returns `clusterResult`)
16. **DEH:** Best-effort lock release + staged depot cleanup → build FAILED `clusterResult` → end normally (no rethrow)

### 3c.3 WF-03 Remediate ESX Host (most detailed canvas — implements AD-08 + 14-phase procedure)

**Workflow attributes:** `wfLogPrefix` (`[ESXI-REMEDIATE-HOST]`), `wfRunId`, `hostFqdnLabel`, `preBuild`, `postBuild`, `accountCreated`, `permissionGranted`, `sshWasEnabledByUs`, `mmEnteredByUs`, `failurePhase`, `failureReason`, `cleanupOutcome` (per phase), `hostUsablePostFailure`, `interventionEmailSentAt`, `runStartTime`, `accountName`, `accountPassword` (volatile, never persisted).

**Canvas elements (14-phase procedure per FR-19):**

1. Start
2. Initialize Logging
3. Capture Pre-Patch Build
4. **MM_PRECHECK:** Verify cluster has no other hosts in MM
5. Decision: Cluster clean?
6. **AUTH_PROVISION:** Generate password → Create account → Grant Admin role
7. Decision: Account created and role granted?
8. **AUTH_VERIFY:** Test SSH login
9. Decision: Account ready?
10. **SSH_ENABLE:** Start TSM-SSH service via vCenter
11. Decision: SSH enabled?
12. **MM_ENTER:** Enter MM via vCenter
13. Decision: MM entered?
14. **PATCH_LIST:** SSH and run profile list
15. Decision: Profile listed?
16. Decision: dryRun? (skip patch+reboot in dry run)
17. **PATCH_INSTALL:** SSH and run profile update
18. Decision: Install OK?
19. **REBOOT:** Initiate reboot
20. **RECONNECT:** Wait for reconnection
21. Decision: Reconnected?
22. **VERIFY_BUILD:** Compare builds
23. Decision: Build changed?
24. **HA_REJOIN:** Wait for HA agent rejoined
25. Decision: HA rejoined?
26. Mark outcome SUCCESS

— from any failure decision OR success path, converge to cleanup (cleanup ordering per AD-08): —

27. **MM_EXIT** (cleanup ordering step 1, conditional on `mmEnteredByUs`)
28. **SSH_DISABLE** (cleanup ordering step 2, conditional on `sshWasEnabledByUs`)
29. **AUTH_CLEANUP — Remove Permission** (cleanup ordering step 3, conditional on `permissionGranted`)
30. **AUTH_CLEANUP — Delete Account** (cleanup ordering step 4, conditional on `accountCreated`)
31. **Assess Host Usability Post-Failure** (per AD-09, only on failure path)
32. **Send Intervention Email** (conditional on Scenario B or C per AD-09)
33. **Update CE-05 Host Entry** (final phase status)
34. **Remove Host from CE-05** (only on full SUCCESS, not on failure)
35. Build Host Result
36. Log Host Summary
37. End (returns `hostResult`)
38. **DEH:** Best-effort cleanup using `accountCreated`/`permissionGranted`/`sshWasEnabledByUs`/`mmEnteredByUs` flags → Update CE-05 → Build FAILED `hostResult` → End normally

### 3c.4 WF-04 Validate vSphere Environment Remediation Prerequisites

A simplified read-only version of WF-01's pre-flight phases. Same input form (sans Acknowledgement and Notification sections), same pre-flight Actions, output is a Properties object with per-cluster pass/fail/warn classification and a human-readable HTML report. No locking, no execution, no children invoked.

Element count: ~8.

### 3c.5 WF-05 Release Cluster Remediation Locks

Admin utility. Inputs: `vcenter` (single, optional), `clusterMoRef` (string, optional), `confirm` (boolean, must be true). If `vcenter` and `clusterMoRef` both provided, releases that specific lock. If only `vcenter` provided, releases all `ESXI_PATCH_<vcenter-fqdn>_*` locks. If neither provided, requires explicit `releaseAll = true` flag and releases everything matching `ESXI_PATCH_*`. Logs every release at audit level.

Element count: ~6.

### 3c.6 WF-06 Cleanup Orphan Remediation Accounts

Admin utility. Scans hosts in selected vCenter for accounts matching `vro-patch-*` naming pattern. Requires operator confirmation before deletion. Logs every deletion at audit level.

Element count: ~7.

### 3c.7 WF-07 Reconcile Crashed Remediation Runs

**Canvas elements:**

1. Start
2. Initialize Logging
3. **Defensive: Check Another WF-07 Running?** → if yes, log + end
4. Acquire WF-07 Reconciliation Lock
5. Read CE-05 Entries
6. For each entry: query vRO for run state via `Server.getWorkflowTokenById`
7. Filter: alive runs (skip), dead runs (proceed)
8. For each dead run:
   - For each host entry: reconcile (exit MM → disable SSH → remove permission → delete account)
   - Force-release cluster locks if held
   - Cleanup staged depots (calls `cleanupStagedDepot` with `force = true`)
   - Update / remove CE-05 entries
9. Purge old entries (`>maxRetryAgeDays` per CE-01)
10. Compose Reconciliation Summary Email
11. Send Email (if any cleanup performed or alerts)
12. Release WF-07 Lock
13. Log Summary
14. End

---

## 3d — Module Path and Folder Path Naming Conventions

**Action module paths** use vRO's dotted notation (compact):

| Module Path | Contents |
|---|---|
| `com.broadcom.pso.common.logging` | Reusable logging Actions. |
| `com.broadcom.pso.common.workflow` | Reusable workflow utility (parallelism, retry, lock cleanup). |
| `com.broadcom.pso.common.config` | Reusable Configuration Element accessors. |
| `com.broadcom.pso.vc.esxi.remediation.form` | Form-time external-value Actions. |
| `com.broadcom.pso.vc.esxi.remediation.detect` | Cluster type identification. |
| `com.broadcom.pso.vc.esxi.remediation.preflight` | Pre-flight gates including residual capacity, vSAN health, DRS constraints, depot version, ESXi 8.x verification. |
| `com.broadcom.pso.vc.esxi.remediation.staging` | Patch staging. |
| `com.broadcom.pso.vc.esxi.remediation.account` | Ephemeral account lifecycle. |
| `com.broadcom.pso.vc.esxi.remediation.host` | Per-host operations. |
| `com.broadcom.pso.vc.esxi.remediation.cluster` | Per-cluster operations. |
| `com.broadcom.pso.vc.esxi.remediation.locking` | Lock management. |
| `com.broadcom.pso.vc.esxi.remediation.tracking` | CE-05 run state tracking. |
| `com.broadcom.pso.vc.esxi.remediation.reconcile` | WF-07 reconciliation. |
| `com.broadcom.pso.vc.esxi.remediation.results` | Result construction. |
| `com.broadcom.pso.vc.esxi.remediation.report` | Report and email. |

**Workflow folder paths** use vRO's slash-separated tree notation (readable):

| Folder Path | Workflows |
|---|---|
| `Library/PSO/vCenter/ESXi/Remediation/` | WF-01 Remediate vSphere Environment, WF-04 Validate Prerequisites |
| `Library/PSO/vCenter/ESXi/Remediation/Internal/` | WF-02 Remediate vSphere Cluster, WF-03 Remediate ESX Host |
| `Library/PSO/vCenter/ESXi/Remediation/Operations/` | WF-05 Release Locks, WF-06 Cleanup Orphan Accounts, WF-07 Reconcile Crashed Runs |

The asymmetric notation (dotted for action modules, slashed for folder paths) is conventional vRO — both organize content under vCenter → ESXi → Remediation but use the notation appropriate to their context.

---

## 3e — Text-based canvas diagram (WF-03, the most complex)

```
[Start] → [InitLogging] → [CapturePreBuild]
                              ↓
                     [MM_PRECHECK: Other host in MM?]
                              ↓
                  (Decision: clean?)
                  /NO              \YES
                 ↓                  ↓
      [failurePhase=MM_PRECHECK] [AUTH_PROVISION: Create + Grant]
                                  ↓
                       (Decision: ready?)
                       /NO        \YES
                       ↓           ↓
              [failurePhase=  [AUTH_VERIFY: SSH test]
               AUTH_PROV]         ↓
                              (Decision: verified?)
                                /NO       \YES
                                ↓          ↓
                         [failurePhase= [SSH_ENABLE]
                          AUTH_VERIFY]    ↓
                                      (Decision: SSH OK?)
                                      /NO    \YES
                                      ↓       ↓
                              [failurePhase= [MM_ENTER]
                               SSH_ENABLE]    ↓
                                          (Decision: MM OK?)
                                          /NO   \YES
                                          ↓      ↓
                                  [failurePhase=[PATCH_LIST]
                                   MM_ENTER]    ↓
                                              (Decision: listed?)
                                              /NO  \YES
                                              ↓     ↓
                                      [failurePhase=[Decision: dryRun?]
                                       PATCH_LIST]  /YES \NO
                                                    ↓     ↓
                                              [outcome=  [PATCH_INSTALL]
                                               DRY_RUN]   ↓
                                                       (Decision: install OK?)
                                                       /NO    \YES
                                                       ↓        ↓
                                              [failurePhase=[REBOOT + RECONNECT]
                                               PATCH_INSTALL] ↓
                                                          (Decision: reconnected?)
                                                          /NO    \YES
                                                          ↓       ↓
                                                  [failurePhase=[VERIFY_BUILD]
                                                   RECONNECT]    ↓
                                                              (Decision: changed?)
                                                              /NO    \YES
                                                              ↓       ↓
                                                      [failurePhase=[HA_REJOIN]
                                                       VERIFY_BUILD]  ↓
                                                                (Decision: rejoined?)
                                                                /NO       \YES
                                                                ↓           ↓
                                                        [failurePhase=  [outcome=
                                                         HA_REJOIN]      SUCCESS]
                                                                ↓           ↓
                                                                ↓           ↓
                                ┌──────── all converge to cleanup ──────────┘
                                ↓
                     [Cleanup MM_EXIT (if mmEnteredByUs)]
                                ↓
                     [Cleanup SSH_DISABLE (if sshWasEnabledByUs)]
                                ↓
                     [Cleanup REMOVE_PERMISSION (if permissionGranted)]
                                ↓
                     [Cleanup DELETE_ACCOUNT (if accountCreated)]
                                ↓
                     [Assess Host Usability (Scenario A/B/C)]
                                ↓
                     [Send Intervention Email if needed]
                                ↓
                     [Update CE-05 final status]
                                ↓
                     [Remove host from CE-05 if SUCCESS]
                                ↓
                     [Build Host Result] → [Log Summary] → [End]

(DEH) ←── any uncaught ──
       [Best-effort cleanup using flags]
       [Update CE-05]
       [Build FAILED Result]
       [End normally]
```

---

## 3f — Configuration Element Schemas

### CE-01: `PSO/ESXi Remediation/Settings`

| Attribute | Type | Default | Description |
|---|---|---|---|
| `esxiPatchContentLibraryNamePattern` | string | `ESXi-Patches` | CL name substring pattern (per C-09 substring match). |
| `defaultMaxParallelClusters` | number | 3 | Form default. |
| `defaultHostRebootTimeoutMinutes` | number | 25 | Form default (per C-10). |
| `notificationFixedCcList` | Array/string | `[]` | Fixed cc list (per C-07; default empty, admin-configurable). |
| `interventionEmailSubjectPrefix` | string | `[ACTION REQUIRED]` | |
| `runReportWorkflowDocumentationUrl` | string | (empty) | Optional doc link. |
| `defaultPatchStagingMode` | string | `CONTENT_LIBRARY_DIRECT` | Form default. |
| `maxRetryAgeDays` | number | 30 | WF-07 purge threshold. |
| `vsanHealthGroupsCurated` | Array/string | `["clusterStatus","data","network","physicalDisk","limits"]` | Curated health groups per AD-12. |

### CE-02 (DROPPED — replaced by AD-08 ephemeral pattern)

No persistent ESXi credentials Configuration Element. Per AD-08, no longer needed.

### CE-03: `PSO/ESXi Remediation/SmtpReference`

| Attribute | Type | Default | Description |
|---|---|---|---|
| `smtpHostName` | string | (empty) | Specific SMTP host name; empty = first found via `Server.findAllForType("Mail:SMTPClient")[0]`. |

### CE-05: `PSO/ESXi Remediation/RunTracker`

Per AD-10. Single attribute `runs`, composite-array.

Each entry:
```
{
  "wfRunId": string,
  "esxHost": [
    {
      "hostId": string,           // vRO inventory ID
      "remediationPhaseCurrent": string,  // phase name from FR-19
      "remediationPhaseCurrentStatus": "in-progress" | "succeeded" | "failed" | "cancelled"
    }
  ]
}
```

All reads/writes serialized via global `LockingSystem` lock named `CE_05_RUN_TRACKER_LOCK`.

---

## 3g — Cross-Cutting Design Patterns

### 3g.1 Locking Pattern (per AD-11)

- **Cluster scope:** `ESXI_PATCH_<vcenter-fqdn>_<cluster-moref>`. Acquired by WF-02, released by WF-02 (DEH or normal). Force-released by WF-07.
- **CE-05 access:** `CE_05_RUN_TRACKER_LOCK`. Acquired briefly per read-modify-write to prevent concurrent-write corruption.
- **WF-07 reconciliation:** `WF07_RECONCILIATION_LOCK`. Prevents concurrent WF-07 instances per AD-11 defensive startup check.

### 3g.2 Error Propagation Pattern (per AD-11)

- WF-03 catches known failures, returns FAILED result. Truly unexpected exceptions caught by DEH, also returned as FAILED. Never rethrows.
- WF-02 same pattern: returns FAILED `clusterResult`.
- WF-01 DEH performs cleanup, then **rethrows** to mark workflow failed in vRO (so VCF Automation deployment shows failed, so WF-07 detects on next scheduled run).

**Three-layer cascade per AD-11:**
1. A workflow only cleans up resources it created (in-memory tracking via workflow attributes).
2. When a child workflow returns, the parent inspects and reconciles (result-based reconciliation).
3. When a workflow dies, the next-living layer up takes over (cascading recovery).
4. Cleanup is always idempotent (multiple attempts safe, "already done" treated as success).
5. Persistent state (CE-05) drives reconciliation only when in-memory state is unavailable.

### 3g.3 Logging Pattern

**Marker setup (only at WF-01 start):**

```javascript
var wfName = workflow.name;
var wfRunId = workflow.id;
var marker = "Workflow Name:" + wfName + "-WorkflowRunId:" + wfRunId;
System.setLogMarker(marker);
System.log("WorkflowStart:" + marker);
```

The log marker propagates to child workflow scopes when set in the parent — WF-02 and WF-03 inherit it automatically when invoked via `Workflow.execute()` or `Workflow.executeAsync()`.

**Per-line audit log format (used at every layer):**
```
[<PREFIX>] [<PHASE>] [<STATUS>] <message>
```

Where `<PREFIX>` is `[ESXI-REMEDIATE-VC]`, `[ESXI-REMEDIATE-CL]`, or `[ESXI-REMEDIATE-HOST]` depending on layer. The marker (filterability tag) and per-line prefix (in-line readability) work together — both are used.

Audit-level always emitted. Debug-level gated by `debugLogging`.

### 3g.4 Result Construction

Centralized in dedicated Actions in `.results` module. Schema changes happen in one place.

### 3g.5 SSH Plugin Usage

Connect with ephemeral account credentials. Disconnect in `finally`. No host key verification (host key may be new post-account-creation).

### 3g.6 Cleanup Ordering (per AD-08)

Always: exit MM → disable SSH → remove permission grant → delete account. Idempotent at each step. Rationale: restore service first, restore hardening second, remove access path third, remove access grant fourth (avoiding orphan permissions referencing deleted principals).

### 3g.7 Cleanup Cascade (per AD-11)

Each layer cleans only its own resources via in-memory state. Parents reconcile children's leftovers via result inspection. WF-07 catches anything left behind by dead workflows (only acts on confirmed-dead runs per `Server.getWorkflowTokenById` query).

### 3g.8 Idempotency (per NFR-09, FR-22)

All cleanup operations are idempotent:
- Account already absent → `removeUser` `NotFound` → success.
- Permission already removed → `removeEntityPermission` `NotFound` → success (orphan permissions handled defensively by enumeration).
- Lock already released → success.
- MM already exited → success.
- Build comparison: host already at target build → SKIPPED.

### 3g.9 Concurrent CE-05 Access

Global lock `CE_05_RUN_TRACKER_LOCK` serializes all CE-05 operations. Lock held for milliseconds during read-modify-write.

---

## 3h — Verified API References and Unverified Items

### Verified during Phase 3

| API / Pattern | Status |
|---|---|
| VxRail cluster detection via `VxRail-IP` custom attribute | VERIFIED |
| `VcHostLocalAccountManager.createUser` with `VcHostPosixAccountSpec` (`shellAccess` for ESXi 8.0+) | VERIFIED |
| `VcAuthorizationManager.setEntityPermissions` for Admin role grant | VERIFIED |
| `VcAuthorizationManager.removeEntityPermission` throws on `NotFound` | VERIFIED (informs idempotent wrapper design) |
| ESXi orphan permission cleanup via permission enumeration (vs. principal lookup) | VERIFIED |
| VCF Automation custom form Multi-Value Picker with external-value action | VERIFIED |
| `LockingSystem.lockAndWaitForOwnership`, `LockingSystem.unlock`, `LockingSystem.retrieveAll` | VERIFIED |
| `Workflow.executeAsync()`, `WorkflowToken.waitState`, `Server.getWorkflowTokenById` | VERIFIED |
| `host.configManager.serviceSystem.startService("TSM-SSH")` / `stopService` | VERIFIED |
| `host.enterMaintenanceMode_Task` with `vsanMode = ensureObjectAccessibility` | VERIFIED |
| `host.runtime.dasHostState.state` for HA agent state | VERIFIED |
| `cluster.customValue` Array access pattern for reading custom attributes | VERIFIED |
| Log marker propagation to child workflows when set in parent | VERIFIED (vRO documented behavior) |

### Unverified — Phase 4 verification required

| Item | Verification Required |
|---|---|
| `cluster.configurationEx.vsanConfigInfo.enabled` exact path | vSphere 8.x SDK reference. |
| esxcli output parsing — exact format | Validate against actual ESXi 8.x output samples. |
| PowerFlex SDC VIB name pattern | PowerFlex 4.x docs (only matters for `identifyClusterType` rejection of PowerFlex). |
| `FileManager.copyDatastoreFile_Task` exact signature | SDK reference. |
| HA admission control mode-specific math | Verify against vSphere 8 docs for accurate residual-capacity calculations. |
| vSAN Management API `VsanVcClusterHealthSystem.queryClusterHealthSummary` | API access pattern in JavaScript runtime. |
| `host.config.product.build` exact field name | Verify against vSphere 8.x SDK. |

### Items deliberately not verified (out-of-scope)

- VCF Automation Deployment REST API for self-delete (Pattern A). Not used per C-11 (Pattern B).
- CyberArk CCP integration. Out of scope per AD-05 / C-08.
- Cross-major-version ESXi upgrade procedures. Out of scope per AD-01 / EX-03 / C-14.
- Pre-8.0 ESXi support. Out of scope per C-14.

---

## Document control

**Status:** Consolidated post-reconcile. Ready for Phase 4 (Code Generation) on architect approval.

**Phase 4 delivery plan (in 7 chunks):**
- Chunk 1: Reusable library Actions (8 Actions in `com.broadcom.pso.common.*`).
- Chunk 2: Form-time + detect + preflight Actions (20 Actions: 5 form + 2 detect + 13 preflight).
- Chunk 3: Staging + account + host operations Actions (21 Actions: 4 staging + 7 account + 10 host).
- Chunk 4: Cluster + locking + tracking + reconcile + results + report Actions (21 Actions: 1 cluster + 3 locking + 5 tracking + 5 reconcile + 3 results + 4 report).
- Chunk 5: WF-03 Remediate ESX Host (workflow + Scriptable Tasks).
- Chunk 6: WF-02 Remediate vSphere Cluster (workflow + Scriptable Tasks).
- Chunk 7: WF-01 + WF-04 + WF-05 + WF-06 + WF-07 (catalog item, validation utility, operations workflows).

**Action count: 70 total** (8 reusable in `com.broadcom.pso.common.*` + 62 project-specific in `com.broadcom.pso.vc.esxi.remediation.*`).

