# ESXi Patching Workflow — Open Items & Customer Questions 

> **Project:** Manual ESXi Patching Automation per Dell KB 000345284
> **Platform:** VCF 9.x (Orchestrator + Automation, vSphere 8 on VxRail and PowerFlex)
> **Status:** Discovery in progress
> **Last updated:** 2026-05-04
>
> **How to use this file:**
> - Each item below is something we need confirmation on before final code generation.
> - Each item has a `Status`, a `Default assumption` (what the design uses if no answer is received), and a `Customer response` block to fill in.
> - Status values: `OPEN` (waiting on response), `ANSWERED` (response captured), `DEFERRED` (out of scope for v1), `BLOCKED` (cannot proceed without).
> - When a customer responds, update the `Customer response` block, change `Status` to `ANSWERED`, and add the date.

---

## Summary table

| # | Topic | Owner | Status | Priority |
|---|---|---|---|---|
| C-01 | Content Library backing (NFS in each DC vs. stage-and-clean fallback) | Customer infra team | OPEN | HIGH |
| C-02 | Single Published CL + Subscribers vs. independent CL per vCenter | Customer infra team | OPEN | MEDIUM |
| C-03 | Security policy for runtime SSH enable/disable on ESXi hosts | Customer security team | OPEN | HIGH |
| C-04 | SMTP plugin pre-configuration confirmation | Customer infra team | OPEN | MEDIUM |
| C-05 | ESXi root password storage scheme (per-host vs cluster-shared, rotation policy) | Customer infra team | OPEN | HIGH |
| C-06 | Build the optional "Pre-flight Validation" sibling workflow? | Customer ops team | OPEN | LOW |
| C-07 | Fixed cc list for notification emails? | Customer ops team | OPEN | LOW |
| C-08 | CyberArk CCP integration (instead of encrypted Configuration Element) | Customer security team | DEFERRED (v2) | FUTURE |
| C-09 | Content Library name where ESXi depot ZIPs are stored | Customer infra team | OPEN | MEDIUM |
| C-10 | Approximate ESXi host reboot time on customer hardware | Customer infra team | OPEN | MEDIUM |
| C-11 | VCF Automation deployment lifecycle pattern (persist as job record vs. self-delete) | Internal (architect) | OPEN | MEDIUM |
| C-12 | Confirm form section layout and two-tier check pattern | Internal (architect) | OPEN | MEDIUM |
| C-13 | Credentials for form-time vCenter health-check actions | Internal (architect) | OPEN | MEDIUM |


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
With 7-10 vCenters, the depot ZIP needs to exist in a Content Library that is reachable from each vCenter. Two patterns work:

- **Published + Subscriber:** One Published CL on a "master" vCenter; each downstream vCenter has a Subscriber CL that auto-syncs items. Operator uploads once; ZIP replicates everywhere. Item IDs differ between vCenters but item names match.
- **Independent CLs:** Operator uploads the ZIP into a CL on each vCenter manually. More work, but each CL is independent.

**Question for the customer:**
Which pattern is in use today for distributing software bundles across vCenters? If neither is established, the Published+Subscriber pattern is recommended.

**Default assumption (used until answered):**
Workflow's depot picker matches by **item name**, not item ID, which means it works with either pattern. No code change required either way — but documentation should reflect the customer's actual pattern.

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

**Question for the architect (you):**
Pattern A or Pattern B?

**Default assumption (used until answered):**
**Pattern B.** Recommendation: configure a 365-day VCF Automation lease policy on the catalog item so old job records auto-purge.

**Status:** OPEN
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- Pattern A: add a final cleanup step calling VCF Automation REST API DELETE.
- Pattern B: no extra code; document the lease policy as an Implementation Guide step.

---

## C-12 — Form section layout and two-tier check pattern

**Why it matters:**
Per the operational requirement that operators see all warnings/blockers/acknowledgements in the request form (no Awaiting User Interaction during execution), the form has multiple sections with dependent fields and external-value validations. With per-vCenter workflow scope, the vCenter selector becomes single-select, and form-time external actions are dramatically faster (one vCenter to query, not many).

**Proposed form layout (updated for per-vCenter scope):**

| Order | Section | Contents | Notes |
|---|---|---|---|
| 1 | Acknowledgement | Heading + mandatory checkbox: "I acknowledge this is manual patching outside vLCM/VxRail Manager and may trigger noncompliance alarms." | Required-checked to advance |
| 2 | Scope Selection | vCenter **single-select**. Cluster multi-select (dependent on vCenter, with health labels). | Each cluster shown with `(READY)`, `(BLOCKED: reason)`, `(WARNING: reason)`. Blocked clusters not selectable. |
| 3 | Patch Source | Content Library item picker (dependent on selected vCenter). Patch staging mode (Direct vs Stage-and-Clean). | Picker filtered to ESXi depot pattern. |
| 4 | Execution Parameters | `maxParallelClusters` (default 3). `hostRebootTimeoutMinutes` (default 25). `bypassHardwareCheck` (default false, with warning text). | Operator parameters with sane defaults. |
| 5 | Notification | `notificationEmailRecipients` (text, comma-separated, required). | At least one recipient required. |
| 6 | Advanced (collapsed) | `debugLogging` (default false). `ignorePreflightWarnings` (default false). `dryRun` (default true). | `dryRun` defaults to TRUE — operator must explicitly opt out. |

**Question for the architect (you):**
Approve the section layout and the two-tier check pattern (form-time = cheap checks; workflow-start-time = full checks)?

**Default assumption (used until answered):**
Layout and two-tier pattern as above.

**Status:** OPEN
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
Section layout adjustments are cheap. Check-tier rebalancing has implications for form performance and code structure.

---

## C-13 — Credentials for form-time vCenter health-check actions

**Why it matters:**
The form's external-value actions (the ones that populate the cluster picker with health labels) must connect to vCenter to evaluate health. They run under whatever identity vRO uses for action execution, which is usually the inventory's registered vCenter SDK connection identity. This is the simplest path — no new credentials needed — but it means the form actions and the workflow run under the same identity.

**Question for the architect (you):**
Is it acceptable to reuse the inventory-registered vCenter SDK connection credentials for form-time health checks, or should there be a dedicated read-only service account for form actions?

**Default assumption (used until answered):**
**Reuse inventory connections.** Same identity as workflow.

**Status:** OPEN
**Owner:** Internal (architect)
**Priority:** MEDIUM

**Architect response:**
<!-- Date received: -->
<!-- Response: -->

**Action if answer changes design:**
- Reuse: no extra work.
- Separate read-only account: provision the account, register a separate inventory connection, parameterize form actions to use it.

---


## Notes / scratchpad

Use this space to jot down anything else that comes up during customer conversations.

```
[YYYY-MM-DD] —
```