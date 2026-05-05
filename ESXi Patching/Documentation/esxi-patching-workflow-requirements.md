# ESXi Patching Workflow — Requirements Document (Phase 2)

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail)
> **Document version:** 1.0 (DRAFT — pending customer responses to open items)
> **Date:** 2026-05-04
> **Companion document:** `esxi-patching-workflow-open-items.md`

---

## How to read this document

This is the formal contract between the customer and the development team for what will be built. Every requirement here is in scope; everything not here is out of scope.

Several items still depend on customer responses to open questions (tracked in the companion `esxi-patching-workflow-open-items.md` file as **C-XX** items). Wherever this document refers to a default assumption that is pending customer confirmation, the relevant `C-XX` reference is included inline. When customer responses arrive, this document will be updated to remove those flags and lock the relevant text.

Architectural decisions already locked are referenced as **AD-XX** (also in the companion file).

---

## 2.1 Project Overview

### 2.1.1 Project Name

**Manual ESXi Patching Automation for VxRail Clusters** (working title — final name TBD per customer naming conventions during catalog publication).

### 2.1.2 Problem Statement

The customer operates a VCF 9.x environment with 7-10 vCenters managing VxRail clusters running vSphere 8. Their normal ESXi patching path — vSphere Lifecycle Manager (vLCM) baselines and VxRail Manager-driven upgrades — has been unreliable in their environment. Patches frequently fail to install through the normal management tooling, and remediation through Dell Support has been slow enough that it is impacting the customer's ability to meet security-mandated patching SLAs imposed by senior leadership. As a result, operators are currently performing the manual patching procedure documented in Dell KB 000345284 by hand, host by host, which is labor-intensive, error-prone, and does not scale to the customer's estate.

### 2.1.3 Solution Summary

A layered set of three VCF Orchestrator workflows automates the Dell KB 000345284 manual ESXi patching procedure for VxRail clusters. The top-level workflow, `Patch ESXi vCenter`, is published as a VCF Automation catalog item and accepts operator-supplied scope (which clusters within a chosen vCenter), patch source (a depot ZIP from a Content Library), and execution parameters. The workflow performs comprehensive pre-flight validation, processes clusters in parallel up to a configurable cap, walks each cluster's hosts sequentially through the KB-prescribed maintenance-mode-enter / SSH-enable / esxcli-update / reboot / verify / SSH-disable / maintenance-mode-exit cycle, and produces a detailed run report viewable in the VCF Automation deployment record and emailed to operator-supplied recipients. PowerFlex clusters are explicitly out of scope; the workflow refuses to operate on any cluster not positively identified as a VxRail cluster.

---

## 2.2 Functional Requirements

### Workflow Structure

**FR-01.** The system SHALL be implemented as three layered Orchestrator workflows per AD-07: `Patch ESXi vCenter` (Layer 1, catalog item), `Patch ESXi Cluster` (Layer 2, internal), and `Patch ESXi Host` (Layer 3, internal).

**FR-02.** Only the `Patch ESXi vCenter` workflow SHALL be exposed as a VCF Automation catalog item. The cluster and host workflows SHALL be internal-only, callable only by their respective parents.

**FR-03.** The `Patch ESXi vCenter` workflow SHALL invoke instances of `Patch ESXi Cluster` asynchronously, using the reusable `com.broadcom.pso.common.workflow.runWithParallelism` Action to maintain bounded parallelism across clusters with true asymmetric scheduling (a faster-completing cluster frees a worker slot for the next queued cluster regardless of slower clusters still running).

**FR-04.** The `Patch ESXi Cluster` workflow SHALL invoke instances of `Patch ESXi Host` synchronously and sequentially — exactly one host at a time per cluster, per the vSAN FTT=1 constraint identified in Dell KB 000345284.

**FR-05.** Each child workflow SHALL return a structured result object to its parent containing outcome classification, per-step status, and contextual data per the contracts defined in AD-07.

### Operator Inputs

**FR-06.** The `Patch ESXi vCenter` workflow's request form SHALL implement the six-section layout defined in C-12: Acknowledgement, Scope Selection, Patch Source, Execution Parameters, Notification, and Advanced.

**FR-07.** The Acknowledgement section SHALL contain a mandatory checkbox stating: *"I acknowledge this is manual VxRail patching outside vLCM/VxRail Manager and may trigger noncompliance alarms."* The form SHALL NOT permit the operator to advance past this section without checking the box.

**FR-08.** The Scope Selection section SHALL provide:
- A single-select vCenter picker, populated by an external-value action that lists all vCenter Server inventory connections registered in vRO.
- A multi-select cluster picker, dependent on the selected vCenter, populated by an external-value action that lists all clusters in the selected vCenter, each labeled with its cluster type and health status per FR-09.

**FR-09.** The cluster picker SHALL label each cluster with one of the following decorations:
- `(VXRAIL — READY)` — selectable.
- `(VXRAIL — WARNING: <reason>)` — selectable; warnings can be silenced with `ignorePreflightWarnings`.
- `(VXRAIL — BLOCKED: <reason>)` — visible but not selectable.
- `(POWERFLEX — NOT SUPPORTED)` — visible but not selectable.
- `(VSAN-ONLY — NOT SUPPORTED)` — visible but not selectable.
- `(OTHER — NOT SUPPORTED)` — visible but not selectable (e.g., VMFS/NFS-only clusters).

**FR-10.** The Patch Source section SHALL provide a Content Library item picker, dependent on the selected vCenter, populated from the Content Library named in the `esxiPatchContentLibraryName` Configuration Element value (default `ESXi-Patches`, pending C-09), filtered to items whose names match the regular expression `^VMware-ESXi-.*-depot\.zip$`.

**FR-11.** The Patch Source section SHALL provide a `patchStagingMode` selector with two values: `CONTENT_LIBRARY_DIRECT` (default if Content Library backing supports it) and `CLUSTER_DATASTORE_STAGE`. (Pending C-01: if customer confirms NFS-backed CL universally, the staging-mode selector may be eliminated and only `CONTENT_LIBRARY_DIRECT` mode used.)

**FR-12.** The Execution Parameters section SHALL provide:
- `maxParallelClusters` — integer, default 3, range 1–20, special value 0 = unlimited.
- `hostRebootTimeoutMinutes` — integer, default 25 (pending C-10), range 5–60.
- `bypassHardwareCheck` — boolean, default false, with warning text describing when this flag should be used.

**FR-13.** The Notification section SHALL provide a `notificationEmailRecipients` text field accepting a comma-separated list of email addresses. At least one address SHALL be required for the form to submit.

**FR-14.** The Advanced section SHALL be collapsed by default and SHALL contain:
- `debugLogging` — boolean, default false.
- `ignorePreflightWarnings` — boolean, default false.
- `dryRun` — boolean, **default true** (operator must explicitly opt out for a live run).

### Pre-flight Validation (Two-Tier per C-12)

**FR-15.** Form-time (cheap) checks SHALL execute as the operator selects clusters and SHALL evaluate: cluster type identification (VxRail vs. other), HA enabled, DRS enabled and fully automated, current host count in the cluster, current maintenance-mode state of all hosts in the cluster.

**FR-16.** Workflow-start-time (full) checks SHALL execute in `Patch ESXi Cluster`'s pre-flight phase before any host is touched and SHALL repeat all form-time checks plus: active vSAN resync detection, recent-task analysis to detect the cluster being operated on by another workflow or by VxRail Manager.

**FR-17.** The following conditions SHALL block a cluster from being processed (refused with clear error, no override possible):
- Cluster is not a VxRail cluster.
- Cluster has fewer than 4 hosts (per AD-04).
- HA is not enabled or not healthy.
- DRS is not enabled or not set to fully automated.
- Any host in the cluster is currently in maintenance mode.
- Active vSAN resync is in progress.

**FR-18.** The following conditions SHALL warn but not block, and SHALL be silenceable via `ignorePreflightWarnings = true`:
- Cluster appears to be the subject of a recent or in-progress task originating from VxRail Manager or another orchestrator workflow.

### Per-Host Patching Procedure

**FR-19.** For each host in scope, the workflow SHALL execute the following procedure sequentially, per Dell KB 000345284:

1. **Pre-host check (`MM_ENTER` precondition):** Verify no other host in the same cluster is currently in maintenance mode. If another host is in MM, halt the cluster immediately (do not enter MM on this host).
2. **Enable SSH (`SSH_ENABLE`):** Start the `TSM-SSH` service on the host via the vCenter `HostServiceSystem` API.
3. **Enter Maintenance Mode (`MM_ENTER`):** Place the host into maintenance mode using the `EnsureObjectAccessibility` vSAN data movement option, per KB 000345284.
4. **List patch profiles (`PATCH_LIST`):** SSH to the host as root and run `esxcli software sources profile list --depot=<depot-path>` to enumerate available profiles in the depot. Select the profile whose name ends in `-standard`.
5. **Install patch (`PATCH_INSTALL`):** SSH to the host and run `esxcli software profile update -p <selected-profile> --depot=<depot-path>` (with `--no-hardware-warning` appended if `bypassHardwareCheck = true`). Capture full stdout, stderr, and exit code.
6. **Reboot (`REBOOT`):** Initiate host reboot via the vCenter SDK.
7. **Reconnect verify (`RECONNECT`):** Poll the host's vCenter connection state every 30 seconds until reconnected, or until `hostRebootTimeoutMinutes` elapses. On timeout, fail the host.
8. **Verify build (`VERIFY_BUILD`):** Read `host.config.product.build` and confirm it differs from the pre-patch build. If unchanged, fail the host.
9. **Disable SSH (`SSH_DISABLE`):** Stop the `TSM-SSH` service on the host.
10. **Exit Maintenance Mode (`MM_EXIT`):** Remove the host from maintenance mode.

**FR-20.** Any failure in steps 1–10 SHALL cause the host to be classified as `FAILED` with the specific phase recorded in `failurePhase`. Subsequent hosts in the same cluster SHALL NOT be processed.

**FR-21.** If `dryRun = true`, the workflow SHALL execute steps 1–2 (pre-host check, enable SSH) and step 4 (list patch profiles, to verify the depot is readable and contains a valid profile), but SHALL skip steps 3, 5, 6, 7, 8, 10. Step 9 (disable SSH) SHALL still run to leave the host in its original SSH state. The host SHALL be classified `DRY_RUN`.

### Patch Staging

**FR-22.** When `patchStagingMode = CONTENT_LIBRARY_DIRECT`, the workflow SHALL resolve the selected Content Library item to its on-disk path on the CL backing datastore and pass that path directly to the `esxcli` commands. The workflow SHALL verify the CL backing datastore is mounted on the host before proceeding.

**FR-23.** When `patchStagingMode = CLUSTER_DATASTORE_STAGE`, the workflow SHALL:
- Identify a cluster-shared datastore (heuristic: a VMFS or NFS datastore mounted on every host in the cluster, with at least 2× the depot ZIP size in free space).
- Copy the depot ZIP from the CL backing datastore to a workflow-owned directory on the cluster-shared datastore using the vSphere `FileManager` API.
- Pass the staged path to `esxcli`.
- After all hosts in the cluster are processed (success or failure), delete the staged copy.

**FR-24.** The staging copy SHALL be deleted in the cluster's cleanup phase even if the cluster halts due to host failure. The deletion SHALL be best-effort; failure to delete SHALL log a warning but not fail the workflow.

### Concurrency and Locking

**FR-25.** Each `Patch ESXi Cluster` instance SHALL acquire a cluster-scope lock named `ESXI_PATCH_<vcenter-fqdn>_<cluster-moref>` via `LockingSystem.lockAndWaitForOwnership` before performing any pre-flight checks.

**FR-26.** If a cluster's lock cannot be acquired (because another workflow run holds it), the cluster SHALL be classified `SKIPPED` with reason `Cluster locked by run <other-run-id>` and the parent workflow SHALL continue with other clusters. The workflow SHALL NOT wait indefinitely for a held lock.

**FR-27.** The cluster-scope lock SHALL be released in all exit paths from `Patch ESXi Cluster`: normal completion, handled failure, and uncaught exception. Lock release SHALL be implemented in the workflow's default error handler so it executes even when the script logic crashes.

**FR-28.** A separate auxiliary workflow `Release ESXi Patch Locks` SHALL be provided for manual cleanup of orphaned locks in cases where a workflow crashes so badly that the default error handler does not fire.

### Logging and Observability

**FR-29.** Each workflow SHALL set its log marker as the first action in its execution, using the format `WorkflowName:<workflow-name> WorkflowRunId:<workflow-run-id>` per the established standard.

**FR-30.** All log messages SHALL use the structured format `[ESXI-PATCH-VC|CL|HOST] [<PHASE>] [<STATUS>] <human-readable message>`, where:
- The short-name token identifies the workflow layer: `ESXI-PATCH-VC` for vCenter layer, `ESXI-PATCH-CL` for cluster layer, `ESXI-PATCH-HOST` for host layer.
- `<PHASE>` is one of: `STARTUP`, `VALIDATE`, `AUTH`, `DISCOVER`, `DECIDE`, `EXECUTE`, `VERIFY`, `CLEANUP`, `ERROR`.
- `<STATUS>` is one of: `OK`, `SKIP`, `DONE`, `DRY-RUN`, `HOLD`, `WARN`, `FAIL`, `RESULT`.

**FR-31.** Audit-level log lines (always emitted regardless of `debugLogging`) SHALL include:
- Workflow start and end with run summary.
- Each cluster processing start and end with outcome.
- Each host processing start and end with outcome and per-phase status.
- Every failure with full message and context.
- Every email sent (timestamp, recipients, subject).
- Every state transition (MM enter/exit, SSH enable/disable, reboot start/complete).

**FR-32.** Debug-level log lines (gated behind `debugLogging = true`) SHALL include:
- vCenter SDK call inputs and outputs.
- SSH command inputs and full stdout/stderr.
- Intermediate variable values.
- Loop iteration counters.
- Configuration values being read.

**FR-33.** A reusable Action `com.broadcom.pso.common.logging.initWorkflowLogging(prefix)` SHALL be implemented to perform the log-marker setup and emit the workflow-start audit log line.

**FR-34.** A reusable Action `com.broadcom.pso.common.logging.debugLog(prefix, phase, status, message, debugEnabled)` SHALL be implemented to provide the gated debug logging behavior.

### Notifications

**FR-35.** The workflow SHALL send an HTML email at the end of every run (success, partial, failed, or dry-run) containing:
- A summary table at the top with per-cluster outcome counts.
- A per-cluster section detailing each host's outcome, per-phase status, build pre/post, and failure reason if applicable.
- The vCenter, depot used, run ID, run start time, run duration.
- A note (if applicable) about VxRail Manager noncompliance alarms expected post-patch.

**FR-36.** The workflow SHALL send an immediate intervention email when any host failure leaves a host in a state requiring manual recovery (in MM with patch attempt completed but reboot/reconnect/verify failed). This email SHALL include:
- The specific host(s) requiring intervention.
- The phase and reason of failure.
- A reference to the manual recovery runbook section in the User Guide.
- A timestamp of the failure.

**FR-37.** The final summary email and the run report output SHALL include a record of every email sent during the run (timestamp, recipients, subject), per the requirement captured in discovery batch 3.

**FR-38.** All emails SHALL be sent via the out-of-box `com.vmware.library.mail` action using the SMTP host registered in vRO inventory (pending C-04 confirmation).

### Outputs to VCF Automation

**FR-39.** Per AD-07 and the Pattern B decision (C-11), the `Patch ESXi vCenter` workflow's deployment record in VCF Automation SHALL persist after completion (no self-delete) and SHALL expose the following outputs for display on the deployment detail page:
- `runStatus` — String, one of `SUCCESS`, `COMPLETED_WITH_WARNINGS`, `COMPLETED_WITH_ERRORS`, `DRY_RUN_COMPLETE`, `ABORTED`.
- `runSummary` — String (multi-line plain text summary).
- `runReportHtml` — String (full HTML report, same content as the email body).
- `clustersAttempted`, `clustersSucceeded`, `clustersFailed`, `clustersSkipped` — Integers.
- `clusterResults` — Array/Properties with detailed per-cluster results.
- `emailsSent` — Array/Properties with timestamps, recipients, and subjects of all emails dispatched.
- `failedClusters` — Array of cluster names that ended in `FAILED` or `PARTIAL` status.

**FR-40.** A 365-day VCF Automation lease policy SHALL be documented (in the Implementation Guide) as a recommended configuration on the catalog item to auto-purge old job records.

### Optional Components

**FR-41.** A sibling workflow `Validate ESXi Patching Prerequisites` SHALL be provided (pending C-06 confirmation) that runs all pre-flight checks against an operator-selected vCenter and cluster scope but performs no changes. Output is a go/no-go report.

---

## 2.3 Non-Functional Requirements

**NFR-01. Performance — single-host worst case.** A single host's patching procedure SHALL complete in 60 minutes or less under nominal conditions, with the dominant time contribution being the reboot + reconnect window (configurable via `hostRebootTimeoutMinutes`, default 25 minutes).

**NFR-02. Performance — cluster worst case.** A cluster of N hosts SHALL complete in approximately N × (per-host time) plus a fixed overhead of ~5 minutes (lock acquisition, pre-flight, cleanup). For an 8-host cluster with default timeouts, this is approximately 8 × 45 + 5 = 365 minutes (~6 hours) worst case.

**NFR-03. Performance — vCenter run worst case.** With default `maxParallelClusters = 3`, a vCenter with M clusters of average 8 hosts each SHALL complete in approximately ⌈M / 3⌉ × 6 hours worst case.

**NFR-04. Concurrency.** The workflow SHALL support multiple simultaneous runs against different vCenters (locks are scoped to vCenter+cluster, so cross-vCenter contention is impossible). Multiple simultaneous runs against the same vCenter SHALL be supported as long as they select non-overlapping clusters; overlapping selections result in the second run skipping the locked clusters.

**NFR-05. Logging integration.** All workflow logs SHALL be automatically forwarded to VCF Operations for Logs via the standard VCF 9.x integration. Logs SHALL be filterable by workflow run ID via the log marker.

**NFR-06. Scheduling.** This workflow is **on-demand only**. No schedule SHALL be configured. Operators trigger runs manually through the VCF Automation catalog.

**NFR-07. Service account privileges.** The vRO service account used to authenticate to vCenter SHALL have, at minimum:
- Read access to vCenter inventory (clusters, hosts, datastores, content libraries, recent tasks).
- Permission to enter and exit host maintenance mode.
- Permission to start and stop ESXi host services (`TSM-SSH`).
- Permission to initiate host reboot.
- Permission to read and copy files via the `FileManager` API (for `CLUSTER_DATASTORE_STAGE` mode).
- Permission to delete files via the `FileManager` API (for staging cleanup).

**NFR-08. ESXi root privileges.** The ESXi root credentials SHALL have full root authority on each host (required to run `esxcli software profile update`). This is a constraint of the procedure, not an architectural choice.

**NFR-09. Auditability.** Every state-changing action taken by the workflow on a host SHALL be logged at audit level with timestamp, actor (workflow run ID), target host FQDN, action, and outcome. The log + email + VCF Automation deployment record together SHALL constitute a complete audit trail.

**NFR-10. Idempotency.** Re-running the workflow against the same scope after a partial failure SHALL be safe: hosts already on the target build SHALL be detected via build comparison and classified `SKIPPED` with reason "already at target build."

**NFR-11. Maintainability.** All Actions SHALL follow the modular pattern in the system prompt (single-purpose, importable, well-documented). The reusable Actions added to `com.broadcom.pso.common.*` SHALL be usable by other projects without modification.

**NFR-12. Security — credentials at rest.** ESXi root credentials SHALL be stored in encrypted Configuration Element entries (per AD-05). Credentials SHALL never appear in workflow logs, even at debug level.

**NFR-13. Security — SSH state.** SSH on each host SHALL be enabled only for the duration of the per-host procedure and SHALL be disabled immediately after, regardless of patching outcome.

---

## 2.4 Inputs and Outputs

### 2.4.1 `Patch ESXi vCenter` Inputs (operator-facing)

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `acknowledgement` | boolean | false | yes (must be true) | Operator acknowledgement of manual procedure (FR-07). |
| `vcenter` | VC:SdkConnection | — | yes | Single vCenter selection (FR-08). |
| `targetClusters` | Array/VC:ClusterComputeResource | — | yes (≥1) | Multi-select cluster scope, filtered to selectable VxRail clusters (FR-08, FR-09). |
| `depotItem` | Properties (CL item ref) | — | yes | Content Library item for the ESXi depot ZIP (FR-10). |
| `patchStagingMode` | String | `CONTENT_LIBRARY_DIRECT` | yes | One of `CONTENT_LIBRARY_DIRECT`, `CLUSTER_DATASTORE_STAGE` (FR-11). |
| `maxParallelClusters` | number | 3 | yes | Bounded parallelism cap (FR-12). |
| `hostRebootTimeoutMinutes` | number | 25 | yes | Reboot wait timeout (FR-12). |
| `bypassHardwareCheck` | boolean | false | yes | Append `--no-hardware-warning` to esxcli (FR-12). |
| `notificationEmailRecipients` | string | — | yes | Comma-separated email recipients (FR-13). |
| `debugLogging` | boolean | false | no (advanced) | Enable verbose debug logging (FR-14, FR-32). |
| `ignorePreflightWarnings` | boolean | false | no (advanced) | Silence non-blocking pre-flight warnings (FR-18). |
| `dryRun` | boolean | true | no (advanced) | Plan-only run (FR-21). |

### 2.4.2 `Patch ESXi vCenter` Outputs

| Name | Type | Description |
|---|---|---|
| `runStatus` | String | Overall outcome (FR-39). |
| `runSummary` | String | Plain-text summary (FR-39). |
| `runReportHtml` | String | Full HTML report (FR-39). |
| `clustersAttempted` | number | Count. |
| `clustersSucceeded` | number | Count. |
| `clustersFailed` | number | Count. |
| `clustersSkipped` | number | Count. |
| `clusterResults` | Array/Properties | Per-cluster detail (FR-39). |
| `emailsSent` | Array/Properties | All emails dispatched (FR-37, FR-39). |
| `failedClusters` | Array/string | Cluster names ending in FAILED or PARTIAL (FR-39). |

### 2.4.3 `Patch ESXi Cluster` Inputs (internal)

| Name | Type | Required | Description |
|---|---|---|---|
| `vcenter` | VC:SdkConnection | yes | Inherited from parent. |
| `cluster` | VC:ClusterComputeResource | yes | Single cluster to process. |
| `depotItem` | Properties | yes | CL item reference. |
| `patchStagingMode` | String | yes | Inherited. |
| `hostRebootTimeoutMinutes` | number | yes | Inherited. |
| `bypassHardwareCheck` | boolean | yes | Inherited. |
| `dryRun` | boolean | yes | Inherited. |
| `debugLogging` | boolean | yes | Inherited. |
| `ignorePreflightWarnings` | boolean | yes | Inherited. |
| `parentRunId` | string | yes | For correlated logging. |
| `notificationContext` | Properties | yes | Email recipients and SMTP settings for intervention emails. |

### 2.4.4 `Patch ESXi Cluster` Outputs (internal)

Per AD-07 result contract: `{ vcenterFqdn, clusterName, clusterMoRef, outcome, hostsAttempted, hostsSucceeded, hostsFailed, hostsSkipped, haltedReason, hostResults[] }`.

### 2.4.5 `Patch ESXi Host` Inputs (internal)

| Name | Type | Required | Description |
|---|---|---|---|
| `vcenter` | VC:SdkConnection | yes | Inherited. |
| `host` | VC:HostSystem | yes | Single host to patch. |
| `depotPath` | string | yes | On-disk path to depot ZIP (already resolved/staged by parent). |
| `bypassHardwareCheck` | boolean | yes | Inherited. |
| `hostRebootTimeoutMinutes` | number | yes | Inherited. |
| `dryRun` | boolean | yes | Inherited. |
| `debugLogging` | boolean | yes | Inherited. |
| `parentRunId` | string | yes | For correlated logging. |
| `notificationContext` | Properties | yes | Inherited. |
| `sshCredentials` | Properties (encrypted) | yes | Resolved SSH username/password for this host's cluster. |

### 2.4.6 `Patch ESXi Host` Outputs (internal)

Per AD-07 result contract: `{ hostFqdn, hostMoRef, outcome, failurePhase, failureReason, preBuild, postBuild, durationSeconds, interventionEmailSentAt }`.

---

## 2.5 Exclusions (Out of Scope)

**EX-01.** The workflow does not operate on PowerFlex clusters (per AD-06). PowerFlex hosts are refused at the cluster-type pre-flight gate.

**EX-02.** The workflow does not operate on generic vSAN clusters that are not VxRail-managed. While the procedure would work technically, this workflow is scoped specifically to VxRail per Dell KB 000345284.

**EX-03.** The workflow does not perform cross-major-version ESXi upgrades (e.g., ESXi 8 → 9). It is for within-major-version patches only (pending C-14 confirmation).

**EX-04.** The workflow does not implement automated rollback (per AD-03). Failed hosts are left in a known state and a manual recovery runbook is provided in the User Guide.

**EX-05.** The workflow does not patch ESXi clusters smaller than 4 nodes (per AD-04). 2-node and 3-node clusters are blocked at pre-flight.

**EX-06.** The workflow does not interact with VxRail Manager beyond passively detecting in-progress VxRail Manager tasks during pre-flight. It does not register, deregister, or reconcile the patched ESXi build with VxRail Manager. The VxRail Manager noncompliance alarm that results from manual patching is documented for operator awareness but not addressed by this automation.

**EX-07.** The workflow does not interact with PowerFlex Manager (PFMP) in any way.

**EX-08.** The workflow does not orchestrate firmware updates, BIOS updates, iDRAC updates, or any non-ESXi component updates.

**EX-09.** The workflow does not trigger or interact with vSAN on-disk format upgrades, vSAN HCL compliance checks, or vSAN configuration changes.

**EX-10.** The workflow does not run on a schedule. It is on-demand only (per NFR-06).

**EX-11.** The workflow does not retrieve credentials from CyberArk (per AD-05). CCP integration is documented as Future Work.

**EX-12.** The workflow does not implement parallel host patching within a cluster. Hosts are processed strictly one at a time within a cluster, per the vSAN FTT=1 constraint identified in Dell KB 000345284 (per FR-04).

**EX-13.** The workflow does not implement any "Awaiting User Interaction" elements. Once the form is submitted, the run executes to completion or failure without operator interaction (per the operational requirement captured in discovery batch 5d).

**EX-14.** The workflow does not provision, modify, or remove any vCenter inventory connections, Configuration Elements, SMTP host entries, or other vRO infrastructure. Those are operator-managed pre-deployment configuration.

**EX-15.** The workflow does not implement a Layer 0 estate-wide wrapper. Multi-vCenter patching is done by submitting the per-vCenter workflow N times (per AD-02).

---

## 2.6 Assumptions

**ASM-01.** All vCenters in scope are registered in the vRO inventory as `VC:SdkConnection` objects with healthy SDK connections (per discovery batch 3b).

**ASM-02.** The Content Library hosting ESXi depot ZIPs exists in each vCenter where patching will occur, and uses a name consistent with the value in the `esxiPatchContentLibraryName` Configuration Element (default `ESXi-Patches`, pending C-09).

**ASM-03.** Each VxRail cluster has at least 4 hosts (per AD-04). 2-node and 3-node clusters exist in the customer's environment but are out of scope for this workflow.

**ASM-04.** ESXi root SSH credentials are valid for all hosts the workflow will operate on. Credential rotation is the customer's operational responsibility (pending C-05 details).

**ASM-05.** The vRO embedded SMTP host is correctly configured and the workflow can send email to operator-supplied recipients (pending C-04 confirmation).

**ASM-06.** Within-major-version patches only. The depot ZIP version aligns with the currently-installed ESXi major version on target hosts (pending C-14 confirmation).

**ASM-07.** Operators submitting the workflow have authority within their organization to perform manual ESXi patching outside the standard vLCM/VxRail Manager flow. The acknowledgement checkbox in the form (FR-07) records this authority for audit purposes.

**ASM-08.** Customer has accepted the operational model that VxRail Manager noncompliance alarms will fire for patched clusters and will be reconciled through documented post-procedure manual steps.

**ASM-09.** VCF Operations for Logs is integrated with vRO and ingests vRO logs automatically (per discovery batch 4a).

**ASM-10.** The customer's network permits vRO to reach all in-scope vCenters on port 443 and all in-scope ESXi hosts on port 22 (during the brief windows the workflow has SSH enabled).

**ASM-11.** The operator running the workflow has appropriate role-based access in VCF Automation to launch the catalog item and view the resulting deployment.

---

## 2.7 Constraints

**CON-01.** The solution SHALL run entirely on the embedded VCF Orchestrator instance — no external compute, no external file shares, no additional appliances.

**CON-02.** The solution SHALL use only vRO 9.x supported scripting runtimes. The primary runtime is JavaScript (Rhino-based, not Node.js — no ES6+, no `let`/`const`, no arrow functions, no template literals). PowerCLI is not required and is not used (per discovery batch 5e).

**CON-03.** The solution SHALL use the vCenter Server plugin's native inventory objects and built-in actions (`com.vmware.library.vc.*`) wherever possible. REST is fallback only.

**CON-04.** The solution SHALL conform to the architect's existing patterns for: log markers, structured log prefixes, transient REST hosts (where REST is unavoidable), `Properties` for key-value data, `System.getModule()` for Action calls.

**CON-05.** The solution SHALL be deliverable as importable vRO content — Actions, workflows, configuration elements — with no manual code modification required at import time. All environment-specific values are externalized to Configuration Elements.

**CON-06.** The solution SHALL be developed against the version of VCF 9.x currently in production at the customer site (currently VCF 9.0.x; specific patch level TBD at deployment).

**CON-07.** ESXi root SSH must be enabled and disabled at runtime by the workflow (NFR-13). The workflow cannot rely on SSH being permanently enabled, as that violates standard hardening guidance.

**CON-08.** The Dell KB 000345284 procedure is the authoritative reference for the per-host patching steps. The workflow SHALL NOT deviate from the KB's prescribed sequence (FR-19) without explicit customer approval.

---

## 2.8 Risks and Mitigations

| ID | Risk | Likelihood | Impact | Mitigation | Residual Risk |
|---|---|---|---|---|---|
| **R-01** | Patch ZIP is incompatible with target host's hardware/firmware combination, esxcli fails to install. | MEDIUM | MEDIUM | Pre-flight cannot detect this; failure is caught at `PATCH_INSTALL` phase, host is marked FAILED, cluster halts, intervention email sent. Operator can retry with `bypassHardwareCheck` if appropriate. | LOW |
| **R-02** | Host fails to reboot (hardware fault, kernel panic during boot). | LOW | HIGH | Reboot timeout (`hostRebootTimeoutMinutes`) catches this. Host marked FAILED at `RECONNECT` phase. Manual recovery runbook in User Guide guides operator through console-level intervention (iDRAC, alt-bootbank). | MEDIUM (residual because manual recovery is needed) |
| **R-03** | Host reconnects but reports old build (silent install failure). | LOW | MEDIUM | `VERIFY_BUILD` step catches this; host marked FAILED, cluster halts. | LOW |
| **R-04** | SSH enable fails (host service in unexpected state). | LOW | LOW | Caught at `SSH_ENABLE` phase, host marked FAILED before MM entry. No state damage. | VERY LOW |
| **R-05** | Cluster lock orphaned by hard workflow crash. | LOW | LOW | Default error handler releases locks. Auxiliary cleanup workflow `Release ESXi Patch Locks` is provided for residual cases. | VERY LOW |
| **R-06** | Two workflow runs select overlapping clusters. | MEDIUM | LOW | Cluster-scope locks; second run skips locked clusters with clear logging. | VERY LOW |
| **R-07** | Operator selects a depot ZIP that is for a different ESXi major version than the hosts. | MEDIUM | HIGH | C-14 confirms within-major-version-only scope. Workflow can perform a defense-in-depth check at form time comparing depot file naming to host build version. Cross-major-version is out of scope; if attempted, behavior is undefined. | MEDIUM (relies on operator discipline + confirmation per C-14) |
| **R-08** | VxRail Manager runs an automated reconciliation during a patch window and conflicts with workflow operations. | LOW | MEDIUM | Pre-flight checks for in-progress VxRail Manager tasks. Warning (silenceable). Cluster lock prevents two of OUR workflows colliding but cannot prevent VxRail Manager. | MEDIUM |
| **R-09** | SSH credentials in Configuration Element become stale after rotation. | MEDIUM | MEDIUM | Rotation is customer's operational responsibility. Workflow surfaces auth failures clearly at `SSH_ENABLE` or first SSH command. Future Work (C-08) would replace with CCP retrieval. | MEDIUM |
| **R-10** | Patch ZIP corrupt or truncated in Content Library. | LOW | MEDIUM | `PATCH_LIST` step (esxcli enumerate profiles) acts as a smoke test for depot integrity. Failure here halts before any host is touched in non-dry-run mode. | LOW |
| **R-11** | Customer's security team rejects automated SSH enable/disable as policy violation post-deployment. | MEDIUM | HIGH | C-03 surfaces this question pre-deployment. If rejected, workflow remains usable but requires manual SSH enable/disable as pre/post-procedure operator steps (form gates this with additional acknowledgement). | LOW once C-03 is confirmed |
| **R-12** | Cluster halts mid-patch leave a host in MM, requiring manual exit. | MEDIUM | MEDIUM | This is by design (failure containment per AD-03). Manual recovery runbook covers this in detail. Intervention email sent immediately. | MEDIUM (residual is operational, not technical) |
| **R-13** | VCF Automation deployment lifecycle policy not configured, resulting in unbounded growth of job records. | MEDIUM | LOW | Implementation Guide includes a 365-day lease policy as a recommended configuration. Operator-managed. | LOW |
| **R-14** | Intervention email fails to send (SMTP outage). | LOW | MEDIUM | Workflow logs the failure but does not retry indefinitely. Run summary records "email send failed" so operators reviewing the deployment record see the gap. | LOW |
| **R-15** | Manual operator using the cluster picker selects a cluster that passes form-time check but fails workflow-start check. | MEDIUM | LOW | Two-tier check pattern (C-12) handles this. Cluster classified SKIPPED with clear reason; operator is informed via run summary and email. | VERY LOW |

---

## 2.9 Reusable Assets

The customer's existing Action library has minimal reusable components for this project (per discovery batch 3a). The following Actions are **NEW** and SHALL be added to the reusable library for use by future projects:

| Module Path | Action Name | Purpose | Type |
|---|---|---|---|
| `com.broadcom.pso.common.logging` | `initWorkflowLogging` | Sets log marker and emits WorkflowStart audit log line. Standard preamble for every workflow. | New, reusable |
| `com.broadcom.pso.common.logging` | `debugLog` | Gated debug logging — no-op when `debugEnabled = false`. | New, reusable |
| `com.broadcom.pso.common.workflow` | `runWithParallelism` | Asynchronous fan-out of N items to a worker workflow with a parallelism cap and asymmetric scheduling. Generic across projects. | New, reusable |

The following Actions are **NEW** and ESXi-patching-specific (live under `com.broadcom.pso.vc.esxi.patching` or similar — final namespace TBD in Phase 3):

| Action | Purpose |
|---|---|
| `getRegisteredVcenters` | Form-time external value: list vCenter inventory connections. |
| `getClustersForVcenter` | Form-time external value: list clusters in a selected vCenter with type+health labels. |
| `getDepotItemsForVcenter` | Form-time external value: list eligible Content Library depot items in a selected vCenter. |
| `identifyClusterType` | Pre-flight: classify a cluster as VXRAIL / POWERFLEX / VSAN-ONLY / OTHER. |
| `evaluateClusterPreflight` | Pre-flight: run all blocking + warning gates against a cluster. |
| `resolveContentLibraryItemPath` | Resolve a CL item to its on-disk path on the backing datastore. |
| `findClusterStagingDatastore` | Identify a cluster-shared datastore suitable for `CLUSTER_DATASTORE_STAGE` mode. |
| `stageDepotToDatastore` | Copy depot ZIP from CL backing to cluster-shared datastore via FileManager API. |
| `cleanupStagedDepot` | Delete staged depot copy from cluster-shared datastore. |
| `getEsxiSshCredentials` | Read encrypted ESXi credentials from Configuration Element keyed on vCenter+cluster. |
| `setHostSshServiceState` | Start or stop `TSM-SSH` service on a host via vCenter `HostServiceSystem` API. |
| `enterMaintenanceModeEnsureAccessibility` | Enter MM with the specific vSAN data movement option per KB 000345284. |
| `runEsxcliProfileList` | SSH execute `esxcli software sources profile list` and parse output. |
| `runEsxcliProfileUpdate` | SSH execute `esxcli software profile update` and parse output. |
| `rebootHostAndWaitReconnect` | Reboot host and poll for reconnection within timeout. |
| `verifyHostBuildChanged` | Compare pre/post `host.config.product.build` values. |
| `exitMaintenanceMode` | Exit MM. |
| `acquireClusterPatchLock` / `releaseClusterPatchLock` | Cluster-scope lock management. |
| `buildHostResultProperties` / `buildClusterResultProperties` / `buildVcenterResultProperties` | Construct structured result objects per AD-07 contracts. |
| `composeHtmlRunReport` | Generate the HTML report body. |
| `sendNotificationEmail` | Send email via the Mail plugin with the operator-supplied recipients. |

The full action inventory and scripting runtime selection is finalized in Phase 3.

---

## 2.10 Acceptance Criteria

**AC-01.** A dry-run execution against a healthy 4-node VxRail cluster completes with `runStatus = DRY_RUN_COMPLETE`, logs every host the workflow would have patched, and confirms no host entered maintenance mode and no `esxcli software profile update` was executed.

**AC-02.** A live execution against a single test VxRail host (in a 4+ node test cluster) successfully:
- Enters maintenance mode with EnsureObjectAccessibility.
- Enables SSH.
- Lists profiles in the depot via esxcli.
- Installs the patch via esxcli (returns success exit code).
- Reboots the host.
- Reconnects within the timeout.
- Verifies the build changed.
- Disables SSH.
- Exits maintenance mode.
- Returns `outcome = SUCCESS` for the host, `outcome = SUCCESS` for the cluster, `runStatus = SUCCESS` overall.

**AC-03.** A live execution where the patch install fails on a single host correctly halts the cluster, leaves the failed host in MM with SSH disabled, sends an intervention email, processes other parallel clusters unaffected, and reports `runStatus = COMPLETED_WITH_ERRORS`.

**AC-04.** Two simultaneous workflow runs against the same vCenter selecting overlapping clusters: the second run reports the overlapping clusters as `SKIPPED` with reason "Cluster locked by run X", processes its non-overlapping selections normally, and ends with appropriate status.

**AC-05.** A pre-flight check correctly refuses a 3-node VxRail cluster, a PowerFlex cluster, a generic vSAN cluster, and a VMFS-only cluster, with clear reasons in the form picker labels and (if somehow submitted anyway) at workflow start.

**AC-06.** The final HTML email contains: summary table at top, per-cluster breakdown, per-host detail with phase status, build pre/post, run ID, vCenter, depot used, run start/end timestamps, and notes about VxRail Manager noncompliance.

**AC-07.** The VCF Automation deployment record persists after workflow completion (Pattern B), with all outputs populated and `runReportHtml` viewable directly on the deployment detail page.

**AC-08.** Cluster-scope locks are correctly released after normal completion, after handled failure, and after simulated uncaught exception (verified via inspecting `LockingSystem` state post-run).

**AC-09.** All workflow logs appear in VCF Operations for Logs and are filterable by the workflow run ID embedded in the log marker.

**AC-10.** Re-running the workflow against an already-patched cluster correctly identifies hosts already at the target build, classifies them as `SKIPPED` with reason "already at target build", and does not re-enter MM or re-run esxcli (NFR-10 idempotency).

**AC-11.** Debug logging toggled via `debugLogging = true` produces verbose per-step traces; toggled false, only audit-level logs appear.

**AC-12.** The reusable Actions added to `com.broadcom.pso.common.*` can be invoked from a separate test workflow (independent of the ESXi patching workflows) and behave correctly in isolation, validating their reusability.

**AC-13.** The Acknowledgement section's required checkbox cannot be bypassed: form submission is blocked until checked.

**AC-14.** `dryRun` defaults to true on every form load; live execution requires explicit operator opt-out.

---

## Document control

**Pending customer responses required to remove DRAFT status and finalize this document:**

- C-01 (Content Library backing strategy)
- C-02 (Content Library distribution model — informational, no code impact)
- C-03 (SSH security policy)
- C-04 (SMTP plugin pre-configuration)
- C-05 (ESXi root password storage scheme)
- C-06 (Pre-flight Validation sibling workflow yes/no)
- C-07 (Notification cc list)
- C-09 (Content Library name default)
- C-10 (Reboot time default)
- C-14 (Within-major-version-only confirmation)

When all of these are closed, this document moves from DRAFT to APPROVED, and Phase 3 (Design) can begin.

