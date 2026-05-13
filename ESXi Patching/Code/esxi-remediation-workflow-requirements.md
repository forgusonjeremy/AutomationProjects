# vSphere Environment Remediation Workflow — Requirements Document (Phase 2)

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail)
> **Document version:** 2.0 (consolidated post-reconcile)
> **Date:** 2026-05-05
> **Companion documents:** `esxi-remediation-workflow-open-items.md`, `esxi-remediation-workflow-design.md`

---

## How to read this document

This is the formal contract between the customer and development team for what will be built. Architectural decisions referenced as **AD-XX** are locked (see open items companion file). Customer-side items referenced as **C-XX** include any pending defaults inline.

---

## 2.1 Project Overview

### 2.1.1 Project Name

**vSphere Environment Remediation Workflow** (working title for catalog publication; final name TBD per customer naming conventions during catalog publication).

### 2.1.2 Problem Statement

The customer operates a VCF 9.x environment with 7-10 vCenters managing VxRail clusters running vSphere 8. Their normal ESXi patching path — vSphere Lifecycle Manager (vLCM) baselines and VxRail Manager-driven upgrades — has been unreliable in their environment. Patches frequently fail to install through the normal management tooling, and remediation through Dell Support has been slow enough that it is impacting the customer's ability to meet security-mandated patching SLAs imposed by senior leadership. Operators are currently performing the manual patching procedure documented in Dell KB 000345284 by hand, which is labor-intensive, error-prone, and does not scale.

### 2.1.3 Solution Summary

A layered set of three VCF Orchestrator workflows automates the Dell KB 000345284 manual ESXi patching procedure for VxRail clusters. The top-level workflow, `Remediate vSphere Environment`, is published as a VCF Automation catalog item and accepts operator-supplied scope (which clusters within a chosen vCenter), patch source (a depot ZIP from a Content Library), and execution parameters. The workflow performs comprehensive pre-flight validation, processes clusters in parallel up to a configurable cap, walks each cluster's hosts sequentially through the KB-prescribed patching cycle using ephemeral per-run local user accounts, and produces a detailed run report viewable in the VCF Automation deployment record and emailed to operator-supplied recipients. PowerFlex clusters and clusters smaller than 4 hosts are explicitly out of scope. A scheduled reconciliation workflow handles orphan resources from cancelled or crashed runs.

---

## 2.2 Functional Requirements

### Workflow Structure (per AD-07, AD-11)

**FR-01.** The system SHALL be implemented as three layered Orchestrator workflows: `Remediate vSphere Environment` (Layer 1, catalog item), `Remediate vSphere Cluster` (Layer 2, internal), `Remediate ESX Host` (Layer 3, internal).

**FR-02.** Only `Remediate vSphere Environment` SHALL be exposed as a VCF Automation catalog item. The cluster and host workflows SHALL be internal-only.

**FR-03.** The vCenter-level workflow SHALL invoke instances of the cluster-level workflow asynchronously, using the reusable `com.broadcom.pso.common.workflow.runWithParallelism` Action to maintain bounded parallelism with asymmetric scheduling (a faster-completing cluster frees a worker slot for the next queued cluster).

**FR-04.** The cluster-level workflow SHALL invoke instances of the host-level workflow synchronously and sequentially — exactly one host at a time per cluster, per the vSAN FTT=1 constraint identified in Dell KB 000345284. Hosts SHALL be processed in alphabetical order.

**FR-05.** Each child workflow SHALL return a structured result object to its parent. Child workflows SHALL catch known failures and return them as `outcome=FAILED` results; unexpected exceptions are caught by the layer's Default Error Handler which performs cleanup and returns FAILED rather than rethrowing (per AD-11).

**FR-06.** The workflow SHALL also include four auxiliary utility workflows:
- `Validate vSphere Environment Remediation Prerequisites` (WF-04) — read-only validation utility (per C-06).
- `Release Cluster Remediation Locks` (WF-05) — manual admin utility for orphaned lock cleanup.
- `Cleanup Orphan Remediation Accounts` (WF-06) — manual admin utility for forensic cleanup of orphan ephemeral accounts.
- `Reconcile Crashed Remediation Runs` (WF-07) — scheduled reconciliation per AD-11.

### Operator Inputs (per AD-12, AD-13, C-12 architect direction)

**FR-07.** The form SHALL implement a 7-section layout:

| Section | Contents |
|---|---|
| **1. Acknowledgement** | VMSA Reference field (required, format `^VMSA-\d{4}-\d{4}$` per AD-13) and main acknowledgement (Ack1). Ack1 cannot be checked until VMSA is format-valid. |
| **2. Select vCenter** | Single-select vCenter picker. |
| **3. Select Patch** | Content Library item picker (depends on vCenter). Comes before cluster selection per C-12 architect direction. |
| **4. Select Cluster** | Multi-select cluster picker with patch-version-aware labels per C-12. Validation Summary text area inline (per AD-12) showing CRITICAL/WARNING/READY findings. Small-cluster acknowledgement (Ack2) appears inline if any 4-node clusters are selected. |
| **5. Email Recipients** | Comma-separated list of email addresses for notifications. |
| **6. Advanced (collapsed)** | `maxParallelClusters` (default 3), `hostRebootTimeoutMinutes` (default 25), `bypassHardwareCheck` (default false), `dryRun` (default true), `debugLogging` (default false), `ignorePreflightWarnings` (default false). |
| **7. Review** | Read-only summary of all selections (shown regardless of defaults). Final acknowledgement (Ack3) — operator confirms readiness to submit. |

**FR-08.** The form SHALL implement **three acknowledgement gates**:

- **Ack1 (Section 1):** *"I acknowledge that this workflow performs manual ESXi patching following the procedure in Dell KB 000345284 only. This is a deviation from standard vLCM/VxRail Manager procedures and may trigger noncompliance alarms. I confirm this workflow is being used in accordance with Dell support authorization for the specific VMSA being applied (or as otherwise approved by leadership)."* Required-checked. Cannot be checked until VMSA reference is format-valid.

- **Ack2 (Section 4, conditional):** *"I acknowledge that 4-node clusters will be patched at the vSAN FTT=1 floor with no headroom for concurrent failures during the patch window."* Required-checked when any 4-node cluster is in the selection. Per AD-04.

- **Ack3 (Section 7):** *"I have reviewed the validation summary above, the patch selection, the cluster selection, and the email recipients. I confirm I am ready to submit this remediation request. Once submitted, the workflow will execute autonomously to completion."* Required-checked.

**FR-09.** The cluster picker SHALL label each cluster with one of the following decorations:
- `(VXRAIL — READY)` — selectable, all checks passed.
- `(VXRAIL — WARNING: <reason>)` — selectable; warnings can be silenced with `ignorePreflightWarnings` for non-blocking warnings.
- `(VXRAIL — BLOCKED: <reason>)` — visible but not selectable. Includes 3-node clusters per AD-04 and clusters with pre-8.0 hosts per C-14.
- `(POWERFLEX — NOT SUPPORTED)` — visible but not selectable per AD-06.
- `(VSAN-ONLY — NOT SUPPORTED)` — visible but not selectable.
- `(OTHER — NOT SUPPORTED)` — visible but not selectable.

**FR-10.** When the operator selects a depot in Section 3, the cluster picker (Section 4) SHALL re-render with patch-version-aware labels per C-12 (e.g., `(VXRAIL — WARNING: depot is for 8.0 U3, hosts at 8.0 U2)`). Before patch selection, the cluster picker SHALL render with patch-agnostic labels (cluster type + health, no version comparison).

**FR-11.** The patch picker SHALL filter Content Library items based on:
- The Content Library name contains the substring pattern from CE-01 attribute `esxiPatchContentLibraryNamePattern` (default `ESXi-Patches`, per C-09).
- The CL item filename matches `^VMware-ESXi-.*-depot\.zip$`.

**FR-12.** The Validation Summary (Section 4) SHALL render with prominent visual delineation per AD-12:
```
═══════════════════════════════════════════════════════
⚠ CRITICAL WARNINGS — REVIEW CAREFULLY BEFORE PROCEEDING
═══════════════════════════════════════════════════════
[per-cluster findings...]
```

**FR-13.** The Review section (Section 7) SHALL display all form values regardless of whether they are at defaults, per the honesty principle — operators see exactly what they will submit.

**FR-14.** The `ignorePreflightWarnings` field SHALL include explicit help text: *"When checked, the workflow will proceed past WARNING-level pre-flight findings (e.g., recent VxRail Manager activity detected, vSAN health degraded but not critical, hosts with VM migration constraints). BLOCKED-level findings (e.g., 3-node clusters, non-VxRail clusters, HA disabled) are NEVER bypassed by this option. Use only when you understand the warnings and have determined they are acceptable risks for this run. Default: unchecked (warnings cause clusters to be skipped)."*

### Pre-flight Validation (per AD-04, AD-12)

**FR-15.** Form-time (cheap) checks SHALL evaluate each selected cluster on:
- Cluster type (VxRail vs. other).
- Static cluster size policy (3-node = BLOCKED, 4-node = WARNING-acknowledgement-required, 5+ = READY by default).
- All hosts on ESXi 8.x (per C-14).
- HA enabled and healthy.
- DRS enabled and fully automated.
- Current host count and maintenance-mode states.
- Lockdown mode status of each host (enumerated; lockdown hosts contribute to FTT/HA math but are skipped per AD-09 lockdown handling).
- vSAN health (curated subset by default per AD-12: `clusterStatus`, `data`, `network`, `physicalDisk`, `limits`).
- DRS migration constraints — VMs that cannot migrate (must-stay rules, USB/PCI passthrough, mounted local ISOs, suspended state).
- Depot version compatibility (depot ZIP filename's major version vs. cluster hosts' current major version).

**FR-16.** Workflow-start-time (full) checks SHALL repeat all form-time checks plus:
- Active vSAN resync detection.
- Recent-task analysis to detect cluster being operated on by VxRail Manager or other workflows.

**FR-17.** The following conditions SHALL block a cluster from being processed (no override):
- Cluster is not a VxRail cluster.
- Cluster has fewer than 4 hosts (3-node BLOCKED per AD-04).
- Cluster contains any host on pre-8.0 ESXi (per C-14).
- HA is not enabled or not healthy.
- DRS is not enabled or not set to fully automated.
- All hosts in the cluster are in lockdown mode (no patchable hosts available).

**FR-18.** The following conditions SHALL warn but not block (silenceable via `ignorePreflightWarnings = true` for the warnings only; required acknowledgements such as the small-cluster Ack2 are NOT silenceable):
- 4-node cluster (requires explicit Ack2).
- Some hosts in the cluster are in lockdown mode (those hosts will be skipped per AD-04 lockdown handling).
- Depot version mismatch detected (depot's major version doesn't match all selected clusters' hosts).
- vSAN health degraded (curated subset of issues).
- DRS migration constraints detected on hosts (specific VMs identified).
- Recent VxRail Manager or vLCM activity detected on cluster.

### Per-Host Patching Procedure (per AD-01, AD-08)

**FR-19.** For each host in scope, the workflow SHALL execute the 14-phase procedure:

1. **Pre-MM check (`MM_PRECHECK`):** Verify no other host in the same cluster is currently in MM AND verify residual-capacity check passes (per AD-04 dynamic check).
2. **Provision ephemeral account (`AUTH_PROVISION`):** Generate strong random password (32+ chars). Call `host.configManager.accountManager.createUser` with `VcHostPosixAccountSpec` (`shellAccess = true`, name `vro-patch-<short-runid>`). Call `host.configManager.authorizationManager.setEntityPermissions` to grant Admin role.
3. **Verify account ready (`AUTH_VERIFY`):** Test SSH login by running `esxcli system version get`. Confirms account is functional.
4. **Enable SSH (`SSH_ENABLE`):** Start `TSM-SSH` service via vCenter `HostServiceSystem` API.
5. **Enter MM (`MM_ENTER`):** Place host in MM via vCenter `host.enterMaintenanceMode_Task` with `EnsureObjectAccessibility` vSAN data movement option.
6. **List patch profiles (`PATCH_LIST`):** SSH to host as ephemeral user, run `esxcli software sources profile list --depot=<path>`. Select profile ending in `-standard`.
7. **Install patch (`PATCH_INSTALL`):** SSH and run `esxcli software profile update -p <profile> --depot=<path>` (with `--no-hardware-warning` if `bypassHardwareCheck = true`).
8. **Reboot (`REBOOT`):** Initiate reboot via vCenter SDK.
9. **Reconnect verify (`RECONNECT`):** Poll host connection state every 30 seconds. Time out per `hostRebootTimeoutMinutes`.
10. **Verify build (`VERIFY_BUILD`):** Compare post-patch `host.config.product.build` to pre-patch build. Mismatch = FAILED.
11. **HA rejoin verify (`HA_REJOIN`):** Poll `host.runtime.dasHostState.state` until `connectedToMaster` for stable period (30 seconds).
12. **Disable SSH (`SSH_DISABLE`):** Stop `TSM-SSH` service.
13. **Exit MM (`MM_EXIT`):** Exit MM via vCenter SDK.
14. **Cleanup ephemeral account (`AUTH_CLEANUP`):** Remove permission grant first, then delete account.

**FR-20.** All vCenter operations (MM enter/exit, host services, account management, permission grants) SHALL be performed via vCenter SDK using vRO's inventory-registered service account credentials, NOT via SSH. SSH is used only for `esxcli software sources profile list` and `esxcli software profile update`.

**FR-21.** Cleanup ordering on per-host failure SHALL be (per AD-08): exit MM → disable SSH → remove permission grant → delete account. Rationale: restore service first, restore hardening second, remove access path third, remove access grant fourth (avoiding orphan permissions referencing deleted principals).

**FR-22.** All cleanup operations SHALL be implemented as idempotent wrappers that treat "already absent" results as success, supporting safe retry from any context (DEH, parent workflow, WF-07). Permission removal additionally handles the orphan case (principal already removed, permission entry remaining) by enumerating permissions and matching by principal name pattern.

**FR-23.** If `dryRun = true`, the workflow SHALL execute steps 2 (account provision), 3 (verify), 4 (SSH enable), 6 (list profiles) — verifies depot is readable and contains a valid profile — and steps 12 (SSH disable) and 14 (account cleanup). Steps 5 (MM enter), 7-11 (patch and reboot) and 13 (MM exit) are skipped. Host classified `DRY_RUN`.

### Cluster Continuation Policy (per AD-09)

**FR-24.** When a host fails during remediation, the cluster's continuation behavior SHALL follow the three-state policy:

| Scenario | Cleanup outcome | Host usable post-failure | Action |
|---|---|---|---|
| **A** | All cleanup succeeded | Yes | Update CE-05 → continue cluster |
| **B** | Some cleanup failed | Yes | Update CE-05 → email immediately → continue cluster |
| **C** | Cleanup not possible / host stuck | No | Update CE-05 → email immediately → halt cluster |

**FR-25.** A host is considered "usable" if: connection state is `connected`, host responds to vCenter SDK calls, AND host is not unrecoverably stuck in MM (i.e., MM exit calls succeed).

**FR-26.** Independent of the cluster continuation policy, the workflow SHALL halt the cluster before patching the next host if doing so would violate residual-capacity rules per AD-04:
- For 4-node clusters (acknowledged): always halt before second host (would leave 3 hosts, the FTT=1 minimum with no headroom).
- For 5+ node clusters: halt if next MM entry would leave fewer than 4 hosts effectively healthy (FTT minimum + 1-host headroom).

**FR-27.** A host that fails at the `HA_REJOIN` phase SHALL be marked `FAILED` and SHALL NOT count toward residual-capacity calculations for subsequent hosts (a host with broken HA is not contributing to cluster redundancy even if it appears connected).

**FR-28.** Lockdown-mode hosts SHALL contribute to FTT/HA capacity calculations (they remain online and serve workloads) but SHALL NOT be patched (the workflow has no path to them). They are classified `SKIPPED — lockdown mode` in per-host results.

### Patch Staging (per C-01)

**FR-29.** When `patchStagingMode = CONTENT_LIBRARY_DIRECT`, the workflow SHALL resolve the selected Content Library item to its on-disk path on the CL backing datastore and pass that path directly to `esxcli`. The workflow SHALL verify the CL backing datastore is mounted on each target host before proceeding.

**FR-30.** When `patchStagingMode = CLUSTER_DATASTORE_STAGE`, the workflow SHALL identify a cluster-shared datastore, copy the depot ZIP via the vSphere `FileManager.copyDatastoreFile_Task` API, patch all hosts, then delete the staged copy in the cluster's cleanup phase (best-effort, failure logs warning but does not fail workflow).

### Concurrency and Locking (per AD-11)

**FR-31.** Each cluster-level workflow instance SHALL acquire a cluster-scope lock named `ESXI_PATCH_<vcenter-fqdn>_<cluster-moref>` via `LockingSystem.lockAndWaitForOwnership` before performing pre-flight checks.

**FR-32.** If a cluster's lock cannot be acquired (held by another run), the cluster SHALL be classified `SKIPPED` with reason `Cluster locked by run <other-run-id>`. The parent workflow continues with other clusters. The workflow SHALL NOT wait indefinitely for held locks.

**FR-33.** The cluster-scope lock SHALL be released in all exit paths from the cluster workflow: normal completion, handled failure, and uncaught exception (via DEH).

### Run State Tracking (per AD-10)

**FR-34.** A persistent Configuration Element (CE-05 — Workflow Run Tracker) SHALL track active workflow runs and their per-host remediation phase. Schema:
- Single composite-array attribute `runs`.
- Each entry: `{ wfRunId: string, esxHost: [{ hostId: string, remediationPhaseCurrent: string, remediationPhaseCurrentStatus: enum }] }`.

**FR-35.** The vCenter-level workflow SHALL register itself in CE-05 immediately before the first host's `AUTH_PROVISION` step. Pre-flight failures (where no accounts were provisioned) do not register.

**FR-36.** The host-level workflow SHALL update CE-05 directly at major phase boundaries: after `AUTH_PROVISION` succeeds, after `MM_ENTER` succeeds, after `PATCH_INSTALL` succeeds, after `AUTH_CLEANUP` succeeds (host removed from array), and on any failure (phase set, status `failed`).

**FR-37.** All CE-05 reads and writes SHALL be serialized via a global `LockingSystem` lock named `CE_05_RUN_TRACKER_LOCK` to prevent concurrent-write corruption.

### Reconciliation Workflow (per AD-11)

**FR-38.** WF-07 (`Reconcile Crashed Remediation Runs`) SHALL:
- Run on a daily schedule (admin-configurable in vRO scheduler — recommendation documented in Implementation Guide).
- Perform a defensive startup check: if another WF-07 instance is already running, log and exit cleanly.
- Read CE-05 entries.
- For each entry, query vRO via `Server.getWorkflowTokenById(wfRunId)` to determine actual workflow state.
- Skip entries whose workflow is `running` or `waiting` (alive, will self-clean).
- Reconcile entries whose workflow is `failed`, `cancelled`, or whose token doesn't exist.

**FR-39.** WF-07 reconciliation actions (all autonomous, all non-CR-requiring per customer policy):
1. Exit MM on hosts stuck in MM.
2. Disable SSH on hosts where SSH was left enabled.
3. Remove permission grants (handle orphan permissions defensively by enumeration).
4. Delete ephemeral accounts.
5. Force-release stuck cluster-scope locks in vRO.
6. Cleanup staged depot files on datastores.
7. Update / remove CE-05 entries.

**FR-40.** WF-07 SHALL NEVER enter maintenance mode. Cleanup is by definition undoing previous state, not creating new state.

**FR-41.** WF-07 SHALL alert-email and remove CE-05 entries older than 30 days that have persistently failed cleanup (configurable via CE-01 attribute `maxRetryAgeDays`).

### Logging and Observability

**FR-42.** WF-01 SHALL set the log marker as the first action: `Workflow Name:<workflow-name>-WorkflowRunId:<workflow-run-id>` per the architect's specification. Child workflows (WF-02, WF-03) inherit this marker automatically because vRO's log marker propagates to child workflow scopes when set in the parent.

**FR-43.** All log messages SHALL use the structured format `[<prefix>] [<phase>] [<status>] <message>` for per-line readability where:
- `<prefix>` is `[ESXI-REMEDIATE-VC]`, `[ESXI-REMEDIATE-CL]`, or `[ESXI-REMEDIATE-HOST]`.
- `<phase>` is from the FR-19 phase enumeration plus `STARTUP`, `VALIDATE`, `AUTH`, `DISCOVER`, `DECIDE`, `EXECUTE`, `VERIFY`, `CLEANUP`, `ERROR`.
- `<status>` is `OK`, `SKIP`, `DONE`, `DRY-RUN`, `HOLD`, `WARN`, `FAIL`, `RESULT`.

**FR-44.** Audit-level log lines (always emitted regardless of `debugLogging`) include workflow start/end with summary, cluster start/end, host start/end, phase transitions, failures with full context, emails sent, and significant state transitions.

**FR-45.** Debug-level log lines (gated by `debugLogging = true`) include vCenter SDK call inputs/outputs, SSH command full stdout/stderr, intermediate variables, loop iteration counters.

**FR-46.** Reusable Actions `com.broadcom.pso.common.logging.initWorkflowLogging`, `auditLog`, and `debugLog` SHALL be added to the architect's library.

### Notifications

**FR-47.** The workflow SHALL send an HTML email at the end of every run (any outcome) containing:
- Summary table with per-cluster outcome counts.
- Per-cluster section detailing each host's outcome, per-phase status, build pre/post, failure reason.
- VMSA reference (per AD-13, always populated since field is required).
- Run metadata (vCenter, depot, run ID, start/end times, duration).
- Note about VxRail Manager noncompliance alarms expected post-patch.

**FR-48.** The workflow SHALL send an immediate intervention email when:
- Any host failure leaves a host in a state requiring manual recovery (Scenario C per AD-09).
- A host has cleanup failures with the host still usable (Scenario B per AD-09) — informational, no halt.
- WF-07 reconciliation completes with cleanup activities performed.

**FR-49.** Final summary emails and run reports SHALL include a record of every email sent during the run (timestamp, recipients, subject) per the audit trail requirement.

**FR-50.** All emails SHALL be sent via `com.vmware.library.mail.sendMail` using SMTP host registered in vRO inventory (per C-04). Recipients = operator-supplied + fixed cc list from CE-01 (currently empty per C-07; admin-configurable).

### Outputs to VCF Automation (per C-11 Pattern B)

**FR-51.** The vCenter-level workflow's deployment record in VCF Automation SHALL persist after completion (Pattern B — no self-delete) and expose:
- `runStatus` — String enum (`SUCCESS`, `COMPLETED_WITH_WARNINGS`, `COMPLETED_WITH_ERRORS`, `DRY_RUN_COMPLETE`, `ABORTED`).
- `runSummary` — Multi-line plain text.
- `runReportHtml` — Full HTML report.
- `vmsaReference` — String (always populated per AD-13).
- `clustersAttempted`, `clustersSucceeded`, `clustersFailed`, `clustersSkipped` — Integers.
- `clusterResults` — Array/Properties.
- `emailsSent` — Array/Properties.
- `failedClusters` — Array/string (clusters ending in FAILED, PARTIAL, or HALTED).

**FR-52.** A 365-day VCF Automation lease policy SHALL be documented in the Implementation Guide as recommended configuration.

### Optional Components

**FR-53.** WF-04 (`Validate vSphere Environment Remediation Prerequisites`) SHALL be provided per C-06: runs all pre-flight checks against operator-selected scope and produces a go/no-go report without making changes.

---

## 2.3 Non-Functional Requirements

**NFR-01. Performance — single-host worst case.** A single host's patching procedure SHALL complete in ~60 minutes nominal under typical conditions. Dominant time: reboot + reconnect + HA rejoin (~30 minutes total).

**NFR-02. Performance — cluster worst case.** N-host cluster ≈ N × (per-host time) + ~5 minutes overhead.

**NFR-03. Performance — vCenter run worst case.** With `maxParallelClusters = 3` and M clusters of average 8 hosts, ≈ ⌈M / 3⌉ × 7 hours.

**NFR-04. Concurrency.** Workflow supports multiple simultaneous runs against different vCenters. Same vCenter with non-overlapping clusters supported (cluster-scope locks); overlapping selections result in second run skipping locked clusters.

**NFR-05. Logging integration.** All workflow logs SHALL be forwarded to VCF Operations for Logs via standard VCF 9.x integration. Logs filterable by workflow run ID via the log marker.

**NFR-06. Scheduling.** This workflow is **on-demand only**. No schedule for the catalog item. WF-07 (reconciliation) runs on a daily admin-configurable schedule.

**NFR-07. Service account privileges.** Per C-16, the vRO service account SHALL have **Administrator role at the vCenter level**, encompassing all required privileges (MM enter/exit, local user account management, permission/role assignment, host service start/stop, datastore file operations, read access to cluster/host/vSAN/HA/DRS configuration).

**NFR-08. Auditability.** Every state-changing action SHALL be logged at audit level with timestamp, actor (workflow run ID), target host FQDN, action, and outcome.

**NFR-09. Idempotency.** All cleanup operations SHALL be idempotent. Re-running the workflow against an already-patched cluster SHALL detect hosts at target build via build comparison and classify them `SKIPPED` with reason "already at target build."

**NFR-10. Maintainability.** All Actions follow the modular pattern (single-purpose, importable, well-documented). The reusable Actions added to `com.broadcom.pso.common.*` SHALL be usable by other projects without modification.

**NFR-11. Security — credentials at rest.** Per AD-08, no persistent ESXi credentials. Ephemeral accounts created per-run with strong random passwords (32+ characters, full keyspace), used only within the workflow run, destroyed at host procedure end.

**NFR-12. Security — SSH state.** SSH on each host SHALL be enabled only for the duration of the per-host procedure. Disabled immediately after, regardless of patching outcome.

**NFR-13. Security — privilege segregation.** The ephemeral account is created with Admin role for the duration of patching. The Admin role grants ESXi-equivalent of root. Account is destroyed post-patch.

---

## 2.4 Inputs and Outputs

### 2.4.1 `Remediate vSphere Environment` Inputs (operator-facing)

| Name | Type | Default | Required | Section | Description |
|---|---|---|---|---|---|
| `vmsaReference` | string | — | yes | 1 | VMSA reference per AD-13. Format `^VMSA-\d{4}-\d{4}$`. |
| `acknowledgement` | boolean | false | yes (must be true) | 1 | Ack1, gated by valid VMSA. |
| `vcenter` | VC:SdkConnection | — | yes | 2 | Single vCenter selection. |
| `depotItem` | Properties (CL item ref) | — | yes | 3 | Content Library item for ESXi depot. |
| `targetClusters` | Array/VC:ClusterComputeResource | — | yes (≥1) | 4 | Multi-select cluster scope. |
| `validationSummaryAcknowledgement` | boolean | false | yes (must be true) | 4 | Inline acknowledgement of Validation Summary findings. |
| `smallClusterAcknowledgement` | boolean | false | conditional | 4 | Required when 4-node clusters in selection (Ack2). |
| `notificationEmailRecipients` | string | — | yes | 5 | Comma-separated email recipients. |
| `maxParallelClusters` | number | 3 | yes | 6 | Bounded parallelism cap. |
| `hostRebootTimeoutMinutes` | number | 25 | yes | 6 | Reboot wait timeout. Documented range from C-10: 20-25 minutes. |
| `bypassHardwareCheck` | boolean | false | yes | 6 | Append `--no-hardware-warning`. |
| `dryRun` | boolean | true | yes | 6 | Plan-only run (default true; live execution requires explicit opt-out). |
| `debugLogging` | boolean | false | yes | 6 | Verbose debug logging. |
| `ignorePreflightWarnings` | boolean | false | yes | 6 | Silence non-blocking pre-flight warnings (per FR-14). |
| `patchStagingMode` | string | `CONTENT_LIBRARY_DIRECT` | yes | (hidden, computed) | One of `CONTENT_LIBRARY_DIRECT`, `CLUSTER_DATASTORE_STAGE`. |
| `reviewAcknowledgement` | boolean | false | yes (must be true) | 7 | Final review acknowledgement (Ack3). |

### 2.4.2 `Remediate vSphere Environment` Outputs (per FR-51)

See FR-51 for the full output specification.

### 2.4.3 Internal workflow inputs/outputs

Internal workflows (`Remediate vSphere Cluster`, `Remediate ESX Host`) accept inputs derived from the parent's selections. The host-level workflow generates its ephemeral account credentials internally per AD-08 — no `sshCredentials` input flows from parent to child. Detailed schemas in the Phase 3 design document.

---

## 2.5 Exclusions (Out of Scope)

**EX-01.** PowerFlex clusters (per AD-06).

**EX-02.** Generic vSAN clusters not VxRail-managed.

**EX-03.** Cross-major-version ESXi upgrades (per AD-01, C-14).

**EX-04.** Pre-8.0 ESXi hosts (per C-14).

**EX-05.** Automated rollback (per AD-03).

**EX-06.** 3-node VxRail clusters (per AD-04 hybrid policy).

**EX-07.** Direct interaction with VxRail Manager beyond passive task detection.

**EX-08.** Direct interaction with PowerFlex Manager (PFMP) (per AD-06).

**EX-09.** Firmware, BIOS, iDRAC, or non-ESXi component updates.

**EX-10.** vSAN on-disk format upgrades, vSAN HCL compliance enforcement, vSAN configuration changes.

**EX-11.** Scheduled execution of the main remediation workflow. On-demand only. (WF-07 reconciliation IS scheduled.)

**EX-12.** CyberArk CCP retrieval (per AD-05, AD-08; moot for v1).

**EX-13.** Parallel host patching within a cluster.

**EX-14.** Awaiting User Interaction during workflow execution. All warnings and acknowledgements are form-time.

**EX-15.** Provisioning, modifying, or removing vRO infrastructure (inventory connections, Configuration Elements at infrastructure level, SMTP host entries).

**EX-16.** Layer 0 estate-wide wrapper. Multi-vCenter patching is N submissions of the per-vCenter workflow.

**EX-17.** WF-07 entering hosts into MM. WF-07 only exits MM (cleanup direction); never enters MM as part of cleanup.

---

## 2.6 Assumptions

**ASM-01.** All vCenters in scope are registered in vRO inventory as `VC:SdkConnection` objects with healthy SDK connections.

**ASM-02.** A Content Library matching the configured name pattern (per CE-01 `esxiPatchContentLibraryNamePattern`, default `ESXi-Patches`) exists in each vCenter where patching will occur.

**ASM-03.** VxRail clusters in scope have at least 4 hosts (3-node BLOCKED per AD-04).

**ASM-04.** All ESXi hosts in scope are on ESXi 8.x (per C-14).

**ASM-05.** vRO embedded SMTP host is correctly configured (per C-04).

**ASM-06.** Within-major-version patches only (per C-14).

**ASM-07.** Operators have organizational authority for manual ESXi patching outside vLCM/VxRail Manager.

**ASM-08.** Customer accepts VxRail Manager noncompliance alarms post-patch and reconciles them through documented manual steps.

**ASM-09.** VCF Operations for Logs is integrated with vRO and ingests logs automatically.

**ASM-10.** Network permits vRO ↔ vCenter (port 443) and vRO ↔ ESXi (port 22 during brief SSH windows).

**ASM-11.** Operators have appropriate VCF Automation role-based access to launch the catalog item.

**ASM-12.** vCenter-mediated MM enter/exit, account creation, permission grant, and host service control are accessible to the vRO Administrator-level service account (per C-16, NFR-07).

---

## 2.7 Constraints

**CON-01.** Solution runs entirely on embedded VCF Orchestrator. No external compute, file shares, or appliances.

**CON-02.** vRO 9.x supported scripting runtimes only. JavaScript primary (Rhino-based, no ES6+).

**CON-03.** Use vCenter Server plugin native objects and `com.vmware.library.vc.*` Actions where possible.

**CON-04.** Conform to architect's existing patterns: log markers, structured log prefixes, transient REST hosts, Properties for key-value data, `System.getModule()` for Action calls.

**CON-05.** Solution deliverable as importable vRO content with no manual code modification at import time.

**CON-06.** Developed against current VCF 9.x in customer production.

**CON-07.** ESXi root SSH cannot be permanently enabled (per NFR-12).

**CON-08.** Dell KB 000345284 is authoritative reference for per-host steps. No deviation from KB sequence without explicit customer approval.

---

## 2.8 Risks and Mitigations

| ID | Risk | Likelihood | Impact | Mitigation | Residual Risk |
|---|---|---|---|---|---|
| **R-01** | Patch ZIP incompatible with target hardware. | MEDIUM | MEDIUM | Caught at PATCH_INSTALL phase. Cluster halts (Scenario C). Operator can retry with `bypassHardwareCheck` if appropriate. | LOW |
| **R-02** | Host fails to reboot. | LOW | HIGH | Reboot timeout catches this. Manual recovery runbook in User Guide. WF-07 catches orphan accounts when host eventually returns. | MEDIUM |
| **R-03** | Host reconnects but reports old build (silent install failure). | LOW | MEDIUM | VERIFY_BUILD catches. Cluster halts. | LOW |
| **R-04** | Account creation fails (host service in unexpected state, hardening blocks). | LOW | LOW | Caught at AUTH_PROVISION. No cleanup needed. Cluster halts. | VERY LOW |
| **R-05** | Account creation succeeds but role grant fails (orphan account with no permissions). | LOW | LOW | Caught at AUTH_PROVISION's role-grant step. DEH deletes the orphan account. | VERY LOW |
| **R-06** | Cluster lock orphaned by hard workflow crash. | LOW | LOW | DEH releases locks. WF-07 force-releases stuck locks. WF-05 manual admin tool available. | VERY LOW |
| **R-07** | Two workflow runs select overlapping clusters. | MEDIUM | LOW | Cluster-scope locks; second run skips. | VERY LOW |
| **R-08** | Operator selects a depot for wrong ESXi major version. | MEDIUM | HIGH | Form-time and workflow-start version mismatch checks. C-14 confirms within-major-version-only scope. Pre-8.0 hosts blocked at pre-flight. | LOW |
| **R-09** | VxRail Manager runs automated reconciliation during patch window. | LOW | MEDIUM | Pre-flight checks recent VxRail Manager tasks (warning, silenceable). Cluster lock prevents OUR workflows colliding but cannot prevent VxRail Manager. | MEDIUM |
| **R-10** | Long-lived ephemeral account on offline (failed-reboot) host. | LOW | LOW | Strong random password (32+ chars, full keyspace). WF-07 catches when host returns (daily). Audit trail in CE-05 + emails. | LOW |
| **R-11** | Patch ZIP corrupt or truncated. | LOW | MEDIUM | PATCH_LIST acts as smoke test for depot integrity. Halts before any host modified. | LOW |
| **R-12** | DRS migration constraints block MM entry on a host. | MEDIUM | LOW | Form-time DRS migration constraint check warns. Per-host check prevents MM hang. Failed host classified Scenario C. | LOW |
| **R-13** | vSAN cluster degraded but no active resync (e.g., disk failure). | MEDIUM | HIGH | Form-time vSAN health check (curated subset) flags. Operator decides. | MEDIUM (operator discretion) |
| **R-14** | Cluster halts mid-patch leaves host in MM (Scenario C). | MEDIUM | MEDIUM | Documented manual recovery. Intervention email. WF-07 recovers if host returns. | MEDIUM |
| **R-15** | VCF Automation deployment lifecycle policy not configured. | MEDIUM | LOW | Implementation Guide includes 365-day lease as recommended. | LOW |
| **R-16** | WF-07 itself fails or is misconfigured (no schedule). | MEDIUM | MEDIUM | Implementation Guide makes WF-07 schedule a required step. Smoke test verifies. WF-05 and WF-06 manual admin tools available as backup. | LOW |
| **R-17** | CE-05 corruption from concurrent writes. | LOW | MEDIUM | Global lock `CE_05_RUN_TRACKER_LOCK` serializes all CE-05 reads/writes. | VERY LOW |
| **R-18** | Operator cancels workflow mid-run; resources orphaned. | MEDIUM | LOW | Each layer's DEH performs cleanup on cancel. WF-07 daily catches anything DEH missed. | LOW |
| **R-19** | 4-node cluster patched with no headroom; concurrent host failure during patch window. | LOW | HIGH | Required Ack2 acknowledgement for 4-node clusters surfaces the risk to operator. AD-04 blocks 3-node entirely. | MEDIUM (informed acceptance) |
| **R-20** | HA agent fails to rejoin cluster after MM exit (HA_REJOIN failure). | LOW | MEDIUM | Per AD-09: host marked FAILED at HA_REJOIN; not counted toward cluster capacity for subsequent residual checks. | LOW |
| **R-21** | VMSA required field becomes operational friction (lackadaisical management). | MEDIUM | LOW | Per AD-13, this friction is intentional — surfaces compliance pressure rather than hiding it. Operators escalate to leadership rather than silently bypass. | ACCEPTABLE (intentional) |

---

## 2.9 Reusable Assets

The customer's existing reusable Action library is minimal. The following are NEW and added to the reusable library:

| Module Path | Action | Purpose |
|---|---|---|
| `com.broadcom.pso.common.logging` | `initWorkflowLogging` | Log marker setup + WorkflowStart audit. |
| `com.broadcom.pso.common.logging` | `auditLog` | Unconditional audit log with structured format. |
| `com.broadcom.pso.common.logging` | `debugLog` | Gated debug log. |
| `com.broadcom.pso.common.workflow` | `runWithParallelism` | Async fan-out with bounded parallelism, asymmetric scheduling. |
| `com.broadcom.pso.common.workflow` | `releaseAllLocksHeldByWorkflow` | DEH-driven lock cleanup. |
| `com.broadcom.pso.common.workflow` | `withRetry` | vCenter SDK retry-with-backoff wrapper. |
| `com.broadcom.pso.common.config` | `getConfigurationElementValue` | Standard CE accessor with type handling. |
| `com.broadcom.pso.common.config` | `getEncryptedConfigurationElementValue` | Encrypted CE accessor returning SecureString. |

Project-specific Actions are detailed in the Phase 3 design document under module path `com.broadcom.pso.vc.esxi.remediation.*`.

---

## 2.10 Acceptance Criteria

**AC-01.** Dry-run execution against a healthy 4-node VxRail cluster (with Ack2 checked) completes with `runStatus = DRY_RUN_COMPLETE`, ephemeral account created and destroyed, no MM entry, no esxcli profile update executed.

**AC-02.** Live execution against a single test VxRail host successfully completes all 14 phases through `AUTH_CLEANUP`, returns `outcome = SUCCESS`, build verified changed.

**AC-03.** A live execution where patch install fails on a single host correctly classifies as Scenario A or B (depending on cleanup outcome), continues cluster (residual capacity permitting), sends intervention email per requirement, reports correctly.

**AC-04.** A live execution where reboot fails (Scenario C) halts the cluster, leaves host in known unrecoverable state, sends intervention email immediately, ends with `runStatus = COMPLETED_WITH_ERRORS`.

**AC-05.** Two simultaneous runs against the same vCenter with overlapping clusters: second run reports overlapping clusters as `SKIPPED — Cluster locked`, processes non-overlapping selections normally.

**AC-06.** Pre-flight correctly refuses 3-node clusters (BLOCKED), correctly requires Ack2 for 4-node clusters, correctly proceeds for 5+ clusters.

**AC-07.** Pre-flight correctly identifies and refuses PowerFlex, generic vSAN, VMFS-only, and pre-8.0 ESXi clusters with appropriate labels in the picker.

**AC-08.** Validation Summary text area populates correctly with CRITICAL/WARNING/READY findings; required acknowledgement gates submission.

**AC-09.** vSAN health check filters to curated subset by default; advanced toggle exposes all groups.

**AC-10.** DRS migration constraint check identifies non-migratable VMs and surfaces in Validation Summary.

**AC-11.** Depot version mismatch surfaces in cluster picker labels (per C-12) when patch is selected before clusters.

**AC-12.** Final HTML email contains: summary table, per-cluster breakdown, per-host detail, run metadata, VMSA reference, VxRail noncompliance note.

**AC-13.** VCF Automation deployment record persists post-completion (Pattern B), all outputs populated, `runReportHtml` viewable directly on deployment detail page.

**AC-14.** Cluster-scope locks correctly released after normal completion, after handled failure, after simulated uncaught exception.

**AC-15.** All workflow logs appear in VCF Operations for Logs and are filterable by run ID via the log marker.

**AC-16.** Re-running against an already-patched cluster correctly identifies hosts at target build and skips.

**AC-17.** Debug logging toggle correctly produces verbose traces when enabled, audit-only when disabled.

**AC-18.** Reusable Actions in `com.broadcom.pso.common.*` invocable from a separate test workflow without modification.

**AC-19.** WF-07 (reconciliation) scheduled execution: detects a `failed` workflow with CE-05 entries, performs autonomous cleanup of accounts/permissions/SSH/MM as needed, updates CE-05, sends summary email.

**AC-20.** WF-07 startup defensive check correctly prevents concurrent execution.

**AC-21.** Cleanup ordering verified: exit MM → disable SSH → remove permission → delete account. Idempotent re-execution treats "already absent" as success.

**AC-22.** Orphan permission entries (account already removed, permission grant remaining) detected by enumeration and cleaned up correctly.

**AC-23.** Three acknowledgement gates: form cannot submit without Ack1 (gated by valid VMSA), Ack2 (when 4-node clusters selected), or Ack3.

**AC-24.** `dryRun` defaults to true on every form load; live execution requires explicit operator opt-out.

**AC-25.** VMSA reference field validation: empty NOT allowed (required per AD-13), format `VMSA-YYYY-NNNN` strictly enforced, Ack1 enabled only when format-valid.

**AC-26.** Review section displays all form values regardless of defaults.

**AC-27.** Lockdown-mode hosts contribute to FTT/HA capacity calculations but are skipped (not patched).

**AC-28.** Residual-capacity dynamic check correctly halts cluster before patching the next host when 1-host headroom rule would be violated.

---

## Document control

**Status:** Consolidated post-reconcile. Ready for Phase 4 (Code Generation) on architect approval.

