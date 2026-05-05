# ESXi Patching Workflow — Open Items & Customer Questions

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail)
> **Status:** Phase 2 (Requirements Document) approved with provisional defaults; Phase 3 (Design) in progress. Customer responses pending on C-01, C-03, C-05, C-06, C-07, C-09, C-10, C-14.
> **Last updated:** 2026-05-04
>
> **How to use this file:**
> - Each item below is something we need confirmation on before final code generation.
> - Each item has a `Status`, a `Default assumption` (what the design uses if no answer is received), and a `Customer response` block to fill in.
> - Status values: `OPEN` (waiting on response), `ANSWERED` (response captured), `DEFERRED` (out of scope for v1), `BLOCKED` (cannot proceed without).
> - When a customer responds, update the `Customer response` block, change `Status` to `ANSWERED`, and add the date.

---

## Architectural decisions already locked (not open items — for reference)

These are decisions made during discovery that are no longer up for debate but are captured here so reviewers can see the rationale at a glance.

### AD-01 — VxRail-only scope using KB 000345284 esxcli procedure

The workflow is designed for **VxRail clusters only** and follows the **Dell KB 000345284 esxcli procedure** for manual within-major-version ESXi patching. Per-host operations follow the KB exactly:

1. Place host in Maintenance Mode with "Ensure Accessibility" option (vSAN safety).
2. Enable SSH on the host (workflow toggles SSH state on demand; see C-03).
3. SSH to the host, run `esxcli software sources profile list --depot=<path>` to enumerate profiles.
4. Run `esxcli software profile update -p <profile-standard> --depot=<path>` (with optional `--no-hardware-warning`).
5. Reboot the host.
6. Verify host reconnects to vCenter and reports the new build.
7. Disable SSH on the host.
8. Exit Maintenance Mode.
9. Move to next host (one at a time per cluster, per vSAN FTT=1 constraint).

The procedure is documented as a fallback path used when standard VxRail/vLCM upgrade tooling is unavailable or unreliable.

### AD-02 — Per-vCenter workflow scope

The workflow is invoked **once per vCenter**. The operator selects exactly one vCenter and one or more clusters within that vCenter. Patching multiple vCenters in a single estate-wide patch event is done by submitting the workflow N times (once per vCenter), not by parallelizing across vCenters within a single workflow.

**Rationale:**

- Aligns with how vCenter itself scopes its tooling (vLCM, Skyline are per-vCenter).
- Each per-vCenter run has its own deployment record, log marker, email, cluster locks. Failure blast radius is contained to one vCenter.
- Form-time external validation actions are dramatically faster (one vCenter to query, not many).
- Cluster-scope locks (`ESXI_PATCH_<vcenter-fqdn>_<cluster-moref>`) naturally allow simultaneous runs against different vCenters without contention.

**Future work captured:** A parent workflow in VCF Automation that loops over a list of vCenters and submits the per-vCenter workflow N times can be added later if estate-wide single-click patching becomes a requirement. Documented in the Design Document's Future Work section.

### AD-03 — No automated rollback

Per discussion in discovery batch 2, automated rollback is not implemented. ESXi's alt-bootbank rollback (Shift+R at bootloader) requires interactive console access and cannot be automated without an iDRAC/IPMI scripting layer that is out of scope for this project. Instead, the workflow implements **failure containment**:

- Failed host → cluster halts (other hosts in that cluster are not patched).
- Other clusters running in parallel continue unaffected.
- Failed host left in a known state (in MM, post-attempt, vCenter-connected if possible).
- Immediate notification email sent.
- User Guide includes a manual recovery runbook section.

### AD-04 — Strict vSAN cluster size policy

For VxRail clusters (which are vSAN-backed), the workflow enforces a strict 4-node minimum:
- 2 nodes → block (would violate FTT=1 immediately).
- 3 nodes → block (no headroom for any other failure during patch window).
- 4+ nodes → proceed.

No override flag. This is the conservative choice — patching can resume on 3-node clusters via manual procedure if absolutely needed.

### AD-05 — Credentials in encrypted Configuration Element (CyberArk CCP deferred)

ESXi root credentials are stored in encrypted Configuration Element entries. CyberArk CCP integration was evaluated (the customer has CyberArk, but it requires MFA which is incompatible with unattended retrieval through standard CyberArk REST APIs). CCP would solve the MFA problem but is a separate integration project. Documented as Future Work.

### AD-06 — PowerFlex clusters explicitly out of scope

The workflow operates **only on VxRail clusters**. PowerFlex clusters — including PowerFlex Hyperconverged and PowerFlex Compute-Only nodes running ESXi — are explicitly excluded from this workflow's scope.

**Rationale:**

1. **Vendor-supported alternative exists.** PowerFlex Manager (PFMP) provides the Single Component Upgrade (SCU) feature for ESXi patching on PowerFlex clusters (Dell KBs 000223004 and 000334907). Even when this tooling is unreliable, the customer's path to resolution is Dell PowerFlex support, not internal automation.
2. **Failure mode requires Dell engagement.** Dell's KB for SCU explicitly states "if the upgrade fails, contact Dell Support for assistance." Building automation that bypasses this path creates support boundary ambiguity — if PowerFlex storage is degraded after our automation ran, ownership of the recovery is unclear between our team and Dell.
3. **PowerFlex storage stack has its own state machine.** PowerFlex requires SDC (Storage Data Client) installed as an ESXi VIB and depends on MDM/SDS cluster health. Manual patching on PowerFlex hosts can leave the storage stack in a state that PFMP cannot reconcile, creating a worse problem than the one we're trying to solve.
4. **Customer-specific scope.** The customer's stated automation need is around their VxRail patching specifically. PowerFlex was a concurrent infrastructure consideration, not a stated automation target.

**Implementation:** The workflow's pre-flight gates positively identify each selected cluster as a VxRail cluster. Any cluster that is not a VxRail cluster (PowerFlex hyperconverged, generic vSAN, vSphere with VMFS/NFS, etc.) is refused with a clear error. The form's cluster picker visually labels clusters by type so operators see why non-VxRail clusters are unselectable.

**Implementation note for code generation:** The exact API path for VxRail Manager registration detection needs to be verified during Phase 4 against current vCenter SDK / VxRail Manager extension APIs. The likely detection path is "vSAN is enabled on the cluster AND the cluster's vCenter has a VxRail Manager extension registered AND the cluster is in VxRail Manager's managed inventory." This is flagged as a known implementation task and the design document will reflect the finalized detection logic.

### AD-07 — Layered workflow architecture

The automation is built as **three layered workflows**, each with single responsibility, communicating via asynchronous workflow execution and structured result objects:

```
Layer 1 (top, catalog item):  Patch ESXi vCenter
                              ├─ runs Patch ESXi Cluster N times in parallel (bounded by maxParallelClusters)
                              │
Layer 2 (middle, internal):   Patch ESXi Cluster
                              ├─ runs Patch ESXi Host once per host, sequentially (one-at-a-time per cluster)
                              │
Layer 3 (bottom, internal):   Patch ESXi Host
                              └─ KB 000345284 procedure on a single host
```

**Responsibilities by layer:**

- **Patch ESXi vCenter** — the only catalog item exposed to operators. Owns the request form, vCenter-level pre-flight checks, parallelism cap, vCenter-level reporting, top-level run summary, email notifications, deployment outputs.
- **Patch ESXi Cluster** — internal. Owns the cluster-scope lock, per-cluster pre-flight gates (cluster type, size, HA/DRS, no host in MM), sequential host iteration, halt-on-host-failure logic, cluster-level result aggregation.
- **Patch ESXi Host** — internal. Owns the per-host KB 000345284 procedure: MM enter → SSH enable → esxcli profile update → reboot → reconnect verify → SSH disable → MM exit. Returns a structured per-host result.

**Error propagation pattern:**

Child workflows **catch, classify, structure, and return** known failure modes via their result objects. They only **rethrow** truly unexpected exceptions. The parent workflow processes structured results as normal flow control and treats child workflow exceptions as "the child workflow itself broke" — which is rare and alarmable.

**Reusable library impact:**

A new general-purpose Action `com.broadcom.pso.common.workflow.runWithParallelism` is added to the reusable library. This Action takes an array of work items, a worker workflow reference, an input-builder function, and a parallelism cap, and handles the work-pool dispatch loop with true asymmetric scheduling (a fast worker finishing frees a slot for the next queued item, regardless of slower workers still running). Has utility well beyond this project — any future workflow needing bounded fan-out parallelism uses it.

**Result object contracts:**

| Layer returns | Structure |
|---|---|
| **Patch ESXi Host** | `{ hostFqdn, hostMoRef, outcome, failurePhase, failureReason, preBuild, postBuild, durationSeconds, interventionEmailSentAt }` |
| **Patch ESXi Cluster** | `{ vcenterFqdn, clusterName, clusterMoRef, outcome, hostsAttempted, hostsSucceeded, hostsFailed, hostsSkipped, haltedReason, hostResults[] }` |
| **Patch ESXi vCenter** | `{ vcenterFqdn, runStatus, runSummary, runReportHtml, clustersAttempted, clustersSucceeded, clustersFailed, clustersSkipped, emailsSent[], clusterResults[] }` |

`outcome` enumeration: `SUCCESS`, `PARTIAL`, `FAILED`, `SKIPPED`, `DRY_RUN`.

`failurePhase` enumeration (for Patch ESXi Host): `MM_ENTER`, `SSH_ENABLE`, `PATCH_LIST`, `PATCH_INSTALL`, `REBOOT`, `RECONNECT`, `SSH_DISABLE`, `MM_EXIT`, `VERIFY_BUILD`.

**v1 exposure:** Only **Patch ESXi vCenter** is exposed as a VCF Automation catalog item. The cluster and host workflows are internal. If operators later need a "retry one host" recovery utility, exposing Patch ESXi Host as a separate catalog item is a small future-work item.

**Layer 0 / Patch ESXi Estate:** Deferred to v2. The current operating model is "operator runs Patch ESXi vCenter once per vCenter" which is acceptable for 7-10 vCenters. If estate-wide single-click patching becomes a requirement, a Layer 0 wrapper can be added later.

---

## Summary table — current open items

| # | Topic | Owner | Status | Priority |
|---|---|---|---|---|
| C-01 | Content Library backing (NFS in datacenter vs. stage-and-clean fallback) | Customer infra team | OPEN | HIGH |
| C-02 | Single Published CL + Subscribers vs. independent CL per vCenter | Customer infra team | OPEN | MEDIUM |
| C-03 | Security policy for runtime SSH enable/disable on ESXi hosts | Customer security team | OPEN | HIGH |
| C-04 | SMTP plugin pre-configuration confirmation | Customer infra team | OPEN | MEDIUM |
| C-05 | ESXi root password storage scheme (per-host vs cluster-shared, rotation policy) | Customer infra team | OPEN | HIGH |
| C-06 | Build the optional "Pre-flight Validation" sibling workflow? | Customer ops team | OPEN | LOW |
| C-07 | Fixed cc list for notification emails? | Customer ops team | OPEN | LOW |
| C-08 | CyberArk CCP integration (instead of encrypted Configuration Element) | Customer security team | DEFERRED (v2) | FUTURE |
| C-09 | Content Library name where ESXi depot ZIPs are stored | Customer infra team | OPEN | MEDIUM |
| C-10 | Approximate ESXi host reboot time on customer hardware | Customer infra team | OPEN | MEDIUM |
| C-11 | VCF Automation deployment lifecycle pattern (persist as job record vs. self-delete) | Internal (architect) | ANSWERED (Pattern B) | MEDIUM |
| C-12 | Confirm form section layout and two-tier check pattern | Internal (architect) | ANSWERED (Approved) | MEDIUM |
| C-13 | Credentials for form-time vCenter health-check actions | Internal (architect) | ANSWERED (Reuse inventory connections) | MEDIUM |
| C-14 | Confirm patches are within ESXi 8.x major version (not crossing 8 → 9 boundary) | Customer infra team | OPEN | HIGH |

---

## C-01 — Content Library backing strategy

**Why it matters:**
The Dell KB procedure runs `esxcli software profile update --depot=<path>` from the ESXi host, where `<path>` must resolve to a file the host can read. If the depot ZIP is stored in a Content Library backed by an NFS datastore that is mounted on every host, the file is accessible at a deterministic `/vmfs/volumes/<nfs-name>/contentlib-<uuid>/<item>/<file>.zip` path on every host with no copy step required. If the CL is backed by a non-shared datastore (e.g., a single-host VMFS), the workflow must copy the ZIP from the CL backing datastore to a cluster-shared datastore, patch all hosts, then delete the staged copy.

**Question for the customer:**
Can the Content Library hosting the ESXi depot ZIPs be backed by an **NFS datastore mounted on every ESXi host in the datacenter**? If yes, no per-cluster staging is required. If no, the workflow needs to perform a copy-stage-clean operation per cluster, which adds time, code, and failure modes.

**Default assumption (used until answered):**
Design supports **both modes** via a `patchStagingMode` input parameter with values `CONTENT_LIBRARY_DIRECT` (the elegant case) or `CLUSTER_DATASTORE_STAGE` (the fallback). Workflow detects the CL backing at runtime and validates the operator's mode selection against it.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** HIGH

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- If "yes, NFS-backed": simplify by removing the stage-and-clean code path entirely.
- If "no": keep both modes, but document the operational impact (longer runtime, more failure surface).

---

## C-02 — Content Library distribution model

**Why it matters:**
With 7-10 vCenters and a per-vCenter workflow scope, the depot ZIP needs to exist in a Content Library on each vCenter where patching will occur. Two patterns work:

- **Published + Subscriber:** One Published CL on a "master" vCenter; each downstream vCenter has a Subscriber CL that auto-syncs items. Operator uploads once; ZIP replicates everywhere. Item IDs differ between vCenters but item names match.
- **Independent CLs:** Operator uploads the ZIP into a CL on each vCenter manually. More work, but each CL is independent.

**Question for the customer:**
Which pattern is in use today for distributing software bundles across vCenters? If neither is established, the Published+Subscriber pattern is recommended — it minimizes the per-event upload effort.

**Default assumption (used until answered):**
Workflow's depot picker matches by **item name** within the selected vCenter's CL, not by global item ID. This works with either pattern.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
None — workflow is pattern-agnostic. Documentation will reflect the customer's actual setup.

---

## C-03 — Security policy for runtime SSH enable/disable on ESXi hosts

**Why it matters:**
ESXi root SSH is the **only** way to run `esxcli software profile update`. There is no vCenter API equivalent. The workflow's design enables SSH on each host immediately before patching and disables it immediately after, on every host it touches. Some customer security policies require an approved Change Request before enabling SSH on a production host, which would make per-run automation incompatible with their policy.

**Question for the customer's security team:**
1. Is there a security policy requiring an approved CR before SSH can be enabled on an ESXi host?
2. If yes, is this workflow's automated enable/disable acceptable as a pre-approved standing change pattern?
3. If no, please confirm in writing that runtime SSH state changes are acceptable for this workflow.

**Default assumption (used until answered):**
**No CR required.** This assumption is flagged prominently in the Risks section and the Implementation Guide will require security team sign-off before go-live if this in fact a requirement.

**Status:** OPEN
**Owner:** Customer security team
**Priority:** HIGH

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- If CR is required: the workflow becomes a manual-trigger-only tool with a documented pre-execution checklist that includes CR approval. No code change, but operational model changes.
- If acceptable as-is: documented in Implementation Guide, no change.

---

## C-04 — SMTP plugin pre-configuration

**Why it matters:**
The workflow uses the out-of-box `com.vmware.library.mail` action, which requires an SMTP host to be configured in vRO inventory. Without a working SMTP host, the workflow cannot send notification emails — and notifications are a hard requirement.

**Question for the customer:**
1. Confirm an SMTP host is registered in the vRO inventory under **Inventory → Mail**.
2. Confirm sender address is configured (e.g., `vro-noreply@<customer-domain>`).
3. Confirm TLS / authentication method (typically TLS on port 587 with username/password).
4. Confirm the sending account has authority to email the intended recipients (no relay restrictions blocking workflow-originated mail).

**Default assumption (used until answered):**
One SMTP host is registered in inventory and discoverable via `Server.findAllForType("Mail:SMTPClient")`. Sender address is preconfigured on the SMTP host record. TLS is in use.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
None — but smoke testing the SMTP send is a Phase 6 prerequisite check.

---

## C-05 — ESXi root password storage and rotation

**Why it matters:**
The workflow needs to SSH to each ESXi host as root to run `esxcli software profile update`. Credentials must be retrievable at runtime in a non-interactive way. The schema of the Configuration Element holding these credentials depends on whether root passwords are unique per host or shared per cluster.

**Question for the customer:**
1. Are ESXi root passwords **unique per host**, **shared per cluster**, or **shared across the entire estate**?
2. What is the rotation policy? (Quarterly? On-demand? Tied to VxRail upgrades?)
3. Is there a process for updating the password in the Configuration Element when rotation occurs?

**Default assumption (used until answered):**
**Shared root password per cluster.** One Configuration Element entry per cluster, keyed by `<vcenter-fqdn>/<cluster-moref>`, holding `{ sshUsername: "root", sshPassword: <encrypted-string> }`. Rotation requires manual update of the CE.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** HIGH

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- Per-host passwords: CE schema changes to keyed by `<vcenter-fqdn>/<host-fqdn>`.
- Estate-wide shared: simplifies CE to a single entry. **Not recommended** but supported.
- CyberArk CCP retrieval: see C-08.

---

## C-06 — Optional "Pre-flight Validation" sibling workflow

**Why it matters:**
A sibling workflow that runs the same pre-flight checks as the main workflow but **makes no changes** lets operators verify a planned scope is healthy before submitting the actual patch run. Costs ~1 day to build because it reuses the validation Actions from the main workflow.

**Question for the customer:**
Do operators want a "Validate ESXi Patching Prerequisites" workflow they can run separately, or is it sufficient that the request form's external validations surface the same information?

**Default assumption (used until answered):**
**YES, build it.** It's cheap and operators usually appreciate a separate validation tool.

**Status:** OPEN
**Owner:** Customer ops team
**Priority:** LOW

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- If yes: add to Phase 4 code generation and Phase 5 assembly instructions.
- If no: drop from scope. Saves a small amount of time.

---

## C-07 — Fixed cc list for notification emails

**Why it matters:**
The form has a `notificationEmailRecipients` text field for operator-supplied recipients. Some teams want a fixed distribution list (e.g., `infrastructure-ops@customer.com`) always copied regardless of operator input.

**Question for the customer:**
Is there a fixed distribution list that should always receive a copy of the workflow's notification emails, in addition to whatever the operator specifies?

**Default assumption (used until answered):**
**Operator-supplied only.** No fixed cc list.

**Status:** OPEN
**Owner:** Customer ops team
**Priority:** LOW

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- If yes: add a Configuration Element entry `notificationFixedCcList` and append to recipient list at email-send time.
- If no: no change.

---

## C-08 — CyberArk CCP integration (deferred to v2)

**Why it matters:**
Storing ESXi root credentials in a vRO Configuration Element (even encrypted) is a known weakness. CyberArk CCP (Central Credential Provider) supports unattended retrieval via certificate or IP-allowlist authentication and would not require MFA. However, CCP integration is a meaningful project on its own — it requires a CCP endpoint exposed to vRO, an Application ID provisioned in CyberArk, and certificate or allowlist configuration.

**Question for the customer:**
Does CyberArk CCP exist in the environment? If yes, is it possible to provision a CCP application for vRO?

**Default assumption (used until answered):**
**Out of scope for v1.** Encrypted Configuration Element is used. CCP integration is documented as Future Work in the Design Document.

**Status:** DEFERRED
**Owner:** Customer security team (for v2 planning)
**Priority:** FUTURE

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- For v1: no change — encrypted CE is the v1 pattern.
- For v2: design a credential-retrieval Action that abstracts the source (CE vs CCP) so the rest of the codebase doesn't change.

---

## C-09 — Content Library name for ESXi depots

**Why it matters:**
The form's depot picker is filtered to a specific Content Library (configurable via Configuration Element). The default name needs to match what the customer actually creates.

**Question for the customer:**
What name will the Content Library hosting ESXi depot ZIPs use? The recommended default is `ESXi-Patches`.

**Default assumption (used until answered):**
**`ESXi-Patches`.** Stored in Configuration Element `esxiPatchContentLibraryName`. Easily changed post-deployment.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
None — value is configurable. Just need the right default.

---

## C-10 — ESXi host reboot time on customer hardware

**Why it matters:**
The `hostRebootTimeoutMinutes` input parameter sets how long the workflow waits for a host to come back online after reboot. Set too short → false-positive failures on slow hardware. Set too long → workflow hangs forever on a genuinely-stuck host. The default needs to reflect actual reboot times in this environment.

**Question for the customer:**
Approximately how long does an ESXi host take to reboot in this environment, from `reboot` command issued to reconnected/responsive in vCenter? Worst case observed?

**Default assumption (used until answered):**
**25 minutes.** This is the workflow input default. Operators can override per-run.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** MEDIUM

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- If typical reboot time is significantly different: adjust default in workflow input definition.
- Workflow logic does not change.

---

## C-11 — VCF Automation deployment lifecycle (persist vs. self-delete)

**Why it matters:**
When the workflow is launched from VCF Automation, a Deployment record is created. Two patterns:
- **Pattern A — Ephemeral.** Workflow self-deletes its deployment on completion via REST API. Clean catalog, but history requires looking in vRO + log indexer + email archive.
- **Pattern B — Persistent.** Deployment stays in place as a job record. Operators see "show me the last 90 days of patching" as a deployments-view filter. Outputs include full HTML report visible directly on the deployment detail page.

**Question for the architect:**
Pattern A or Pattern B?

**Default assumption (used until answered):**
**Pattern B.** Recommendation: configure a 365-day VCF Automation lease policy on the catalog item so old job records auto-purge.

**Status:** ANSWERED
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
- Date received: 2026-05-04
- Response: **Pattern B**

**Action if answer changes design:**
- Pattern B locked: no extra code; document the lease policy as an Implementation Guide step.

---

## C-12 — Form section layout and two-tier check pattern

**Why it matters:**
Per the operational requirement that operators see all warnings/blockers/acknowledgements in the request form (no Awaiting User Interaction during execution), the form has multiple sections with dependent fields and external-value validations. The form lives only on the **Patch ESXi vCenter** (Layer 1) workflow per AD-07.

**Approved form layout:**

| Order | Section | Contents | Notes |
|---|---|---|---|
| 1 | Acknowledgement | Heading + mandatory checkbox: "I acknowledge this is manual VxRail patching outside vLCM/VxRail Manager and may trigger noncompliance alarms." | Required-checked to advance |
| 2 | Scope Selection | vCenter **single-select**. Cluster multi-select (dependent on vCenter, with type+health labels). | Each cluster shown with `(VXRAIL — READY)`, `(VXRAIL — BLOCKED: reason)`, `(VXRAIL — WARNING: reason)`, `(POWERFLEX — NOT SUPPORTED)`, `(VSAN-ONLY — NOT SUPPORTED)`, `(OTHER — NOT SUPPORTED)`. Only `(VXRAIL — READY)` and `(VXRAIL — WARNING)` are selectable. |
| 3 | Patch Source | Content Library item picker (dependent on selected vCenter). Patch staging mode (Direct vs Stage-and-Clean). | Picker filtered to ESXi depot pattern. |
| 4 | Execution Parameters | `maxParallelClusters` (default 3). `hostRebootTimeoutMinutes` (default 25). `bypassHardwareCheck` (default false, with warning text). | Operator parameters with sane defaults. |
| 5 | Notification | `notificationEmailRecipients` (text, comma-separated, required). | At least one recipient required. |
| 6 | Advanced (collapsed) | `debugLogging` (default false). `ignorePreflightWarnings` (default false). `dryRun` (default true). | `dryRun` defaults to TRUE — operator must explicitly opt out. |

**Two-tier check pattern:**
- **Form-time (cheap checks):** cluster type identification (VxRail vs other), HA enabled, DRS enabled, host count, host MM state. All readable from cached vCenter inventory.
- **Workflow-start-time (full checks):** all form-time checks repeated for late-binding safety + active vSAN resync + cluster-not-in-other-upgrade. Performed in Patch ESXi Cluster's pre-flight phase.

**Question for the architect:**
Approve the section layout, the cluster-type labeling scheme, and the two-tier check pattern?

**Default assumption (used until answered):**
Layout, labeling, and two-tier pattern as above.

**Status:** ANSWERED
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
- Date received: 2026-05-04
- Response: **Approved**

**Action if answer changes design:**
- Approved as-is: no change.

---

## C-13 — Credentials for form-time vCenter health-check actions

**Why it matters:**
The form's external-value actions (the ones that populate the cluster picker with health labels) must connect to vCenter to evaluate health. They run under whatever identity vRO uses for action execution, which is usually the inventory's registered vCenter SDK connection identity. This is the simplest path — no new credentials needed — but it means the form actions and the workflow run under the same identity.

**Question for the architect:**
Is it acceptable to reuse the inventory-registered vCenter SDK connection credentials for form-time health checks, or should there be a dedicated read-only service account for form actions?

**Default assumption (used until answered):**
**Reuse inventory connections.** Same identity as workflow.

**Status:** ANSWERED
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
- Date received: 2026-05-04
- Response: **Reuse inventory connections**

**Action if answer changes design:**
- Reuse locked: no extra work.

---

## C-14 — ESXi within-major-version patching only (no cross-major-version upgrades)

**Why it matters:**
Dell KB 000345284 is specifically a **within-major-version manual patching** procedure. Cross-major-version ESXi upgrades (e.g., ESXi 8 → ESXi 9) on VxRail clusters have additional considerations not covered by KB 000345284:

- VxRail-aligned image bundles for the target major version (not just generic VMware depot ZIPs).
- Firmware compatibility validation between the new ESXi major version and the VxRail node hardware.
- vSAN on-disk format upgrades, which are a separate operation requiring cluster-wide coordination.
- VxRail Manager schema and inventory changes that may need reconciliation.

This workflow is being designed for **patch updates within ESXi 8.x** only.

**Question for the customer:**
1. Confirm that all patches to be applied via this workflow are within ESXi 8.x (e.g., 8.0 U2c → 8.0 U2d, or similar within-major patches).
2. Confirm there is no near-term plan to use this workflow for ESXi 8 → ESXi 9 upgrades. If there is such a plan, that's a separate workflow (and likely a separate procedure beyond KB 000345284) that should be designed separately.

**Default assumption (used until answered):**
**Within-major-version only (ESXi 8.x → 8.x).** Workflow does not handle cross-major-version logic. The form's depot picker can additionally constrain to depots matching the currently-installed major version pattern as a defense-in-depth check.

**Status:** OPEN
**Owner:** Customer infrastructure team
**Priority:** HIGH

**Customer response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- If only within-major-version: no change. Document the constraint in the User Guide and workflow input field help text.
- If they need cross-major-version too: significant additional design work. Recommend deferring to v2 with a separate workflow.

---

## Notes / scratchpad

Use this space to jot down anything else that comes up during customer conversations.

```
[YYYY-MM-DD] —
```
