# ESXi Remediation Workflow — Status Summary
**Project**: Automated ESXi Host Patching via VCF Automation 9 Service Catalog
**Reference**: Dell KB 000345284 (out-of-band ESXi patching)
**Current Phase**: Architecture complete (delta accepted) → Implementation next
**Document Purpose**: Full context transfer for implementation phase / new chat session

---

## 1. Phase Status

| Phase | Status |
|-------|--------|
| Discovery | ✅ Complete |
| Open Items Resolution (8 + 2 follow-ups) | ✅ Complete |
| Architecture — Initial 7 Deliverables | ✅ Complete |
| Architecture — Review Delta (per-host tracking + cleanup) | ✅ Complete (accepted) |
| Implementation | ⏭ Next (P0 → P9 per sequencing plan) |

---

## 2. Platform & Environment

| Item | Value |
|------|-------|
| Automation Platform | VCF Automation 9 (embedded Orchestrator) |
| Orchestrator | Embedded vRO |
| Target ESXi Version | 8.0 U3 |
| vCenter Version | vSphere 8 |
| Cluster Types | vSAN (VxRail-managed) + VMFS (PowerFlex) |
| SDDC Manager | Out of scope — hosts are NOT VCF-managed workload domains |
| VxRail Manager | Present but bypassed (out-of-band patching per Dell KB) |
| Patch Source | Offline bundle ZIP in Content Library per vCenter |
| Install Method | esxcli via temp local account over SSH (Option C) |
| Lock Store | vRO Configuration Elements + LockingSystem.lockAndWaitFor |
| Reporting | Email + System.log() forwarded to Log Insight |

---

## 3. Resolved Decisions (All Open Items)

### From Discovery Phase
| # | Question | Decision |
|---|----------|----------|
| 1 | ESXi shell access without root | Temp local account via HostLocalAccountManager (vCenter-mediated) |
| 2 | vLCM vs. esxcli | esxcli (Dell KB method) |
| 3 | Cluster lock store | vRO Configuration Elements |
| 4 | Patch source | Content Library offline bundle ZIP per vCenter |
| 5 | Compatibility check | Matrix-first CE, fallback to bundle metadata parse, write-back |
| 6 | 3-node vSAN | Hard block + explicit override flag |
| 7 | Pinned VMs | Auto-fail host, no mitigation |
| 8 | vCLS on host (8.0 U3) | Embedded vCLS — no retreat mode needed |
| 9 | HA admission control | No changes — precheck validates headroom |
| 10 | PowerFlex/VMFS storage checks | Rely on HA + DRS; no storage-side API calls |
| 11 | Hosts already in MM | Skip + include in report |
| 12 | Notification | Pre-configured SMTP relay via vRO Mail Plugin |
| 13 | Service Catalog integration | Service Broker → vRO Content Source; vRO action bindings |

### From Architecture Open Items Phase
| # | Question | Decision |
|---|----------|----------|
| 1 | Cluster workflow type | Nested workflow (Remediate-ESXi-Cluster) |
| 2 | Parallel cluster fork | `System.startWorkflow()` + WorkflowToken polling |
| 3 | Form mechanism | vRO action bindings only (no ABX) |
| 4 | Orphan sweeper | Combination: scheduled daily 02:00 + on-demand admin catalog item |
| 5 | Report delivery | Email + System.log() → Log Insight; workflow marker emitted at parent S0 |
| 6 | SSH plugin | Confirmed installed and in-scope |
| 7 | CL datastore reachability | Environmental given (CL mounted on all hosts in vCenter) |
| 8 | HostSystem.config.product.build | Confirmed available via vRO vCenter plugin |
| A | Workflow marker scope | Logged once at parent S0; children inherit via execution lineage |
| B | Sweeper schedule/threshold | Daily 02:00 local; orphan age > 4h; cross-ref ClusterLocks runIds |

### From Architecture Review Delta
| # | Topic | Resolution |
|---|-------|------------|
| 9.1 | Per-host result persistence | New CE: RemediationHistory; written at every host workflow terminal state |
| 9.2 | Per-host result schema | Formal schemas: HostResult, ActionLedgerEntry, CleanupWarning, ErrorDetail |
| 9.3 | Status taxonomy | SuccessWithWarnings introduced as distinct terminal status |
| 9.4 | Sweeper scope expansion | Covers orphaned permissions, residual SSH/Shell services, RemediationHistory retention |
| 9.5 | Repeat-failure detection | Threshold = 2 consecutive runs (configurable); per-host scope |
| 9.6 | Cleanup failure escalation | Sweepable → WARN log + summary email; non-sweepable → immediate email |
| 9.7 | Operator service exemption | RemediationDefaults.serviceExemptions list to skip sweeper service cleanup |

---

## 4. Architecture Summary

### 4.1 Workflow Hierarchy
```
Service Broker Form (Service Catalog)
  └─ vRO Action Bindings: vCenter → Cluster(s) → Bundle → Override flags → Prechecks
         │ (on submit — all prechecks pass)
         ▼
Workflow: Remediate-ESXi-Clusters [PARENT]
  ├─ Validate + acquire cluster locks (Config Element, LockingSystem)
  ├─ Fork: Remediate-ESXi-Cluster [per cluster, PARALLEL via System.startWorkflow + tokens]
  │    └─ For each host (SERIAL):
  │         └─ Remediate-ESXi-Host [sub-workflow, full state machine H0-H13 + R1-R5]
  ├─ Aggregate results from all cluster workflows
  ├─ Persist HostResults to RemediationHistory CE
  ├─ Release all cluster locks
  └─ Send summary email report (with repeat-failure detection)
```

### 4.2 State Machine Tiers
- **Parent (Remediate-ESXi-Clusters)**: S0_INIT → S1_VALIDATE_INPUTS → S2_ACQUIRE_LOCKS → S3_FORK_CLUSTERS → S4_POLL_TOKENS → S5_AGGREGATE → S6_RELEASE_LOCKS → S7_REPORT
- **Per-Cluster (Remediate-ESXi-Cluster)**: C0_INIT → C1_NEXT_HOST → C2_PRE_HOST_CHECK → C3_REMEDIATE_HOST → C4_EVALUATE → C5_POST_HOST_VALIDATE → C6_RECORD_OK / C7_HOST_FAILED → C8_HALT_CLUSTER → C9_DONE
- **Per-Host (Remediate-ESXi-Host)**: H0_INIT → H1_ENABLE_SVC → H2_CREATE_USER → H3_GRANT_ADMIN → H4_ENTER_MM → H5_RESOLVE_BUNDLE → H6_SSH_VALIDATE → H7_SSH_INSTALL → H8_REBOOT → H9_POLL_RECONNECT → H10_VALIDATE_BUILD → H11_EXIT_MM → H12_VALIDATE_HA → H13_CLEANUP
- **Rollback States**: R1_FLAG_UNRECOVERABLE, R2_EXIT_MM, R3_REVOKE_PERM, R4_REMOVE_USER, R5_STOP_SVC

### 4.3 Configuration Elements (com.company.remediation namespace)

| CE | Purpose |
|----|---------|
| `ClusterLocks` | Active cluster lock tracking; key = cluster moRef |
| `PatchCompatibilityMatrix` | Memoized bundle metadata; key = bundle SHA-256 |
| `RemediationDefaults` | Tunables (timeouts, retries, recipients, sweeper config, repeatFailureThreshold, serviceExemptions) |
| `RemediationHistory` | Persisted HostResult per `<runId>::<hostMoRef>`; retentionDays=90, maxEntries=10000 |

### 4.4 Per-Host Result Schema (HostResult)
- `hostMoRef`, `hostName`, `vCenterId`, `clusterMoRef`
- `status`: enum [Success, SuccessWithWarnings, Skipped, Failed, Unrecoverable]
- `buildBefore`, `buildAfter`, `startedAt`, `completedAt`
- `workflowExecutionId`, `parentRunId`, `clusterRunId`, `bundleSha256`
- `actionLedger[]`: ActionLedgerEntry (state, action, timestamps, result, rollback fields, details)
- `cleanupWarnings[]`: CleanupWarning (step, errorCode, errorMessage, remediationHint, sweepable)
- `error`: ErrorDetail (state, category, code, message, stackTrace) | null

### 4.5 Error Categories
| Category | Rollback? | Immediate Email? |
|----------|-----------|------------------|
| Pre-flight | Not needed | No |
| Recoverable | Yes | No |
| Unrecoverable | Best-effort | Yes |
| Operational (incl. cleanup residue) | If host touched | Conditional (yes if non-sweepable) |

### 4.6 Workflow Marker
Format: `WorkflowName:Remediate-ESXi-Clusters-WorkflowRunId:<id>`
Emitted once at parent S0 via `System.log()`; children inherit via Log Insight execution lineage correlation.

---

## 5. vRO Actions (Planned)

All actions under `com.company.remediation.actions`:

**Form / Precheck Actions**
- `getVCenters()`, `getClustersForVcenter(vc)`, `getContentLibraryBundles(vc)`
- `parseBundleMetadata(vc, libraryItemId)`, `checkCompatibility(bundleHash, clusters)`
- `checkClusterLocks(clusters)`, `checkClusterSupportability(clusters, override3Node)`

**Lock Management**
- `acquireLocks(clusters, runId)`, `releaseLocks(clusters, runId)`

**Host Operations**
- `enableHostSSH(host)` / `disableHostSSH(host)`
- `createTempHostUser(host, username, password)` / `removeTempHostUser(host, username)`
- `assignAdminRoleOnHost(host, principal)` / `removeRoleOnHost(host, principal)`
- `resolveBundleDatastorePath(vc, libraryItemId, host)`
- `installPatchViaSSH(host, username, password, bundlePath)`
- `rebootHostAndWait(host, timeoutMinutes)`
- `enterMaintenanceMode(host, evacuationMode, timeout)` / `exitMaintenanceMode(host)`

**Validation**
- `validateHAAgentHealthy(host)`, `validateVsanHeadroom(cluster)`
- `getHAAdmissionHeadroom(cluster)`, `getPinnedVmsOnHost(host)`, `getHostBuildNumber(host)`

**History / Reporting**
- `persistHostResult(hostResult)`, `queryHostHistory(hostMoRef, limit)`
- `detectRepeatFailures(hostResults[])`, `sendMail(recipients, subject, htmlBody)`
- `buildSummaryReport(clusterResults[], repeatFailures[])`

---

## 6. vCenter Permissions (Custom Role: VRO-ESXi-Remediation)

Required (assigned at vCenter root with propagation):
- `Host.Config.Maintenance`, `Host.Config.Patch`, `Host.Config.Connection`, `Host.Config.NetService`
- `Host.Local.CreateUser`, `Host.Local.RemoveUser`, `Host.Local.ManageUserGroups` (verify)
- `Authorization.ModifyPermissions`, `Host.Inventory.EditCluster`
- `Datastore.Browse`, `ContentLibrary.ReadStorage`
- `VirtualMachine.Interact.PowerOff` (legacy vCLS edge case)
- `Host.Cim.CimInteraction` (verify during P0)

Explicitly NOT required: `Global.Licenses`, `Cryptographer.*`, `Resource.*`, `Network.Assign`

---

## 7. Implementation Sequencing Plan

| Phase | Scope | Status |
|-------|-------|--------|
| P0 — Foundations | Service account + custom role; vRO Mail Plugin verification; SSH plugin smoke test; CE skeletons (ClusterLocks, PatchCompatibilityMatrix, RemediationDefaults, RemediationHistory); package structure | ⏭ Next |
| P1 — Read-Only Actions | Form-binding actions (get*/check*) | Pending |
| P2 — Locking and CE Mutation | acquireLocks, releaseLocks, matrix R/W, history persistence helpers | Pending |
| P3 — Host Operation Actions | enable/disable services, user/permission lifecycle, MM, SSH install, reboot, validators | Pending |
| P4 — Per-Host Workflow | Remediate-ESXi-Host with full state machine + action ledger + rollback | Pending |
| P5 — Per-Cluster Workflow | Remediate-ESXi-Cluster with serial host iteration + halt-on-failure | Pending |
| P6 — Parent Workflow + Reporting | Remediate-ESXi-Clusters with parallel fork, polling, aggregation, repeat-failure detection, summary email | Pending |
| P7 — Service Broker Integration | Catalog item, form, action bindings, entitlement | Pending |
| P8 — Orphan Sweeper (Expanded) | Scheduled + on-demand; covers accounts, permissions, services, history retention | Pending |
| P9 — Hardening and Documentation | Soak testing, runbook, implementation guide, user guide | Pending |

**Parallelization**: P1 ∥ P2 after P0; P3 splittable across two engineers; P9 documentation can begin during P5/P6.

---

## 8. Risk Register (Top Items)

| Risk | Severity | Mitigation |
|------|----------|------------|
| SSH blocked between vRO and ESXi | High | Network precheck on form submission |
| MM hangs on pinned VM | High | Auto-detect pinned VMs precheck; auto-fail if found |
| 3-node vSAN cluster | High | Hard block + explicit override flag |
| HA fails to re-enable post-MM-exit | High | Immediate email; host flagged Unrecoverable; cluster halts |
| Cluster FTT violated during multi-host failure | High | Re-validate FTT headroom before each host (C2) |
| Embedded vRO API drift between VCF Automation versions | Medium | Pin VCF Automation 9 patch level; document API surface |
| SSH plugin throughput with parallel cluster execution | Medium | Soak test in P9; tune executor concurrency |
| Temp account/permission/service residue on cleanup failure | Medium | Expanded sweeper (P8) + SuccessWithWarnings status + summary reporting |
| vSAN resync in progress at host exit-MM | Medium | Poll vSanClusterHealthSystem resync; configurable threshold |
| Reboot exceeds expected window | Medium | Configurable timeout (default 30 min); mark Unrecoverable + alert |
| Config Element race condition | Medium | LockingSystem.lockAndWaitFor wraps all read-modify-write |

---

## 9. Network Requirements

- vRO appliance must reach all ESXi management IPs on TCP/22 (SSH)
- vRO → vCenter: HTTPS/443
- vRO → SMTP relay: TCP/25 or 587 (pre-configured)
- vRO → Log Insight: existing syslog forwarder

---

## 10. Reference Documents

- **Discovery Summary**: ESXi-Remediation-Discovery-Summary.md
- **Architecture (Initial)**: ESXi-Remediation-Architecture.docx (Sections 1–8)
- **Architecture Delta**: ESXi-Remediation-Architecture-Delta.docx (Sections A–F, accepted; merged into master)

---

## 11. Next Steps

**Resume from**: Implementation Phase P0 (Foundations).

**P0 Exit Criteria**:
- Service account created; custom role `VRO-ESXi-Remediation` assigned at vCenter root with propagation; representative privilege test passes
- vRO Mail Plugin sends a verified test email
- vRO SSH session opens successfully against a lab ESXi host
- All four CEs (ClusterLocks, PatchCompatibilityMatrix, RemediationDefaults, RemediationHistory) created with documented schemas; RemediationDefaults populated with default values
- Package structure under `com.company.remediation` established (workflows, actions, configurations subfolders)

**Before P0 begins**: Validate two flagged permissions in lab — `Host.Local.ManageUserGroups` and `Host.Cim.CimInteraction` — and confirm whether they are required.
