# Windows Archive Log Management — Executive Summary

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Draft — Phase 1 (delivery replacement)
**Companion documents:** Design Document · Implementation Guide · User Guide · Change-Register.md

---

## Objective

Replace the retiring Ansible automation that manages Windows event-log archives
with an equivalent, supported solution on VCF Orchestrator 9 — **reusing the
proven PowerShell logic** rather than rewriting it.

Business outcome: automated offload and retention of Windows `Archive-*.evtx`
logs continues uninterrupted after Ansible is decommissioned, on a platform the
customer already owns and operates, with reduced tooling sprawl.

---

## Scope

**In scope**
- Two Orchestrator workflows:
  - **Move-ArchivedLogs-ByADGroup** — move archived logs off every enabled server
    in an AD group to a central archive share (per-server subfolder).
  - **Remove-OldFiles-UNCShare** — delete files on the archive share older than a
    retention threshold (with a safe report-only default).
- Reuse of the existing `cvs_functions.ps1` PowerShell toolbox on a dedicated
  PowerShell (PS) host.
- PS host build and registration in Orchestrator (WinRM over HTTPS).

**Out of scope**
- Per-server status reporting inside Orchestrator (Phase 2).
- Email reporting on completion (Phase 2).
- Broader refactor/optimization of `cvs_functions.ps1`.
- Provisioning of the archive file share and AD groups (customer prerequisites).

---

## Key benefits

- **Consolidation:** 7 Ansible playbooks → **2 workflows**; three AD-targeting
  variants → **one** recursive, enabled-only method.
- **Operator-driven and parameterized:** domain, group (DN), script path, file
  share target, file filter, and file age are all workflow inputs.
- **Resilient by design:** disabled servers are skipped and logged; an
  unreachable server is logged and skipped while the remaining moves continue;
  only a failure that would break **every** move fails the run.
- **Standardized:** one code path for all hosts — the PS host itself is handled
  as an ordinary AD-group member, eliminating the former "local execution"
  special case.

---

## Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Second-hop authentication** (PS host → remote `\\server\C$` and `\\fileshare`) | Move fails with access-denied if the credential cannot be delegated | Use Kerberos + constrained delegation (production) or Basic-over-HTTPS (lab); **validate the hop before go-live** (Implementation Guide) |
| **Kerberos config on containerized Orchestrator** | `Add a PowerShell host` fails until `krb5.conf` is placed correctly | Documented procedure; confirmed to persist on the Orchestrator's PVC-backed volume |
| **Script version drift** | Workflow behavior depends on the updated `cvs_functions.ps1` (changes S-1…S-5) | Deploy/verify the updated script as the first implementation step |
| **Self-signed certificate trust & lifecycle** | Host registration fails on untrusted cert; expiry breaks connectivity | Import cert to Orchestrator trust store; track expiry (default 5-year self-signed) |

---

## High-level approach

1. Build/configure the PS host (RSAT AD tools, WinRM HTTPS listener on 5986,
   authentication, certificate) using the provided `Configure-vROPSHost.ps1`.
2. Deploy the updated `cvs_functions.ps1` to the PS host.
3. Register the PS host in Orchestrator and import the actions, workflows, and
   Configuration Element.
4. Validate end to end — including the second-hop file access — then operate via
   the workflow custom forms (on demand or scheduled).

**Recommendation:** proceed in a lab with Basic-over-HTTPS to validate the full
workflow quickly, and adopt Kerberos + constrained delegation as the
production-hardening step. The decision does not change the workflow design.
