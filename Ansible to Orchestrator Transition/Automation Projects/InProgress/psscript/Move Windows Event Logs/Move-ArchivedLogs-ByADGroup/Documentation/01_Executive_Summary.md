# Move Archived Logs (By AD Group) — Executive Summary

**Deliverable:** Move-ArchivedLogs-ByADGroup
**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Status:** Phase 1
**This set:** 01 Executive Summary · 02 Design Document · 03 Implementation Guide · 04 User Guide · 05 Validation & Testing Plan
**Shared references:** ../../_Shared/Documentation/Shared-Components.md · ../../_Shared/Documentation/Change-Register.md · ../../_Shared/Documentation/Ansible-to-vRO-MappingTable.md · "How to Build a PowerShell Host" (Automation Projects/_Shared References/PowerShell Host Build Guide/)

---

## Objective

Replace the retiring Ansible automation that moves Windows event-log archives with one supported VCF Orchestrator workflow — **Move-ArchivedLogs-ByADGroup** — reusing the proven `cvs_functions.ps1` PowerShell logic rather than rewriting it.

Business outcome: automated offload of Windows `Archive-*.evtx` logs continues uninterrupted after Ansible is decommissioned, on a platform the customer already owns.

## Scope

**In scope**
- One Orchestrator workflow: **Move-ArchivedLogs-ByADGroup** — move `Archive-*.evtx` off every **enabled** member of an AD group to a central archive share, into a per-server subfolder.
- The deliverable-specific action **buildMoveByADGroupInvocation**.
- Reuse of shared components on a PowerShell (PS) host: `cvs_functions.ps1`, `parseScriptOutput`, `handlePSFailure`, and the OOTB *Invoke a PowerShell script* workflow (documented in Shared-Components.md).

**Out of scope**
- The archive-share cleanup workflow (a separate deliverable).
- Per-server structured status reporting in Orchestrator (Phase 2).
- Email reporting on completion (Phase 2).
- Broader refactor/optimization of `cvs_functions.ps1`.
- Provisioning of the archive file share and AD groups (customer prerequisites).

## Key benefits

- **Consolidation:** the former local-execution and three near-duplicate AD-targeting variants collapse into **one** recursive, enabled-only method (`Get-ListOfServers-ByCN`).
- **Operator-driven and parameterized:** domain, group (DN), script path, file-share target, file filter, and file age are all workflow inputs, with defaults set directly on each input.
- **Resilient by design:** disabled members are skipped and logged; an enabled-but-unreachable member is logged and skipped while the remaining moves continue; only a failure that would break **every** move fails the run.
- **Standardized:** one code path for all hosts — the PS host itself is handled as an ordinary AD-group member, eliminating the former "local execution" special case.

## Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Second-hop authentication** (PS host → remote `\\server\C$` source and `\\fileshare` destination) | Move fails access-denied if the credential cannot be delegated | Kerberos + constrained delegation (production) or Basic-over-HTTPS (lab); **validate the hop before go-live** (Implementation Guide) |
| **AD "enabled" ≠ host reachable** | An enabled-but-offline computer object (e.g. `disabledsrv01`) is still processed and errors | To exclude a host, `Disable-ADAccount` it or remove it from the group — do not rely on the hostname |
| **RSAT ActiveDirectory module missing** on the PS host | AD resolution fails; run terminates (Failed: PS Execution) | Install RSAT AD tools on the PS host before go-live (see PS-Host guide) |
| **Script version drift** | Behavior depends on the updated `cvs_functions.ps1` (changes S-1…S-5) | Deploy/verify the updated script first (Change-Register, shared) |
| **Certificate trust & Kerberos setup** | Host registration fails on untrusted cert or misconfigured `krb5.conf` | Import cert to Orchestrator trust store; follow the PS-Host guide for Kerberos |

## High-level approach

1. Build/register the PS host (RSAT AD tools, WinRM HTTPS 5986, cert, auth) — shared "How to Build a PowerShell Host" guide.
2. Deploy the updated `cvs_functions.ps1` to the PS host.
3. Import the `buildMoveByADGroupInvocation` action, the shared `parseScriptOutput` action, and build the Move workflow per its `_spec.js`.
4. Validate end to end — including the second-hop file access — then operate via the workflow custom form (on demand or scheduled).

**Recommendation:** validate in a lab with Basic-over-HTTPS first, then adopt Kerberos + constrained delegation as the production-hardening step. The choice does not change the workflow design.
