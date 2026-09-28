# Executive Summary — Server Reboot Automation

## Business objective

Replace the Ansible `servers_reboot.yml` playbook with a VCF Orchestrator workflow,
**`Reboot Servers in AD Group`**, that reboots Windows servers **which are reporting a
pending reboot** — the direct members of a designated Active Directory group — one at
a time, on a schedule, and produces an auditable per-server report. The automation
supports **both physical and virtual servers** because every operation is OS-level
(no hypervisor dependency).

## Scope

- One workflow that resolves an AD group, checks each member's pending-reboot state,
  reboots only those that need it, confirms each one returns to service, and reports
  the outcome per server — in the run log every time, and by email when requested.
- **Orchestrator works out which servers to process** using its Active Directory
  plug-in. **A purpose-built PowerShell script** (`Invoke-ServerReboot.ps1`), held in
  Orchestrator and copied to the PowerShell host only for the duration of each run,
  does the checking, rebooting and verification.
- Intended to run **on a schedule that always attempts reboots**. A Report Only mode
  is available for dry runs.

Out of scope: patch installation, rebooting servers not directly in the target group,
and rebooting servers the PowerShell host cannot reach over RPC/WMI.

## What makes a server get rebooted (at a glance)

A server is rebooted only when **all** of the following are true:

1. It is a **direct, enabled computer member** of the target AD group. Nested groups
   and disabled accounts are excluded, and any nested group is named in the run log.
2. It reports a **pending reboot** — detected via Windows Component Based Servicing,
   Windows Update, or the SCCM/ConfigMgr client.
3. The run is in **Reboot** mode — which the schedule always sets.

Servers whose pending state cannot be read are **skipped, never rebooted**.

## Key improvements over the Ansible automation

| Area | Ansible (before) | Orchestrator (now) |
|---|---|---|
| **Reboot confirmation** | None — fire-and-forget | Each server verified back online (its boot time must advance) within 10 minutes, else reported |
| **Reporting** | No report or email | Per-server outcome in every run log; HTML report emailed on request; counts returned to the caller |
| **Unreachable servers** | **Force-rebooted** even when their state couldn't be read | **Skipped and reported** — never rebooted blind |
| **Failed reboots** | Silently looked successful | Detected and reported |
| **Targeting** | Unfiltered group membership | Direct, enabled computer accounts only |
| **Pre-reboot script** | Ran unconditionally (and, due to a latent bug, never actually executed) | Explicit opt-in, **off by default**, pending security review |
| **Script delivery** | Copied to a host every run by Ansible | Held and versioned in Orchestrator; copied for the run and removed afterwards — no stale copies |
| **Wrong group picked** | Looked like a clean run | Run stops and says the group has no direct computer members |
| **Auditability** | Ansible job log | Orchestrator run history, structured outputs, emailed report |

Several of these were **pre-existing defects** in the current automation that the
transition uncovered and fixed (details in the Change Register): the pre-reboot step
never ran, unreachable servers were force-rebooted, and failed reboots were invisible.

## Benefits

- **Safer:** never reboots a server it could not first interrogate; never hard-boots.
- **Verifiable:** every reboot is confirmed, so a server that fails to return is
  surfaced instead of assumed healthy.
- **Auditable:** a per-server account of every run, plus Orchestrator history.
- **Lower overhead:** scheduled and centralized; nothing to stage or maintain on the
  PowerShell host.
- **Consistent:** one workflow for physical and virtual servers alike.

## Key risks / decisions

- **Scheduled runs reboot automatically.** Direct membership of the target AD group is
  the control surface: adding a computer account makes it eligible; removing or
  disabling it makes it ineligible. Whoever manages the group must understand this.
- **Optional pre-reboot step is security-sensitive.** It weakens USB-storage and
  Terminal Services file protections. It is **off by default** and should only be
  enabled after security review — or retired.
- **Run length vs. connection timeout.** Each run is one continuous PowerShell session
  (about 14 minutes for 20 pending servers). The PowerShell host's timeout must be
  sized to the largest group.
- **Environment rebinding on import** — PowerShell host, script element and AD
  endpoints (see the Implementation Guide).

## Status

Built and running in the lab on VCF Automation 9.1.1. Report Only and live reboot runs
have completed end to end, including verification of servers returning to service.
Defects found on the first live run (unnecessary delay after the last server;
overstated return times) are fixed. Outstanding before production: environment
rebinding, WinRM timeout sizing, and the security decision on the pre-reboot step.
