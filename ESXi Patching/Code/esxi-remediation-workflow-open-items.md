# vSphere Environment Remediation Workflow — Open Items & Customer Questions

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail)
> **Status:** Phase 3 (Design) substantially complete. Ready for Phase 4 (Code Generation).
> **Last updated:** 2026-05-05
>
> **How to use this file:**
> - Architectural Decisions (AD-XX) below are LOCKED — they capture decisions made during discovery and design.
> - Customer-side items (C-XX) capture confirmation questions sent to the customer.
> - Each customer item has a `Status`, a `Default assumption`, and a `Customer response` block.
> - Status values: `OPEN` (waiting on response), `ANSWERED` / `CLOSED` (response captured), `DEFERRED` (out of scope for v1), `BLOCKED` (cannot proceed without).

---

# Architectural Decisions (LOCKED)

## AD-01 — VxRail-only scope using KB 000345284 esxcli procedure

The workflow is designed for **VxRail clusters only** and follows the **Dell KB 000345284 esxcli procedure** for manual within-major-version ESXi patching. Per-host operations follow the KB:

1. Provision an ephemeral local user account on the host via vCenter (per AD-08).
2. Place host in Maintenance Mode with "Ensure Accessibility" option (vSAN safety).
3. Enable SSH on the host (workflow toggles SSH state on demand; see C-03).
4. SSH to the host using the ephemeral account, run `esxcli software sources profile list --depot=<path>` to enumerate profiles.
5. Run `esxcli software profile update -p <profile-standard> --depot=<path>` (with optional `--no-hardware-warning`).
6. Reboot the host.
7. Verify host reconnects to vCenter and reports the new build.
8. Verify HA agent rejoins cluster fabric.
9. Disable SSH on the host.
10. Exit Maintenance Mode via vCenter.
11. Delete the ephemeral account and its permission grant.
12. Move to next host (one at a time per cluster, per vSAN FTT=1 constraint).

The procedure is the documented fallback path used when standard VxRail/vLCM upgrade tooling is unavailable or unreliable. PowerFlex clusters are out of scope per AD-06.

## AD-02 — Per-vCenter workflow scope

The workflow is invoked **once per vCenter**. The operator selects exactly one vCenter and one or more clusters within that vCenter. Patching multiple vCenters in a single estate-wide patch event is done by submitting the workflow N times (once per vCenter).

**Future work captured:** A parent workflow in VCF Automation that loops over a list of vCenters can be added later if estate-wide single-click patching becomes a requirement.

## AD-03 — No automated rollback

ESXi's alt-bootbank rollback (Shift+R at bootloader) requires interactive console access and cannot be automated without an iDRAC/IPMI scripting layer that is out of scope. Instead, the workflow implements **failure containment** combined with the three-state cluster-continuation policy in AD-09.

## AD-04 — Hybrid cluster size policy

For VxRail clusters (vSAN-backed):

- **3-node clusters: BLOCKED.** Cannot be patched by this workflow. Reasoning: 3-node clusters at FTT=1 cannot be safely halted mid-patching — once one host has been patched, the cluster is at minimum capacity and any failure of the second host's procedure leaves the cluster in an unrecoverable degraded state. These clusters require manual KB 000345284 procedure execution under operator supervision.
- **4-node clusters: ALLOWED with explicit acknowledgement.** The form requires operator acknowledgement when any 4-node cluster is selected: *"I acknowledge that 4-node clusters will be patched at the vSAN FTT=1 floor with no headroom for concurrent failures during the patch window."*
- **5+ node clusters: ALLOWED with 1-host headroom.** Standard operation. The dynamic residual-capacity check (per host iteration) requires that putting the next host into MM leaves at least vSAN-FTT-minimum + 1 hosts healthy.

This policy applies as both a static pre-flight gate (3-node clusters refused at workflow start) and a dynamic per-host check (residual capacity evaluated immediately before each MM entry).

## AD-05 — Ephemeral credential pattern (replaces persistent credential storage)

ESXi credentials are not stored anywhere. Per AD-08, each host is provisioned with a per-run ephemeral local user account that is destroyed at the end of the host's procedure. CyberArk CCP integration was evaluated and deferred (the customer has CyberArk but it requires MFA which is incompatible with unattended retrieval). With the ephemeral-account pattern, persistent credential storage is unnecessary; CCP integration becomes moot.

## AD-06 — PowerFlex clusters explicitly out of scope

The workflow operates **only on VxRail clusters**. PowerFlex clusters are excluded from this workflow's scope:

1. PowerFlex Manager (PFMP) provides the Single Component Upgrade (SCU) feature for ESXi patching on PowerFlex clusters, with documented Dell support paths.
2. SCU's documented failure-handling guidance is "contact Dell Support for assistance" — building automation that bypasses this path creates support boundary ambiguity.
3. PowerFlex storage stack has its own state machine (SDC, MDM/SDS) that manual patching can desynchronize with PFMP.
4. The customer's stated automation need is specifically VxRail patching.

The workflow's pre-flight gates positively identify each selected cluster as a VxRail cluster. Non-VxRail clusters (PowerFlex, generic vSAN, vSphere with VMFS/NFS) are refused. The form's cluster picker visually labels clusters by type so operators see why non-VxRail clusters are unselectable.

## AD-07 — Layered workflow architecture

The automation is built as **three layered workflows** with clear single responsibilities:

```
Layer 1 (top, catalog item):  Remediate vSphere Environment
                              ├─ runs Remediate vSphere Cluster N times in parallel
                              │  (bounded by maxParallelClusters)
                              │
Layer 2 (middle, internal):   Remediate vSphere Cluster
                              ├─ runs Remediate ESX Host once per host, sequentially
                              │
Layer 3 (bottom, internal):   Remediate ESX Host
                              └─ KB 000345284 procedure on a single host
```

**Responsibilities by layer:**

- **Remediate vSphere Environment** — the only catalog item exposed to operators. Owns the request form, vCenter-level pre-flight, parallelism cap, top-level run summary, email notifications, deployment outputs.
- **Remediate vSphere Cluster** — internal. Owns the cluster-scope lock, per-cluster pre-flight gates, sequential host iteration with residual-capacity check, three-state cluster-continuation policy (per AD-09), cluster-level result aggregation.
- **Remediate ESX Host** — internal. Owns the per-host KB 000345284 procedure including ephemeral account lifecycle.

**Error propagation:** Child workflows catch known failures and return structured FAILED results. They only rethrow truly unexpected exceptions. Parent workflows process structured results as normal flow control.

**Reusable Action `com.broadcom.pso.common.workflow.runWithParallelism`** is added to the reusable library to handle bounded fan-out parallelism with asymmetric scheduling. Generic across projects.

**Result object contracts:**

| Layer returns | Structure |
|---|---|
| **Remediate ESX Host** | `{ hostFqdn, hostMoRef, outcome, failurePhase, failureReason, preBuild, postBuild, durationSeconds, interventionEmailSentAt, hostUsablePostFailure, cleanupOutcome }` |
| **Remediate vSphere Cluster** | `{ vcenterFqdn, clusterName, clusterMoRef, outcome, hostsAttempted, hostsSucceeded, hostsFailed, hostsSkipped, haltedReason, hostResults[] }` |
| **Remediate vSphere Environment** | `{ vcenterFqdn, runStatus, runSummary, runReportHtml, vmsaReference, clustersAttempted, clustersSucceeded, clustersFailed, clustersSkipped, emailsSent[], clusterResults[] }` |

**Outcome enumerations:**
- Per-host: `SUCCESS`, `FAILED`, `SKIPPED`, `DRY_RUN`.
- Per-cluster: `SUCCESS`, `PARTIAL`, `FAILED`, `SKIPPED`, `HALTED`, `DRY_RUN`.
- Per-run: `SUCCESS`, `COMPLETED_WITH_WARNINGS`, `COMPLETED_WITH_ERRORS`, `DRY_RUN_COMPLETE`, `ABORTED`.

**Failure phase enumeration (per-host, 14 phases):** `MM_PRECHECK`, `AUTH_PROVISION`, `AUTH_VERIFY`, `SSH_ENABLE`, `MM_ENTER`, `PATCH_LIST`, `PATCH_INSTALL`, `REBOOT`, `RECONNECT`, `VERIFY_BUILD`, `HA_REJOIN`, `SSH_DISABLE`, `MM_EXIT`, `AUTH_CLEANUP`.

## AD-08 — Ephemeral per-run ESXi account pattern

Each host receives a uniquely-named local ESXi account, created at the start of the per-host procedure and destroyed at the end. The pattern:

1. Workflow generates a strong random password for the run (32+ characters, full keyspace).
2. Calls `host.configManager.accountManager.createUser` with a `VcHostPosixAccountSpec` setting `shellAccess = true` (required for SSH access on ESXi 8.0+).
3. Calls `host.configManager.authorizationManager.setEntityPermissions` to grant the Admin role to the new account.
4. Workflow uses the account for SSH-based esxcli operations.
5. At end of host procedure: removes permission grant first, then deletes the account.

**Account naming:** `vro-patch-<short-runid>` where `<short-runid>` is the first 8 characters of the workflow run ID. Capped at 32 characters to stay within ESXi naming limits.

**Cleanup ordering** (per-host, end of procedure or DEH):
1. Exit MM (returns host to service first).
2. Disable SSH (restores hardening).
3. Remove permission grant (while principal still exists, to avoid orphan permissions; `removeEntityPermission` throws on missing principal — our wrapper handles this and additionally enumerates orphan permissions by name pattern as a fallback).
4. Delete account.

**Idempotent cleanup wrappers:** All cleanup Actions treat "already absent" results as success, allowing safe re-execution from any context (workflow DEH, parent workflow reconciliation, scheduled WF-07 reconciliation).

## AD-09 — Three-state cluster continuation policy

When a host fails during remediation, the cluster's continuation behavior depends on cleanup outcome and host usability:

| Scenario | Cleanup outcome | Host usable post-failure? | Action |
|---|---|---|---|
| **A** | All cleanup succeeded | Yes (host in pre-workflow state) | Update CE-05 → continue cluster |
| **B** | Some cleanup failed | Yes (still connected and functional, may have residual artifacts) | Update CE-05 → email immediately → continue cluster (WF-07 finishes residual cleanup tomorrow) |
| **C** | Cleanup failed | No (offline, disconnected, or unrecoverably stuck) | Update CE-05 → email immediately → halt cluster |

A second halt condition applies independently: the dynamic residual-capacity check (per AD-04) halts the cluster if patching the next host would violate FTT/headroom rules. A host that fails at the `HA_REJOIN` phase is marked `FAILED` and **does not count toward residual-capacity calculations** for subsequent hosts (a host with broken HA is not contributing to cluster redundancy even if it appears connected).

## AD-10 — Run state tracking via CE-05

A persistent Configuration Element tracks workflow run state for crash recovery and reconciliation:

**CE-05 — Workflow Run Tracker:**

- Single Configuration Element with a single composite-array attribute `runs`.
- Each entry shape:
  ```
  {
    "wfRunId": string,
    "esxHost": [
      {
        "hostId": string,                       // vRO inventory ID
        "remediationPhaseCurrent": string,      // phase name from AD-07
        "remediationPhaseCurrentStatus": "in-progress" | "succeeded" | "failed" | "cancelled"
      }
    ]
  }
  ```
- WF-03 writes to CE-05 directly at major phase boundaries.
- All reads/writes serialized via global `LockingSystem` lock named `CE_05_RUN_TRACKER_LOCK` (held briefly during read-modify-write).
- WF-01 registers itself in CE-05 just before first host's `AUTH_PROVISION` step; removes itself on clean exit.

The CE is read by WF-07 (the reconciliation workflow) for crash recovery. Live workflows do not read CE-05; they use in-memory state (workflow attributes) for their own cleanup decisions.

## AD-11 — Cleanup architecture cascade

Each layer's Default Error Handler cleans up only its own layer's resources, using in-memory state. Parent layers reconcile children's leftovers when children return or crash. WF-07 only acts on confirmed-dead workflow runs.

**Five operating rules:**

1. A workflow only cleans up resources it created (in-memory tracking via workflow attributes).
2. When a child workflow returns, the parent inspects and reconciles (result-based reconciliation).
3. When a workflow dies, the next-living layer up takes over (cascading recovery).
4. Cleanup is always idempotent (multiple attempts safe, "already done" treated as success).
5. Persistent state (CE-05) drives reconciliation only when in-memory state is unavailable.

**WF-07 (reconciliation workflow) detection logic:**

- Runs on a daily schedule (configured in vRO scheduler, not in CE).
- Defensive startup check: if another WF-07 instance is running, log and exit cleanly.
- For each CE-05 entry, query vRO via `Server.getWorkflowTokenById(wfRunId)` to determine actual workflow state.
  - State `running` or `waiting`: skip (alive, will handle its own cleanup).
  - State `failed`, `cancelled`, or token not found: reconcile.
- Reconciliation actions performed automatically (all are non-disruptive or restoring per customer policy — SSH state changes and MM exit do not require CRs):
  1. Exit MM on hosts stuck in MM.
  2. Disable SSH on hosts where it was left enabled.
  3. Remove permission grants (handle orphan permissions defensively by enumeration).
  4. Delete ephemeral accounts.
  5. Force-release stuck cluster-scope locks.
  6. Cleanup staged depot files on datastores.
  7. Update / remove CE-05 entries.

**WF-07 NEVER enters maintenance mode.** Cleanup is by definition undoing previous state, not creating new state.

WF-07 alert-emails and removes CE-05 entries older than 30 days (configurable via `maxRetryAgeDays`) that have persistently failed cleanup.

WF-07 is **not invoked from any workflow's DEH**. It runs only on the scheduled trigger. DEH cleanup at each layer is the primary cleanup path; WF-07 is the catch-all for cancellation and JVM-crash scenarios.

## AD-12 — Form-based validation summary with prominent acknowledgement

The request form's cluster validation runs comprehensive checks (cluster type, HA/DRS health, host states, lockdown mode, vSAN health, DRS migration constraints, depot version compatibility) and presents a consolidated multi-line text summary inline within the Cluster Selection form section. The operator must acknowledge the summary before proceeding. Warnings are formatted prominently:

```
═══════════════════════════════════════════════════════
⚠ CRITICAL WARNINGS — REVIEW CAREFULLY BEFORE PROCEEDING
═══════════════════════════════════════════════════════
[per-cluster findings...]
```

**Per-cluster findings categorized:**
- **CRITICAL** — cluster will be excluded (cannot be overridden).
- **WARNING** — cluster will be processed but with caveats (silenceable via `ignorePreflightWarnings` for non-blocking warnings).
- **READY** — cluster passes all checks.

**vSAN health checks** are filtered by default to a curated subset of operationally-relevant health groups:
- `clusterStatus`, `data`, `network`, `physicalDisk`, `limits`.

An advanced toggle `showAllVsanHealthGroups` allows operators to view all vSAN health groups (e.g., `hcl`, `iSCSI`, `performance`) when needed.

The cluster picker labels are **patch-version-aware** per the architect's C-12 direction: when the operator selects a depot, the cluster picker re-renders with version-mismatch warnings inline (e.g., `(VXRAIL — WARNING: depot is for ESXi 8.0 U3, hosts at 8.0 U2)`).

## AD-13 — VMSA reference field, REQUIRED

The form includes a **required** VMSA reference number text field (e.g., `VMSA-2026-0001`) in the first form section, alongside the main acknowledgement (Ack1). The VMSA value must be format-valid (`^VMSA-\d{4}-\d{4}$`) before Ack1 can be checked. The form blocks submission until both VMSA is valid and Ack1 is checked.

The value is logged in the audit trail, run summary, deployment record, and email report.

**Note on policy:** This was originally specified as optional per the customer's lackadaisical compliance-management posture. The architect's later direction was to make it required, creating a hard compliance gate at form submission. This forces operators to provide a VMSA reference for every run, surfacing any organizational pressure to skip compliance documentation rather than allowing it to silently propagate.

---

# Customer Open Items

## Summary table — current open items

| # | Topic | Owner | Status | Priority |
|---|---|---|---|---|
| C-01 | Content Library backing | Customer infra team | CLOSED | HIGH |
| C-02 | Content Library distribution model | Customer infra team | CLOSED | MEDIUM |
| C-03 | Security policy for runtime SSH enable/disable | Customer security team | CLOSED | HIGH |
| C-04 | SMTP plugin pre-configuration | Customer infra team | CLOSED | MEDIUM |
| C-05 | ESXi root password storage scheme | Customer infra team | CLOSED | — |
| C-06 | Build Validate Prerequisites sibling workflow? | Customer ops team | CLOSED | LOW |
| C-07 | Fixed cc list for notification emails | Customer ops team | CLOSED | MEDIUM |
| C-08 | CyberArk CCP integration | Customer security team | DEFERRED | FUTURE |
| C-09 | Content Library name pattern | Customer infra team | CLOSED | MEDIUM |
| C-10 | ESXi host reboot time on customer hardware | Customer infra team | CLOSED | MEDIUM |
| C-11 | VCF Automation deployment lifecycle | Internal (architect) | CLOSED | MEDIUM |
| C-12 | Form section layout | Internal (architect) | CLOSED | MEDIUM |
| C-13 | Credentials for form-time vCenter health checks | Internal (architect) | CLOSED | MEDIUM |
| C-14 | ESXi within-major-version patching only | Customer infra team | CLOSED | HIGH |
| C-16 | Service account privileges in vCenter | Customer security team | CLOSED | HIGH |

---

## C-01 — Content Library backing strategy

**Why it matters:**
The Dell KB procedure runs `esxcli software profile update --depot=<path>` from the ESXi host. If the Content Library backing datastore is mounted on every host in the cluster, the depot ZIP is accessible at a deterministic path with no copy step required. If the CL is backed by a non-shared datastore, the workflow must copy the ZIP from the CL backing datastore to a cluster-shared datastore, patch all hosts, then delete the staged copy.

**Question for the customer:**
Can the Content Library hosting the ESXi depot ZIPs be backed by an **NFS datastore mounted on every ESXi host in the datacenter**?

**Default assumption (used until answered):**
Design supports **both modes** via a `patchStagingMode` input parameter with values `CONTENT_LIBRARY_DIRECT` and `CLUSTER_DATASTORE_STAGE`.

**Status:** CLOSED
**Owner:** Customer infrastructure team
**Priority:** HIGH

**Customer response:**
- Date received: 5/4/26
- Response: Content Library will be implemented for this effort using NFS datastore

**Action:** Both modes remain in design as defense-in-depth, but `CONTENT_LIBRARY_DIRECT` is the operational default. Customer's NFS-mounted CL satisfies the prerequisite for this mode.

---

## C-02 — Content Library distribution model

**Why it matters:**
Content Libraries can be distributed via Published+Subscriber (replicates automatically across vCenters) or as independent CLs uploaded per vCenter. Workflow is pattern-agnostic but documentation should reflect the customer's actual approach.

**Question for the customer:**
Which CL distribution pattern will be in use?

**Default assumption (used until answered):**
Workflow's depot picker matches by **item name pattern** within the selected vCenter's CL. Works with either pattern.

**Status:** CLOSED
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
- Date received: 5/4/26
- Response: Initially the patch file will need to be uploaded to each vCenter's content library manually. Currently there are firewall issues preventing stable communication between vCenters.

**Action:** None — workflow is pattern-agnostic. The customer's environmental note (firewall restrictions between vCenters) is captured for awareness; it would affect any future estate-wide wrapper that touches multiple vCenters but not the per-vCenter scope of this workflow.

---

## C-03 — Security policy for runtime SSH enable/disable on ESXi hosts

**Why it matters:**
ESXi root SSH is required for `esxcli software profile update`. The workflow enables SSH on each host before patching and disables immediately after. Some security policies require Change Requests for SSH state changes.

**Question for the customer's security team:**
Is automated runtime SSH enable/disable acceptable as a pre-approved standing change pattern, or does it require per-event CR approval?

**Status:** CLOSED
**Owner:** Customer security team
**Priority:** HIGH

**Customer response:**
- Date received: 5/4/26
- Response: No CR required to enable SSH

**Action:** Locked. Workflow performs SSH enable/disable autonomously. WF-07 reconciliation can also disable SSH autonomously per AD-11.

---

## C-04 — SMTP plugin pre-configuration

**Why it matters:**
The workflow uses the out-of-box `com.vmware.library.mail` action. Without a working SMTP host registered in vRO inventory, notifications cannot be sent.

**Question for the customer:**
1. Confirm an SMTP host is registered in the vRO inventory under **Inventory → Mail**.
2. Confirm sender address, TLS config, authentication.
3. Confirm sending account has authority for intended recipients.

**Default assumption (used until answered):**
One SMTP host is registered in inventory and discoverable via `Server.findAllForType("Mail:SMTPClient")`. TLS in use.

**Status:** CLOSED
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
- Date received: 5/4/26
- Response: Single SMTP connection will be configured in Orchestrator. There's a single SMTP relay server for all vCenters in the environment

**Action:** Workflow uses `Server.findAllForType("Mail:SMTPClient")[0]` if `smtpHostName` in CE-03 is empty, simplifying the design. Sub-questions (sender address, TLS, authentication) are deferred to deployment-time configuration and will be flagged in the Implementation Guide.

---

## C-05 — ESXi root password storage scheme

**Why it matters:**
This question asked how to store ESXi root credentials for the workflow's SSH operations.

**Status:** CLOSED
**Owner:** N/A (resolved by AD-08)
**Priority:** N/A

**Customer response:**
- Date received: 5/4/26
- Response: Each ESX host has a unique password for their root account. Ephemeral accounts will be used to perform the patch installs

**Resolution:** Per AD-08, the workflow no longer requires stored ESXi credentials. Ephemeral accounts are provisioned per-run via vCenter's authority and destroyed at end-of-run. The customer's mention of ephemeral accounts validated this architectural direction.

---

## C-06 — Optional "Validate Remediation Prerequisites" sibling workflow

**Why it matters:**
A read-only validation workflow lets operators verify a planned scope is healthy before submitting the actual patch run.

**Question for the customer:**
Build it as part of v1, or rely on form-time validation?

**Default assumption (used until answered):**
**YES, build it.** Cheap to build because it reuses validation Actions from the main workflow.

**Status:** CLOSED
**Owner:** Customer ops team
**Priority:** LOW

**Customer response:**
- Date received: 5/5/26
- Response: Yes, implement this

**Action:** WF-04 (`Validate vSphere Environment Remediation Prerequisites`) included in delivery.

---

## C-07 — Fixed cc list for notification emails

**Why it matters:**
Per AD-09, host failures in scenarios B and C send immediate intervention emails to the vSphere infrastructure team. Whether a fixed distribution list should always be CC'd is a customer preference question.

**Question for the customer:**
Is there a fixed distribution list (e.g., `vsphere-infra@customer.com`) that should always receive notification emails, in addition to operator-supplied recipients?

**Default assumption (used until answered):**
A `notificationFixedCcList` Configuration Element entry is provisioned but defaults to empty.

**Status:** CLOSED
**Owner:** Customer ops team
**Priority:** MEDIUM

**Customer response:**
- Date received: 5/5/26
- Response: No additional email groups required for notification. CC field is not required

**Action:** CE-01's `notificationFixedCcList` attribute remains in the schema as a configurable default, currently empty. If the customer's vSphere infrastructure team operating model changes to require always-CC'd notifications, populate `notificationFixedCcList` in CE-01 with the appropriate distribution list address(es). No code change required — the attribute is read by the email-send Action and prepended to operator-supplied recipients.

---

## C-08 — CyberArk CCP integration [DEFERRED]

**Why it matters:**
Original consideration was CyberArk CCP for credential retrieval.

**Status:** DEFERRED
**Owner:** Customer security team (for v2 if persistent credentials ever return to scope)
**Priority:** FUTURE

**Customer response:**
- Date received: 5/4/26
- Response: This will be a future integration

**Note:** Per AD-08 (ephemeral per-run accounts), v1 has no persistent ESXi credentials at all, making CCP integration unnecessary for v1. CCP would only become relevant if a future requirement reintroduces persistent credentials for some other purpose.

---

## C-09 — Content Library name pattern for ESXi depots

**Why it matters:**
The form's depot picker is filtered to Content Libraries whose name contains a configurable substring pattern (configurable via Configuration Element).

**Question for the customer:**
What name will the Content Library hosting ESXi depot ZIPs use?

**Default assumption (used until answered):**
Substring pattern `ESXi-Patches`. Stored in Configuration Element attribute `esxiPatchContentLibraryNamePattern`.

**Status:** CLOSED
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
- Date received: 5/5/26
- Response: Content Library will contain "ESXi-Patches" in the name

**Action:** CE-01 attribute renamed from `esxiPatchContentLibraryName` (exact match) to `esxiPatchContentLibraryNamePattern` (substring match) to honor the customer's wording. The form-time `getDepotItemsForVcenter` Action uses `name.indexOf(pattern) !== -1` rather than exact match. Default value: `ESXi-Patches`. Matches CLs like `ESXi-Patches`, `ESXi-Patches-DC1`, `Production-ESXi-Patches-2026`, etc.

---

## C-10 — ESXi host reboot time on customer hardware

**Why it matters:**
Sets the `hostRebootTimeoutMinutes` input parameter default. Set too short → false-positive failures. Set too long → workflow hangs on stuck hosts.

**Question for the customer:**
Approximate and worst-case reboot times for ESXi hosts in this environment?

**Default assumption (used until answered):**
**25 minutes.** Operators can override per-run.

**Status:** CLOSED
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
- Date received: 5/5/26
- Response: 20-25 minutes

**Action:** Default `hostRebootTimeoutMinutes` stays at 25 minutes. Form field's help text references the documented range so operators have context. Per-run override supported via the Advanced section.

---

## C-11 — VCF Automation deployment lifecycle [CLOSED]

**Status:** CLOSED
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
- Date received: 5/4/26
- Response: Pattern B (persistent deployment as job record)

**Action:** Implementation Guide includes 365-day lease policy as recommended configuration on the catalog item.

---

## C-12 — Form section layout and patch-aware cluster picker [CLOSED]

**Status:** CLOSED
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
- Date received: 5/4/26
- Response: Switch 2 and 3 around. Patch should be selected first and then you can update the object picker values with warnings if the selected patch is not compatible with the current version in the cluster

**Action:** Form section order updated to: Acknowledgement (Section 1) → vCenter (Section 2) → Patch (Section 3) → Cluster (Section 4, picker shows patch-version-aware labels) → Email (Section 5) → Advanced (Section 6) → Review (Section 7). Cluster picker external-value action accepts both vCenter and selected patch as inputs and renders cluster labels with version-mismatch warnings inline (e.g., `(VXRAIL — WARNING: depot is for 8.0 U3, hosts at 8.0 U2)`).

---

## C-13 — Credentials for form-time vCenter health-check actions [CLOSED]

**Status:** CLOSED
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
- Date received: 5/4/26
- Response: Reuse the inventory connections

**Action:** Form actions and workflow execution share the same identity (vRO inventory connection per vCenter).

---

## C-14 — ESXi within-major-version patching only

**Why it matters:**
Dell KB 000345284 is specifically a within-major-version manual patching procedure. Cross-major-version ESXi upgrades on VxRail have additional considerations (VxRail-aligned image bundles, firmware compatibility, vSAN on-disk format upgrades) not covered by this workflow.

**Question for the customer:**
Confirm that all patches to be applied are within ESXi 8.x and not crossing the 8 → 9 boundary?

**Status:** CLOSED
**Owner:** Customer infrastructure team
**Priority:** HIGH

**Customer response:**
- Date received: 5/5/26
- Response: This solution will only apply to ESXi 8 (and earlier) hosts. ESXi 9 hosts will be part of VCF 9 which will not be managed by VxRail or PowerFlex managers

**Action:** Per the customer's "ESXi 8 (and earlier)" language, the architect's interpretation is that v1 supports **ESXi 8.x only**. The "and earlier" qualifier is treated as inclusive permission rather than a requirement; if pre-8.0 hosts emerge in scope, v2 can extend. Reasoning: AD-08's `VcHostPosixAccountSpec.shellAccess` field requires ESXi 8.0+; supporting pre-8.0 would require a parallel account-creation path with different APIs.

A new pre-flight check (`verifyAllHostsOn8x` Action) refuses any cluster containing pre-8.0 ESXi hosts at workflow start. Hosts on pre-8.0 ESXi are surfaced in the form-time validation summary as `(VXRAIL — BLOCKED: cluster contains pre-8.0 hosts)`.

ESXi 9 hosts are out of scope — covered by standard VCF 9 lifecycle tooling per the customer's own statement.

---

## C-16 — Service account privileges in vCenter [CLOSED]

**Why it matters:**
The vRO service account that authenticates to vCenter (used by all workflow operations including MM enter/exit, account provisioning, host service control) requires specific privileges.

**Status:** CLOSED
**Owner:** Customer security team
**Priority:** HIGH

**Customer response:**
- Date received: 5/4/26 (verbal confirmation by architect)
- Response: vRO service account has Administrator role at vCenter level.

**Action:** Locked. NFR specifies Administrator role.

---

## Notes / scratchpad

```
[2026-05-04] — Initial discovery and Phase 2 requirements drafted. Customer responses captured.
[2026-05-05] — Architectural pivots: PowerFlex out of scope (AD-06), ephemeral accounts (AD-08), three-state continuation (AD-09), CE-05 run tracking (AD-10), cleanup cascade (AD-11), validation summary (AD-12), VMSA required (AD-13).
[2026-05-05] — Customer responses to C-06, C-07, C-09, C-10, C-14 received and incorporated.
[2026-05-05] — Reconcile complete. All three documents regenerated to consolidate state.
```
