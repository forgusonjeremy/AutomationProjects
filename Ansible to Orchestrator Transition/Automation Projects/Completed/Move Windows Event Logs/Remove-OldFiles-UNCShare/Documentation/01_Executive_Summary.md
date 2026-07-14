# Remove Old Files (UNC Share) — Executive Summary

**Deliverable:** Remove-OldFiles-UNCShare
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan · WindowsLogManagement-Config_definition
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

---

## Objective

Provide a supported VCF Orchestrator 9 workflow that performs **archive-share
housekeeping** — deleting files on a UNC archive share older than a retention
threshold — replacing the retiring Ansible `remove-OldFiles-UNCPath` playbook and
reusing the proven `cvs_functions.ps1` logic rather than rewriting it.

The workflow defaults to a **safe report-only** run: it lists what *would* be
deleted and deletes nothing until an operator explicitly opts into a live delete.

---

## Scope

**In scope**
- One Orchestrator workflow: **Remove-OldFiles-UNCShare** — delete files on a
  single UNC archive share older than a retention threshold, with a report-only
  default.
- Reuse of the `Delete-OldFiles-UNC-Share` action in `cvs_functions.ps1` on a
  registered PowerShell (PS) host.
- A Configuration Element supplying two input defaults (script path, retention days).

**Out of scope**
- Moving/collecting logs from source servers (a separate deliverable).
- Any Active Directory resolution or per-server iteration — this workflow acts on
  a single UNC target only.
- Provisioning of the archive file share (customer prerequisite).
- Email/structured per-file reporting (Phase 2).

---

## Key benefits

- **Direct port** of the existing cleanup playbook onto a platform the customer
  already owns and operates; reduced tooling sprawl.
- **Safe by default:** `whatIf` defaults to `yes` (report-only), preventing
  accidental deletion on first run or on a newly scheduled trigger.
- **Non-interactive:** the former blocking `Read-Host` confirmation is removed
  (change S-1); the workflow runs cleanly under the Orchestrator PS plug-in.
- **Parameterised:** share path, retention age, and delete/report mode are all
  operator inputs, with environment defaults centralised in a Configuration Element.

---

## Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Accidental deletion** (deletions are permanent, not automatically recoverable) | Wanted files removed with no undo | `whatIf` defaults to `yes` (report-only); operators must explicitly set `no`; always preview and review the `WouldDelete` list first |
| **Un-patched script** (no `-ReportOnly`) | `whatIf='yes'` hits a blocking `Read-Host` prompt under vRO | Deploy/verify the updated `cvs_functions.ps1` (change S-1) before use |
| **Second-hop authentication** (PS host → `\\fileshare`) | Cleanup fails access-denied if the credential cannot reach the share | Host auth must carry the credential (Kerberos + constrained delegation, or Basic-over-HTTPS); validate write/delete access before go-live |
| **Certificate trust & lifecycle** | Host registration fails on untrusted cert; expiry breaks connectivity | Import cert to the Orchestrator trust store; track expiry (see shared PS-Host guide) |

---

## High-level approach

1. Build/register the PS host and deploy the updated `cvs_functions.ps1` (shared
   setup — see the "How to Build a PowerShell Host" guide and Change-Register).
2. Create the `WindowsLogManagement-Config` Configuration Element and bind its two
   attributes to the `scriptPath` and `olderThanDays` inputs.
3. Import the `buildRemoveFilesInvocation` action and build the workflow schema.
4. Validate report-only mode, then a scoped live delete, via the custom form.

**Recommendation:** operate in the report-only → review → live-delete sequence on
every run until the scope is trusted, then optionally schedule live runs.
