# Executive Summary — Datastore Capacity Reporting

**Project:** Ansible → VCF Orchestrator transition — "Get Datastores Greater than 75 Percent Used"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Date:** 2026-08-10
**Status:** Built and unit-validated; pending lab validation and parallel run

---

## Objective

Move the scheduled datastore capacity report off Ansible and onto VCF Operations
Orchestrator, and correct the defects that have been silently limiting what that
report shows.

The report tells the storage and infrastructure teams which datastores across the
five-vCenter estate are approaching full, early enough to act. Its value depends
entirely on being complete and on arriving. Neither has been reliably true.

---

## Scope

**In scope**

- One Ansible job template (`get_datastores_75_100_used.yml`) replaced by one
  Orchestrator workflow, **Get Datastore Capacity Report**.
- Package `com.broadcom.pso.vc.storage.reporting` — one workflow, two actions.
- Documentation set, change register, and an offline test harness with 112 assertions.

**Out of scope**

- Any change to `cvs_functions.ps1`. This deliverable removes the PowerShell host
  from the execution path rather than re-pointing it, so the shared script is not
  touched — see *Key risks*, item 3.
- Remediation. The workflow reports; it does not move, expand or clean up anything.
- Datastore performance or latency reporting, which is delivered separately by the
  Snapshot Cleanup package.

---

## High-level approach

The workflow is **vCenter-native**. It reads datastore capacity directly through the
Orchestrator vCenter plug-in — the second project in this programme, after Snapshot
Cleanup, to require no PowerShell host at all.

Retired outright: the WinRM session to a Windows host, the staging and execution of
`cvs_functions.ps1` on it, the PowerCLI dependency, the second set of vCenter
credentials held outside Orchestrator, `Send-MailMessage`, and the hardcoded list of
vCenter hostnames.

Each vCenter is swept independently, results are banded into three contiguous
severity ranges, and a styled HTML report is emailed through the Orchestrator Mail
plug-in.

---

## Key benefits

| Benefit | Detail |
|---|---|
| **The report becomes complete** | A datastore that is nearly full but not overcommitted has never appeared on this report. It now does. This is the single most consequential change in the project. |
| **The report arrives** | One unreachable vCenter, or one decommissioned datastore anywhere in the estate, currently ends the run and sends **nothing**. Both are now isolated; the report is delivered with the gap declared on its face. |
| **Attack surface and maintenance reduced** | No Windows host, no PowerCLI to keep current, no WinRM listener, no Kerberos second hop, and no vCenter credential stored outside Orchestrator, in the path of this report. |
| **The vCenter list maintains itself** | The estate is read from the vCenters registered in Orchestrator. A newly commissioned vCenter cannot be missed because someone forgot to edit a string. |
| **The subject line stops misleading** | It carries all three severity counts and states plainly when the underlying scan was incomplete. |

---

## Key risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **The report will get noticeably longer.** Three separate fixes each restore rows that were previously invisible; in the lab fixtures the row count rises four-fold. Recipients may read this as a sudden deterioration in the estate. | Brief the distribution list before the first scheduled send. The Change Register §6 gives the wording and the comparison method. **This is the primary go-live action.** |
| 2 | **Comparison against the old report will not tie out.** The counts are expected to differ substantially. | Compare *membership*, not counts. The correct result is that the new report is a strict superset of the old one — enforced as test T-23 and re-checked in production during the parallel run. |
| 3 | **The Ansible path keeps its defects until retired.** This deliverable does not fix `cvs_functions.ps1`. | Accepted deliberately: the script is being taken out of the path entirely. Keep the parallel-run overlap short and do not treat the Ansible output as the reference. |
| 4 | **Delivery moves from the Windows host to the Orchestrator appliance.** The SMTP relay must accept submission from a new source. | Verified as a deployment step before the first scheduled run. |
| 5 | **Two configuration values are ambiguous in the source.** The script sets the top threshold to 90 with a comment saying it should be 95; the process is named for 75% but the floor is 70%. | Both preserved as-is and exposed as workflow inputs. Flagged for customer decision — Change Register §1B. |

---

## Defects found in the customer's existing automation

Six, all silent, all affecting the report as it runs today independently of this
transition. Four of them mean the report being received is not the report the
recipients believe they are receiving.

| Defect | Real-world effect today |
|---|---|
| Collection requires uncommitted space to exceed free space | **A datastore at 99% used is not reported unless it is also overcommitted** |
| No `try`/`catch` around `Connect-VIServer` | **One unreachable vCenter out of five ends the run and emails nothing at all** |
| No divide-by-zero guard on datastore capacity | **One decommissioned datastore anywhere in the estate ends the run the same way** |
| `Sort-Object -Property Datastore -Unique` de-duplicates on **name** | **Identically named datastores on different vCenters are silently discarded** |
| Band comparisons leave gaps | **A datastore at exactly 90.00%, 89.99%, 80.00% or 70.00% is shown nowhere** |
| Mail subject counts the top band only | A subject reading **"0 Datastores @ 90%"** while fifty sit at 89% |

Full detail, including why each is silent, is in **Change-Register.md §1A**.

---

## Status and next steps

| Step | State |
|---|---|
| Workflow, actions and exception handling built | Complete |
| Offline test harness — 112 assertions, 23 scenarios | Complete, passing |
| Documentation set and change register | Complete |
| Package import and lab validation against real vCenters | **Pending** |
| Recipient briefing | **Pending — required before first scheduled send** |
| Parallel run against the Ansible report | **Pending** |
| Ansible job template retirement | Pending parallel-run sign-off |
