# Executive Summary — Server Reboot Report (vRO)

## Objective
Replace the Ansible-driven "servers pending-reboot report" with a VCF Orchestrator
(vRO) workflow that produces the same operational output — an HTML report of which
Windows servers in an AD security group have a pending reboot — with no dependency
on the Ansible control node.

## Scope
**In scope**
- One vRO workflow, **Get Server Reboot Report**, that runs the
  `cvs_functions.ps1` script, `Get-ServerRebootReportStatus-ByCN` function on a PowerShell host.
- Consolidation of the **two** legacy Ansible report variants (lab `-SecurityGroup_CN`
  and production `-ADGroupMember`) onto **one** hardened, recursive resolver.
- Optional emailed HTML report.

**Out of scope**
- Rebooting servers. This workflow is **read-only** — it never issues a reboot. The
  separate **Invoke-ServerReboot** workflow owns that.
- Changes to the pending-reboot detection logic itself (unchanged from the script).

## Key benefits
- **No Ansible dependency** — runs entirely from vRO against a PowerShell host.
- **More complete, cleaner results** — the recursive ByCN resolver expands nested AD
  groups and skips disabled / non-computer objects, so production reporting no longer
  silently misses servers or emits noise rows.
- **Safe by design** — read-only; no reboot path exists to misfire.
- **Traceable** — each run stamps a `Workflow:<name>-WorkflowRunId:<run id>` marker on
  every log line.

## Key risks
- **Behaviour change for production** — the customer's former `-ADGroupMember` report
  was non-recursive and unfiltered; moving to ByCN changes the reported set (see
  Design Document and Change-Register R-1). Strict improvement for a report, but it
  must be reviewed.
- **PowerShell host script must be current** — the emailed report depends on the
  optional-CC fix in `cvs_functions.ps1` (Change-Register R-2). An out-of-date host
  script breaks emailed reports.
- **Domain-specific values** — the script hardcodes a mail domain; it must match the
  deployment environment (Implementation Guide).

## High-level approach
1. A vRO action builds the PowerShell invocation string (validated inputs, derived
   report header, recipient normalization).
2. The OOTB **Invoke a PowerShell script** workflow runs it on a pre-bound PS host.
3. A shared **parseScriptOutput** action classifies the transcript into
   success / completed-with-errors / failure end states.
