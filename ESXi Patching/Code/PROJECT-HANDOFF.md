# vSphere Environment Remediation Workflow — Project Handoff

> **Purpose of this document:** Resume the project in a new Claude chat session. Paste the contents of this file as the FIRST message in a new chat, along with the system prompt for the VCF Orchestrator workflow architect role. Then attach (or paste) the design/requirements/open-items documents referenced below.

---

## 1. Project at a glance

**Customer:** Federal-sector, tight security posture, contractor-heavy ops, lackadaisical mid-management on compliance.

**Goal:** Automate Dell KB 000345284 manual ESXi patching for VxRail clusters. This is a fallback workflow used when vLCM (vSphere Lifecycle Manager) or VxRail Manager fails — operators currently have to do the procedure by hand, which is error-prone and slow.

**Platform:** VCF 9.x (Orchestrator + Automation), vSphere 8 on VxRail. PowerFlex out of scope. ESXi 8.x only.

**Scale:** 7-10 vCenters. Per-vCenter scope (one workflow run handles one vCenter).

---

## 2. Workflow inventory (CORRECTED)

There are **4 workflows total**. Earlier in the project I'd been carrying a stale model with 7 workflows; the architect corrected this in the last message before session limit.

| Workflow | Role |
|---|---|
| **WF-01** | Main parent. User runs this. Calls WF-02 asynchronously per cluster. Has the request form. |
| **WF-02** | Per-cluster. Called by WF-01. Remediates all hosts in one cluster sequentially. |
| **WF-03** | Per-host. Called by WF-02. Runs the 14-phase per-host procedure. |
| **WF-07** | Reconcile/cleanup. Called by WF-01 on WF-02 failure path AND scheduled to catch crashed runs. |

What I'd previously called WF-04 (Validate Prerequisites), WF-05 (Release Locks admin), WF-06 (Cleanup Orphan Accounts admin) are NOT separate workflows. WF-04's logic is form-time validation built into WF-01's request form. WF-05 and WF-06 don't exist — their use cases are covered by WF-07's reconcile logic.

---

## 3. Authoritative design documents

These three files are in `/mnt/user-data/outputs/` (or attached to the new chat). They are the source of truth for the project.

| File | Contents |
|---|---|
| `esxi-remediation-workflow-open-items.md` | 13 architectural decisions (AD-01 through AD-13), 15 customer items with verbatim customer responses preserved (C-15 dropped). |
| `esxi-remediation-workflow-requirements.md` | 53 FRs, 13 NFRs, 17 EXs, 12 ASMs, 8 CONs, 21 risks, 28 ACs. |
| `esxi-remediation-workflow-design.md` | Design phase output. **NOTE:** This document references 7 workflows. The corrected workflow inventory (4 workflows) supersedes Section 3 of this document. The Action lists and CE schemas remain valid. |

---

## 4. Locked architectural decisions

Verbatim from the open-items document. All CLOSED.

| ID | Decision |
|---|---|
| **AD-01** | VxRail-only KB 000345284 esxcli procedure. |
| **AD-02** | Per-vCenter workflow scope. |
| **AD-03** | No automated rollback. |
| **AD-04** | Hybrid cluster size: 3-node BLOCKED, 4-node ALLOWED with Ack2, 5+ ALLOWED with 1-host headroom. Static + dynamic per-host residual capacity check. |
| **AD-05** | Ephemeral credentials. No persistent ESXi credentials. |
| **AD-06** | PowerFlex out of scope. |
| **AD-07** | Layered workflows. Async fan-out. Children return FAILED structured results; only WF-01 rethrows. |
| **AD-08** | Ephemeral per-run ESXi account `vro-patch-<short-runid>` via `accountManager.createUser` with `VcHostPosixAccountSpec` (`shellAccess=true`). Admin role via `setEntityPermissions`. Cleanup ordering: exit MM → disable SSH → remove permission → delete account. Idempotent wrappers. |
| **AD-09** | Three-state cluster continuation: A (cleanup OK, host usable) → continue; B (cleanup partial, host usable) → email + continue; C (host unusable) → email + halt. HA_REJOIN failures excluded from residual capacity math. |
| **AD-10** | Run state via single CE-05 with composite-array `runs` attribute. WF-03 writes directly. Global `CE_05_RUN_TRACKER_LOCK`. |
| **AD-11** | Cleanup cascade: layer cleans own resources; parents reconcile children; WF-07 only acts on confirmed-dead runs. WF-07 daily, defensive startup check, never enters MM. |
| **AD-12** | Validation Summary text area inline in Cluster Selection. vSAN health curated subset + advanced toggle. |
| **AD-13** | VMSA reference REQUIRED. Format `^VMSA-\d{4}-\d{4}$`. Blocks Ack1 until valid. |

---

## 5. Key customer responses (verbatim, all CLOSED)

| ID | Customer response (paraphrased — see open-items doc for verbatim) |
|---|---|
| C-01 | NFS-backed Content Library used for depots |
| C-02 | Manual upload per vCenter (firewall issues prevent cross-vCenter sync) |
| C-03 | No CR required for SSH enable/disable transient operations |
| C-04 | Single SMTP relay configured in Orchestrator |
| C-05 | Ephemeral accounts (resolved by AD-08) |
| C-06 | Build form-time preflight validation as part of WF-01 |
| C-07 | No CC list (configurable, empty default) |
| C-08 | Custom credential plugin (CCP) deferred (moot per AD-08) |
| C-09 | CL contains "ESXi-Patches" substring |
| C-10 | Reboot 20-25 min (default 25) |
| C-11 | Pattern B persistent deployment |
| C-12 | Patch picker before cluster picker, version-aware labels |
| C-13 | Reuse inventory connections (no new connections per workflow) |
| C-14 | ESXi 8.x only |
| C-15 | DROPPED |
| C-16 | Administrator role at vCenter level |

---

## 6. Architect-confirmed defaults (from this session)

| Decision | Value |
|---|---|
| **Short run ID format** | First 8 hex characters of workflow run ID after stripping dashes (e.g., `d4e84e3f`). Used in ephemeral account names: `vro-patch-<8hex>`. |
| **SSH session management** | Per-phase: each Action/Scriptable Task opens a fresh `SSHSession`, runs commands, disconnects. Each phase verifies auth still works as side effect. |

---

## 7. The 14-phase per-host procedure (executed by WF-03)

| # | Phase | Action |
|---|---|---|
| 1 | MM_PRECHECK | Capture baseline (version, build, bootTime, sshWasAlreadyRunning) |
| 2 | AUTH_PROVISION | Generate run ID + password, create user, grant Administrator role |
| 3 | AUTH_VERIFY | SSH connect + run `esxcli system version get` |
| 4 | SSH_ENABLE | Start `TSM-SSH` service, capture wasAlreadyRunning |
| 5 | (defense-in-depth) | Verify depot file readable + checksum match (pre-MM) |
| 6 | MM_ENTER | `enterMaintenanceMode_Task` with `vsanMode.objectAction = "ensureObjectAccessibility"` |
| 7 | PATCH_LIST | `esxcli software vib install -d "<path>" --no-live-install --maintenance-mode --dry-run` |
| 8 | PATCH_INSTALL | Same minus `--dry-run` |
| 9 | REBOOT | `rebootHost_Task` (refuses if not in MM) |
| 10 | RECONNECT | Two-phase wait: 60s for offline + 25min for back online + bootTime change |
| 11 | VERIFY_BUILD | Read `host.config.product.build`; require buildChanged AND matchesExpected |
| 12 | HA_REJOIN | Poll `host.runtime.dasHostState.state` for primary/secondary/master/slave |
| 13 | SSH_DISABLE | Stop `TSM-SSH` (only if wasAlreadyRunning=false) |
| 14 | MM_EXIT | `exitMaintenanceMode_Task` |
| | AUTH_CLEANUP | Remove permission first, then delete user |

---

## 8. Configuration Elements

| ID | Name | Schema |
|---|---|---|
| CE-01 | Settings | esxiPatchContentLibraryNamePattern (default "ESXi-Patches"), defaults for reboot/parallelism/etc., vsanHealthGroupsCurated=["clusterStatus","data","network","physicalDisk","limits"], maxRetryAgeDays=30, notificationFixedCcList=[] |
| CE-02 | DROPPED | |
| CE-03 | SmtpReference | reference to SMTP host configuration |
| CE-05 | RunTracker | composite-array `runs` attribute holding active run state |

Folder paths: `Library/PSO/vCenter/ESXi/Remediation/{,Internal/,Operations/}`
Action namespace: `com.broadcom.pso.vc.esxi.remediation.*` (dotted)
Log marker (set at WF-01, propagates): `Workflow Name:<name>-WorkflowRunId:<id>`
Per-line prefix: `[ESXI-REMEDIATE-VC|CL|HOST|PREFLIGHT|FORM|DETECT|STAGING|ACCOUNT] [PHASE] [STATUS] message`

---

## 9. Phase 4 status — what's been delivered

### Completed: Chunks 1, 2, 3 (49 Action source files + 3 assembly guides)

All files in `/mnt/user-data/outputs/` (or attached to new chat):

**Chunk 1 — 8 reusable library Actions in `com.broadcom.pso.common.*`**
- `chunk1-action-initWorkflowLogging.js`
- `chunk1-action-auditLog.js`
- `chunk1-action-debugLog.js`
- `chunk1-action-runWithParallelism.js`
- `chunk1-action-releaseAllLocksHeldByWorkflow.js`
- `chunk1-action-withRetry.js`
- `chunk1-action-getConfigurationElementValue.js`
- `chunk1-action-getEncryptedConfigurationElementValue.js`
- `phase4-chunk1-assembly-guide.md`

**Chunk 2 — 20 project-specific Actions** (form/detect/preflight)
- 5 form: `getRegisteredVcenters`, `getDepotItemsForVcenter`, `getClustersForVcenterAndPatch`, `buildClusterValidationSummary`, `buildReviewSectionSummary`
- 2 detect: `getClusterCustomAttributes`, `identifyClusterType`
- 13 preflight: `verifyAllHostsOn8x`, `checkClusterHaHealth`, `checkClusterDrsHealth`, `checkClusterHostsHealthy`, `getLockdownModeStatus`, `checkVsanResyncIdle`, `checkClusterRecentTaskActivity`, `checkVsanHealth`, `checkDrsMigrationConstraints`, `checkDepotVersionCompatibility`, `evaluateResidualCapacity`, `evaluateClusterPreflightCheap`, `evaluateClusterPreflightFull`
- `phase4-chunk2-assembly-guide.md`

**Chunk 3 — 21 project-specific Actions** (staging/account/host)
- 4 staging: `resolveDepotFilePath`, `getDepotChecksum`, `verifyDepotFileOnHost`, `prepareEsxcliInvocation`
- 7 account: `generateShortRunId`, `generateEphemeralPassword`, `provisionEphemeralAccount`, `grantHostAdminRole`, `enableSshService`, `disableSshService`, `cleanupEphemeralAccount`
- 10 host: `captureHostBaseline`, `verifyEsxiSshAuth`, `enterMaintenanceMode`, `exitMaintenanceMode`, `runEsxcliCommand`, `parseEsxcliInstallOutput`, `rebootHost`, `waitForHostReconnect`, `verifyPatchedBuild`, `verifyHostHaRejoin`
- `phase4-chunk3-assembly-guide.md`

### Total delivered: 49 Action source files, 3 assembly guides, 3 design documents.

---

## 10. CRITICAL: Pending refactor before continuing

In the last exchange before session limit, the architect made an important correction that changes the Action library design.

**The architect's rule:** An Action is justified only if it's called from **more than one workflow** OR is required-to-be-an-Action (form external value sources). Otherwise the logic should be inline code in a Scriptable Task within the workflow that uses it.

**With the corrected 4-workflow model**, the Action library should be **17 Actions, not 49**. The other 32 should become inline Scriptable Task code.

### The 17 surviving Actions

**Chunk 1 (cross-cutting library, 8) — all stay:**
1. `initWorkflowLogging`
2. `auditLog`
3. `debugLog`
4. `runWithParallelism`
5. `releaseAllLocksHeldByWorkflow`
6. `withRetry`
7. `getConfigurationElementValue`
8. `getEncryptedConfigurationElementValue`

**Chunk 2 (project-specific, 7):**
9. `getRegisteredVcenters` (form action — required-to-be-Action)
10. `getDepotItemsForVcenter` (form action)
11. `getClustersForVcenterAndPatch` (form action)
12. `buildClusterValidationSummary` (form action)
13. `buildReviewSectionSummary` (form action)
14. `identifyClusterType` (called by form picker AND WF-01)
15. `evaluateClusterPreflightCheap` (called by form actions AND WF-01) — **needs to be regenerated as a fat ~600-line Action with all 11 individual preflight checks inlined**

**Chunk 3 (project-specific, 2):**
16. `cleanupEphemeralAccount` (called by WF-03 AND WF-07)
17. `exitMaintenanceMode` (called by WF-03 AND WF-07)

### The 32 to be inlined as Scriptable Task code

**From Chunk 2 (13):**
- `getClusterCustomAttributes` → inline into `identifyClusterType`
- `verifyAllHostsOn8x` → inline into `evaluateClusterPreflightCheap`
- `checkClusterHaHealth` → inline into `evaluateClusterPreflightCheap`
- `checkClusterDrsHealth` → inline into `evaluateClusterPreflightCheap`
- `checkClusterHostsHealthy` → inline into `evaluateClusterPreflightCheap`
- `getLockdownModeStatus` → inline into `evaluateClusterPreflightCheap`
- `checkVsanResyncIdle` → inline into `evaluateClusterPreflightCheap`
- `checkClusterRecentTaskActivity` → inline into `evaluateClusterPreflightCheap`
- `checkVsanHealth` → inline into `evaluateClusterPreflightCheap`
- `checkDrsMigrationConstraints` → inline into `evaluateClusterPreflightCheap`
- `checkDepotVersionCompatibility` → inline into `evaluateClusterPreflightCheap`
- `evaluateClusterPreflightFull` → inline into WF-01 Scriptable Task
- `evaluateResidualCapacity` → inline into WF-02 Scriptable Task

**From Chunk 3 (19):**
- All 4 staging Actions → inline into WF-03 Scriptable Tasks
- 5 account Actions (`generateShortRunId`, `generateEphemeralPassword`, `provisionEphemeralAccount`, `grantHostAdminRole`, `enableSshService`, `disableSshService`) → inline into WF-03 Scriptable Tasks
  - Note: `generateEphemeralPassword` is single-workflow within this project so inlines, despite cross-project utility
- 8 of 10 host Actions → inline into WF-03 Scriptable Tasks
  - `captureHostBaseline`, `verifyEsxiSshAuth`, `enterMaintenanceMode`, `runEsxcliCommand`, `parseEsxcliInstallOutput`, `rebootHost`, `waitForHostReconnect`, `verifyPatchedBuild`, `verifyHostHaRejoin`

### Two open questions awaiting architect approval

**Q1: Confirm `evaluateClusterPreflightCheap` should swallow all 11 individual checks** as one fat ~600-line Action. (My recommendation: yes — alternative duplicates ~600 lines across 3 callsites.)

**Q2: Where should the 32 inlined logic blocks live within WF-03?**
- **Option A:** One Scriptable Task per ex-Action (~19 tasks in WF-03, busier canvas)
- **Option B:** One Scriptable Task per workflow phase (~14 tasks in WF-03, canvas reads as the 14-phase procedure document — multiple ex-Actions consolidated per phase)

My recommendation: **Option B**. The canvas mirrors the documented 14-phase procedure; related logic stays together; each task's header comment describes what it does internally.

---

## 11. What needs to happen in the new chat (in order)

1. **Architect confirms Q1 and Q2 from Section 10.**
2. **Regenerate Chunks 2 and 3** with the 17-Action library:
   - Drop 32 ex-Action source files (or supersede with notes)
   - Regenerate `evaluateClusterPreflightCheap` as the fat single-Action
   - Update assembly guides for Chunks 1, 2, 3 to reflect 17-Action library
3. **Phase 4 Chunk 4 — workflow infrastructure (cluster + locking + tracking + reconcile + results + report).** Per the original plan, ~21 Actions; with the new rule, this needs an audit too. Some will be Actions (anything called from 2+ workflows), some inline.
4. **Phase 4 Chunk 5 — WF-03 workflow definition** (per-host, the 14-phase procedure as Scriptable Task code on canvas).
5. **Phase 4 Chunk 6 — WF-02 workflow definition** (per-cluster).
6. **Phase 4 Chunk 7 — WF-01 + WF-07 workflow definitions** (parent + reconcile).
7. **Phase 5 — Assembly Instructions.**
8. **Phase 6 — Testing.**
9. **Phase 7 — Four-document deliverable set** (only after all code finalized and tested).

---

## 12. Coding standards established

All Actions and Scriptable Tasks conform to vRO Rhino constraints:
- `var` only (no `let`/`const`)
- Traditional `function` syntax (no arrow functions)
- String concatenation (no template literals)
- No `Map`/`Set`/spread/`Array.includes`/`Array.find`
- ES5 only

Standard Action header block format (also used at top of Scriptable Tasks):
```javascript
// ===================================================================
// ACTION:    <name>
// MODULE:    <module.path>
// PURPOSE:   <one-line description>
// PHASE:     <execution phase>
// RUNTIME:   JavaScript (Rhino)
// LOG PREFIX: [<WORKFLOW-SHORT-NAME>] [<PHASE>]
//
// INPUTS:
//   <paramName> (<type>) — <description>
//
// RETURNS: <type> — <description>
//
// REQUIREMENT TRACE:
//   Implements: <FR-XX, FR-YY>
//
// NOTES:
//   <important behavior, edge cases, dependencies>
// ===================================================================
```

Standard prologue for Actions/tasks needing logging:
```javascript
var auditLogger = System.getModule("com.broadcom.pso.common.logging");
```

Standard pattern conventions:
- Argument validation via `arguments.length` checks
- Properties used for return values (not plain JS objects unless inside arrays)
- Audit logging via `auditLogger.auditLog(LOG_PREFIX, phase, status, message)` — never raw `System.log`
- Permissive philosophy on probe failures: return healthy/clean with `error` populated rather than throw
- SSH pattern (per-phase): `new SSHSession(hostFqdn, 22)` → `connectWithPassword(username, String(securePassword))` → `executeCommand(cmd, true)` then read `.exitCode`/`.output`/`.error` → `disconnect()` in `finally`
- vCenter task polling pattern: check `task.info.state` against "success"/"error", read error via `task.info.error.localizedMessage`, sleep+poll with deadline check

---

## 13. Files to attach in new chat

Attach (or paste) these files at the start of the new chat:

**Design source-of-truth (3 files):**
- `esxi-remediation-workflow-open-items.md`
- `esxi-remediation-workflow-requirements.md`
- `esxi-remediation-workflow-design.md`

**Existing code (49 files) — only needed if the new chat will REUSE the code rather than regenerate it. Most of these will be inlined per Section 10:**
- 8 Chunk 1 files (`chunk1-action-*.js`) — all kept as-is in final design
- 20 Chunk 2 files (`chunk2-action-*.js`) — 7 kept, 13 to be inlined
- 21 Chunk 3 files (`chunk3-action-*.js`) — 2 kept, 19 to be inlined

**Assembly guides (3 files):** to be regenerated; old versions are reference only:
- `phase4-chunk1-assembly-guide.md`
- `phase4-chunk2-assembly-guide.md`
- `phase4-chunk3-assembly-guide.md`

---

## 14. Suggested first message in new chat

After pasting the system prompt and this handoff document, plus attaching the design documents, your first message could be:

> Here's a project we're resuming from a previous chat. The handoff document explains where we are. The architect (me) needs to confirm two open questions in Section 10 before you regenerate the affected files.
>
> Q1 (fat preflight Action): Yes, proceed with `evaluateClusterPreflightCheap` as one ~600-line Action with all 11 individual checks inlined.
>
> Q2 (Scriptable Task organization): Use Option B — one Scriptable Task per phase of the 14-phase procedure in WF-03. Multiple ex-Actions per phase, related logic together.
>
> Please regenerate the Chunk 2 and Chunk 3 deliverables with the 17-Action library. Then we'll proceed to Chunk 4 (workflow infrastructure) under the same rule.

(Adjust the answers to match your actual decisions — the above is just a template.)

---

## 15. Summary of outstanding questions and known issues

**Architect-pending decisions:**
- Q1: confirm fat single Action for `evaluateClusterPreflightCheap`
- Q2: confirm Option B (per-phase Scriptable Tasks) for WF-03 organization
- Whether `evaluateResidualCapacity` should be an Action despite single-workflow use (architect may want it as Action for testability/reviewability of AD-04 policy)
- Whether `runEsxcliCommand` and `parseEsxcliInstallOutput` should remain Actions despite single-workflow use (both are called twice within WF-03 — once for PATCH_LIST, once for PATCH_INSTALL — so are multi-callsite within one workflow but not multi-workflow). Architect's stated rule strictly says inline; but the 2-callsite-within-WF-03 case may merit different treatment.

**Known unverified APIs (from Section 3h.2 of design doc):**
- vSAN cluster health system accessor names (`vsanClusterHealthSystem` vs `vsanHealthSystem`) — Actions probe both
- vSAN object system accessor names — Actions probe both
- PowerFlex SDC VIB names — three patterns probed best-effort
- `cluster.configurationEx.vsanConfigInfo.enabled` access path — wrapped in try/catch

**Known fragile patterns:**
- DRS migration constraint detection uses string-matching on device class names (`String(dev).indexOf("USB")`). Works in practice but is duck-typing.
- Local ISO detection heuristic: `dev.backing.datastore.host.length === 1` — flags some legitimately-shared but single-host-mounted datastores

---

End of handoff document. Good luck in the new chat.
