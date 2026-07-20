# Executive Summary — Server Reboot Automation

## Business objective

Replace the Ansible `servers_reboot.yml` playbook with a VCF Orchestrator workflow
that reboots Windows servers **which are reporting a pending reboot** — the members
of a designated Active Directory security group — one at a time, on a schedule,
and produces an auditable per-server report. The automation supports **both
physical and virtual servers** because every operation is OS-level (no hypervisor dependency).

## Scope

- One workflow that resolves an AD group, checks each member's pending-reboot
  state, reboots only those that need it, confirms each one returns to service, and
  emails an HTML report.
- Reuse of the proven `cvs_functions.ps1` PowerShell toolbox already deployed on the
  customer's PowerShell (PS) host, invoked through Orchestrator's PowerShell
  plug-in. Orchestrator passes inputs and classifies the result; all resolution,
  looping, timing, and reporting run inside the script.
- Intended to run **on a schedule that always attempts reboots** (report-only is
  available but is not the operating mode).

Out of scope: patch installation, reboot of servers not in the target group, and
reboot of hosts not reachable over WinRM/RPC from the PS host.

## What makes a server get rebooted (at a glance)

A server is rebooted on a scheduled run only when **all** of the following are true.
This is documented in full in the Design Document and User Guide.

1. It is a **direct, enabled computer member** of the target AD group (nested groups
   and disabled accounts are excluded).
2. It reports a **pending reboot** — detected via Windows Component Based Servicing,
   Windows Update, or the SCCM/ConfigMgr client.
3. The workflow run is in reboot mode (`simpleMode`) — which the schedule always sets.

Servers whose pending state cannot be read are **skipped, never rebooted**.

## Key improvements over the Ansible automation

| Area | Ansible (before) | Orchestrator (now) |
|---|---|---|
| **Reboot confirmation** | None — fire-and-forget | Each server is verified back online (its `LastBootUpTime` must advance) within a timeout, else reported failed |
| **Reporting** | The reboot action produced no report or email | Per-server HTML report (status, timing, reason) emailed to a recipient list |
| **Unreachable servers** | Were **force-rebooted** even when their state couldn't be read | **Skipped and reported** — never rebooted blind |
| **Failed reboots** | Silently looked successful (`shutdown.exe` errors were swallowed) | Detected via exit code and reported as failures |
| **Targeting** | Unfiltered group membership | Direct, enabled, computer objects only |
| **Pre-reboot script** | Ran unconditionally (and, due to a latent bug, never actually executed) | Explicit opt-in, **off by default**, pending security review |
| **Execution** | Script copied to a host every run over WinRM | Pre-staged script invoked centrally through the PS host plug-in |
| **Auditability** | Ansible job log | Orchestrator run history + structured end states + emailed report |

Several of these were **pre-existing defects** in the current automation that the
transition uncovered and fixed (details in the Change Register): the pre-reboot step
never ran, unreachable servers were force-rebooted, and failed reboots were invisible.

## Benefits

- **Safer:** never reboots a server it could not first interrogate; never hard-boots, which can result in data corruption.
- **Verifiable:** every reboot is confirmed, so a server that fails to return is
  surfaced instead of assumed healthy.
- **Auditable:** a report per run showing the status of each server during the run, plus Orchestrator history.
- **Lower operational overhead:** scheduled, centralized, no per-run script staging.
- **Consistent:** one workflow for physical and virtual servers alike.

## Key risks / decisions

- **Optional pre-reboot script (`ownership_w2k.ps1`) is security-sensitive.** It
  weakens USB-storage and Terminal-Services file protections. It is **disabled by
  default** and should only be enabled after security review (or retired).
- **Scheduled runs reboot automatically.** Membership of the target AD group is the
  control surface: adding a server makes it eligible; removing or disabling it makes
  it ineligible. This must be understood by whoever manages the group.
- **Environment rebinding required on import** (PS host, AD domain, script path,
  mail settings) — see the Implementation Guide.

## Status

Code complete and validated in the lab (report-only and simulated pending-reboot
runs pass end-to-end). The two workflow-hardening items flagged during build — the
`parseScriptOutput` module-name typo and terminating-error handling — are **resolved
in the current workflow**. Outstanding before production: environment rebinding (PS
host, domain, script path, mail), the `ownership_w2k.ps1` security decision, and one
optional refinement (a *Bad Inputs* end state on the build action — see Design
Document §"Known limitations").
