# Leadership Brief — Document Structure

**Audience:** Senior leaders, Broadcom Professional Services Organization
**Thesis:** VCF Automation is replacing manual VM builds and a sprawling Ansible estate at the U.S. Department of State — delivering efficiency, labor, and security gains, and demonstrating Broadcom delivery success.
**Recommended length:** 2–3 pages. Exec summary must stand alone.

> Blockquotes are guidance to the author — delete before sending.
> **Two grounding facts.** (1) The Ansible estate is still executing in production as of 19 Aug 2026 — write the transition as *underway*, not complete. (2) The VM automation artifacts reference a lab environment (`vcf.lab`, project `Jeremy`); confirm production status at DoS before claiming deployed results. See §8.

---

## 1. Executive Summary
*4–6 bullets. Write last.*

> Suggested spine:
> - DoS builds VMs through **~20 discrete manual steps** per server; VCF Automation reduces this to **one catalog request**.
> - Windows guest-customization and Linux shell-prep pipelines are **built and end-to-end tested**.
> - In parallel, the legacy Ansible estate — **185 templates covering only 40 real capabilities, 44% never executed, 14.8% failure rate** — is being consolidated onto the same platform.
> - Security posture improves structurally: secrets move out of automation variables into managed credential stores.
> - Delivered on VCF the customer already licenses, using a method that transfers to other accounts.

---

## 2. The Situation We Found

### 2.1 VM provisioning was fully manual
Every server build required an administrator to hand-execute roughly twenty discrete tasks:

| Stage | Manual steps today |
|---|---|
| Placement | Select vCenter, cluster, VM folder, port group |
| Sizing | Set CPU, memory |
| Identity | Assign hostname to naming standard (15-char NetBIOS limit) |
| Network | Configure static IP, gateway, DNS, search domains **inside the guest** |
| Directory | Pre-create AD computer object in the correct OU; join domain |
| Accounts | Rename local administrator; set new password |
| Media | Correct CD drive letter; attach install ISO (Linux) |
| Storage | **Per data disk:** add disk, choose SCSI controller, choose provisioning type, initialize, select MBR vs GPT, partition, format NTFS, assign drive letter, set volume label |
| Decommission | Manually remove stale AD computer object |

> The storage row is the compounding one — those nine steps repeat for **every** data disk, up to ten per VM.

### 2.2 The Ansible estate had accumulated sprawl
*Measured from estate inventory and job-run history, point-in-time 19 Aug 2026.*

| Finding | Measure |
|---|---|
| Template sprawl | 185 templates → 40 capabilities (4.6:1) |
| Dead automation | 81 of 185 never executed (44%) |
| Reliability | 748 failed of 5,061 runs (14.8%) |
| Concentration | Top 4 capabilities = 71% of all runs |
| Duplication | 12 templates / 5 playbooks performing one log-archival operation |
| Duplication | 10 separate playbooks producing VMware reports via one identical mechanism |
| Credential exposure | API bearer tokens stored in cleartext template variables |

**Framing discipline:** attribute to the *operating model*, not to Ansible the product. See §8.

---

## 3. What We Built

### 3.1 Self-service VM provisioning (VCF Automation 9.1)
**Consumption:** Service Broker catalog — 4 items (Windows 2025 ± data disks, Linux shell ± data disks), each with a guided input form.

**Request-time intelligence — 13 vRO actions populate the form dynamically:**
- Live pickers for vCenter, cluster, network, folder, ISO, OS version — the requester picks from what actually exists, eliminating a whole class of typo/stale-value failures.
- **Project-scoped AD OU picker** that lists only OUs beneath the requesting project's base OU, and **fails closed** if unconfigured — it will never enumerate the whole directory.

**Blueprint-driven resource assignment:**
- Hostname validated against naming standard at request time.
- CPU (1–64), memory (1–512 GB).
- Compute and network placement via tag constraints.
- **Static IP, gateway, DNS, and search domains applied automatically.**
- Up to 10 data disks, each with size, SCSI controller (1–3), and provisioning type.
- Domain-join vs workgroup selects the matching vCenter customization spec automatically.

**Post-provision guest customization — event-driven, no administrator involvement:**

*Windows pipeline* (triggered on `compute.provision.post`):
1. Guest-readiness gate — polls VMware Tools until the guest can accept operations, then proceeds.
2. Corrects CD drive letter.
3. Renames the local administrator account.
4. Sets a new local administrator password, **read from a vRO credential store — never present in the blueprint or the request**.
5. Mounts and formats every data disk.

*Disk automation is the standout piece.* It correlates each VMDK to its in-guest disk by **UUID→serial number**, so it is controller-agnostic and cannot mis-target a disk. It auto-selects MBR or GPT at the 2 TB boundary, formats NTFS, applies the drive letter and volume label — and refuses to touch any disk that is not RAW, so an existing disk can never be wiped.

*Linux pipeline:* deploys a throwaway template to satisfy the platform's guest-readiness gate, then reshapes the VM — powers off, recreates the boot disk empty, attaches the selected ISO — handing back a clean install target.

**Lifecycle:** destroy-time workflow removes the AD computer object, preventing stale-account accumulation.

### 3.2 Ansible → Orchestrator consolidation
- Full estate inventory and capability mapping complete (§2.2).
- **Capability-based consolidation, not 1:1 port** — grouping templates by what they do rather than migrating each one. This is the reusable methodology.
- Current phase: [state it].

---

## 4. Efficiency Impact — Financial & Labor

### 4.1 Measured / demonstrable
- **~20 manual steps per VM → 1 catalog request.**
- Nine per-disk manual steps eliminated, repeating up to ten times per VM.
- Windows and Linux pipelines **built and end-to-end tested**.
- Ansible maintenance surface: **185 → ~40** services once consolidation completes.
- **81 never-used templates** retired.

### 4.2 Needs your input — highest-value numbers
> 1. **Cycle time**: ticket → usable VM, before vs. after. Single strongest metric.
> 2. **Build volume**: VMs/month, and admin-hours per build today.
> 3. **Rework rate**: builds today needing correction for drift/missed steps.
> 4. **Self-service deflection**: % of requests fulfilled without ops involvement.
> 5. **Tooling consolidation**: licenses/support retired.

> Labor math is straightforward once you have #2 — *(manual hours per build × builds per month)* is a defensible monthly figure and the kind of number this audience remembers.

### 4.3 Financial framing
- Delivered **within VCF the customer already licenses** — capability unlock, not new spend.
- Capacity returned to mission work rather than headcount reduction. Recommended framing for a federal customer.

---

## 5. Security & Compliance Impact

### 5.1 What the automation design improves
- **Secrets out of automation logic** — credentials live in vRO Configuration Elements as SecureStrings, not in blueprints, forms, or request payloads. Directly addresses the cleartext-token pattern found in the Ansible estate.
- **Least-privilege directory exposure** — the OU picker is project-scoped and fails closed.
- **Guaranteed account hygiene** — local admin renamed and password rotated on *every* build, with no reliance on an administrator remembering.
- **No stale AD objects** — destroy-time cleanup is part of the workflow.
- **Destructive-action guardrails** — disk automation refuses non-RAW disks and duplicate drive letters.
- **Full audit trail** — every provisioning and customization run recorded in VCFA and vRO.
- **Supported-only discipline** — an undocumented internal API was found to work and was **deliberately rejected** for production. Worth one line; it signals engineering judgment to a PSO audience.

### 5.2 Measured weaknesses in the prior estate
- Live API bearer tokens in cleartext template variables (3 confirmed).
- Service-account credentials referenced ad-hoc with no central custody.
- Broad privilege escalation across most templates.
- **STIG remediation automation for RHEL and PowerFlex/SLES shows zero executions** — capability built, never operated.

### 5.3 Needs your input
> - Audit/ATO findings closed or avoided.
> - Whether the golden images / blueprints enforce a STIG-compliant baseline.

---

## 6. Why This Matters to Broadcom
- **Displacement win** — VCF Automation replacing third-party tooling in a federal account.
- **Platform pull-through** — consumed within VCF the customer already owns.
- **Repeatable method** — discovery → capability mapping → consolidation, transferable to any inherited automation estate.
- **Reusable assets** — inventory tooling, capability taxonomy, and a VM-provisioning workflow package (`com.broadcom.pso.vcfa.*`) portable to the next engagement.
- **Reference value** — federal modernization proof point.

---

## 7. Status & What's Next
- Windows guest customization: complete, end-to-end tested.
- Linux shell preparation: complete, end-to-end tested.
- AD domain-join integration: **in progress** — create-computer and destroy-cleanup workflows, event subscriptions, and form→template wiring remain open.
- Ansible consolidation: baseline complete, design phase.
- Risks/dependencies: change-control windows, customer resourcing, environment access.

---

## 8. Credibility Guardrails — read before writing

**1. Confirm lab vs. production.** The VM automation artifacts reference `vcf.lab` / project `Jeremy`. If this is validated but not yet running at DoS, say "built and validated, deployment in progress." Claiming production results that don't exist is the single biggest risk in this document.

**2. The AD piece isn't finished.** The design notes list open items — create-computer workflow, destroy-cleanup, subscriptions, form wiring. Don't present domain-join as delivered.

**3. Don't claim a completed Ansible migration.** It ran in production today.

**4. Attribute problems to the operating model, not the product.**
- Attackable: "Ansible caused 44% dead templates."
- Defensible: "Task-level automation without a governing catalog accumulates orphaned artifacts — 44% never executed. A catalog-and-lifecycle model structurally prevents this."

The second is more honest *and* harder to argue with. This audience knows sprawl is an estate-management failure; blaming the tool signals you don't, and costs you the room on your strongest evidence.

**5. Separate measured from projected, visibly.** Mixing them gets the whole document discounted.

**6. Don't invent savings.** One unsourced dollar figure invites re-litigation of everything. "Financial modeling in progress" is better than a guess.

**7. Sanitize.** Source material contains customer hostnames, AD groups, service accounts, domains, and live tokens. None belongs here — including in screenshots.

**8. Confirm customer attribution** before naming the Department of State, even internally.

**9. Expect "what's the failure rate now?"** 14.8% is strong evidence of the problem and an obvious follow-up question.
