# Executive Summary — Windows Server Clean Disks

## Business objective

Replace the Ansible `servers_diskclean.yml` playbook with a VCF Orchestrator
workflow that frees disk space on the Windows servers in a designated Active
Directory security group — deleting aged files (and, optionally, folders) from one
or more target directories (by default the SCCM download cache
`c:\Windows\ccmcache`). The workflow defaults to a **safe report-only preview** and
deletes only when explicitly told to.

## Scope

- One workflow (`Clean-ServerDisks-ByADGroup`) that resolves an AD group to its
  **direct, enabled computer members**, and for each server deletes items older than
  a chosen age from one or more target folders — with a report-only safety gate.
- Reuse of the proven `cvs_functions.ps1` PowerShell toolbox already deployed on the
  customer's PowerShell (PS) host, invoked through Orchestrator's PowerShell plug-in.
  Orchestrator passes inputs and classifies the result; all AD resolution, per-server
  iteration, filtering, and deletion run inside the script.
- Covers **both** production use cases that ran under the single `clean-ServerDisk`
  action: the six **cache-cleanup** templates (`c:\Windows\ccmcache`) and the two
  **user-profile cleanup** templates (`c:\users`) — the same action with different
  inputs.

Out of scope: cleanup of paths not supplied to the workflow, servers not in the
target group, and hosts not reachable over the `\\server\C$` admin share from the PS
host. The workflow **empties** target folders; it never deletes the target folder
itself.

## What gets deleted (at a glance)

On a live run, an item under a target folder is deleted only when **all** of the
following are true (documented in full in the Design Document and User Guide):

1. Its server is a **direct, enabled computer member** of the target AD group
   (nested groups, disabled accounts, and non-computer objects are excluded).
2. Its **last-modified time is older than** the chosen `olderThanDays` threshold.
3. It is **not** on the intentional-preservation list (e.g. the hardcoded
   `vmware-vmsvc-SYSTEM.log` exclusion; hidden/system files; read-only files when
   `forceEnable` is off).
4. The run is a **live** run (`whatIf = no`). The default (`whatIf = yes`) reports
   what would be deleted and deletes nothing.

## Key improvements over the Ansible automation

| Area | Ansible (before) | Orchestrator (now) |
|---|---|---|
| **Safety preview** | None — the action always deleted | `whatIf` report-only mode (the **default**) lists what *would* be deleted and deletes nothing |
| **Targeting** | Unfiltered group membership (users and disabled accounts included) | Direct, enabled, **computer** objects only (disabled skipped and logged) |
| **Unreachable server** | Silent non-terminating error — the run looked clean | Terminating, **logged** `Error:`; the per-server loop continues; run ends *Completed with Errors* |
| **Age input** | Negative value (`-1`) fed to `AddDays()` | Intuitive **positive** `olderThanDays` ("delete items older than N days") |
| **File filter** | Free-text, easy to misuse | Fixed to `*.*` (matches all files **and** folders) so folder deletion works as expected |
| **Failure isolation** | One failure could stop the run | Per-server and per-item isolation; failures logged, others still processed |
| **Execution** | Script copied to a host every run over WinRM | Pre-staged script invoked centrally through the PS host plug-in |
| **Auditability** | Ansible job log | Orchestrator run history + structured end states + full transcript |

Several of these were **pre-existing weaknesses** in the current automation that the
transition uncovered and fixed (details in the Change Register): silent failures on
unreachable servers, no dry-run, and unfiltered targeting.

## Benefits

- **Safer:** report-only by default; a destructive live run is a deliberate choice.
- **Predictable:** only direct, enabled computers are touched; disabled/decommissioned
  and non-computer objects are excluded and logged.
- **Auditable:** a full per-server, per-item transcript in Orchestrator history; a
  clear *Completed with Errors* outcome when any server or item fails.
- **Lower operational overhead:** scheduled or on-demand, centralized, no per-run
  script staging.
- **Intuitive:** operators enter a positive "older than N days" value and a plain
  yes/no safety gate.

## Key risks / decisions

- **This automation deletes files.** The `whatIf` gate is the primary control and
  defaults to report-only; a live run requires `whatIf = no`. The build action logs a
  loud warning on any live run.
- **`forceEnable` is a read-only switch only.** It deletes read-only files but does
  **not** delete hidden/system files (matching the original script). Full behavior and
  the complete list of intentionally-preserved items are in the Design Document.
- **The `vmware-vmsvc-SYSTEM.log` exclusion is hardcoded** in the script and
  **case-sensitive** — it cannot be turned off from the form.
- **Membership of the target AD group is the control surface.** Adding a server makes
  it eligible; removing or disabling it makes it ineligible.
- **Environment rebinding required on import** (PS host, AD domain, script path,
  target folders) — see the Implementation Guide.

## Status

Code complete and validated in the lab against the shared `cvs_functions.ps1`
(report-only, live-delete, per-server isolation, age boundary, and preservation
rules all confirmed). Script changes **S-14 / S-15** and workflow-design decisions
**P-14 … P-19** are recorded in the Change Register. Outstanding before production:
environment rebinding (PS host, domain, script path, target folders), building the
workflow with its custom form and the fixed `fileFilter` attribute, and exporting the
`com.broadcom.pso…diskcleanup` package.
