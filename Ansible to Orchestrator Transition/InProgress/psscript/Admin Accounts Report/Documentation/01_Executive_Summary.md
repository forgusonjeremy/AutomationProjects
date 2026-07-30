# Executive Summary — Admin Accounts Report

## Business objective

Replace the Ansible admin-account reporting job templates with a single VCF
Orchestrator workflow that reports which **privileged ("admin") accounts do not
require a smart card to log on** — i.e. which privileged accounts sit outside PKI
enforcement — across every domain and organisational unit in a supplied scope.

The output is an HTML report, emailed to the compliance distribution list, with the
compliant / non-compliant counts in the subject line.

## Scope

**In scope**

- One workflow (`Get-AdminAccountsReport`) replacing **three** Ansible job templates:
  two multi-domain and one single-OU. Scope differences are now expressed purely as
  the contents of one input list, not as different templates.
- Reuse of the proven `cvs_functions.ps1` PowerShell toolbox via Orchestrator's
  PowerShell plug-in. Orchestrator supplies the scope and classifies the result; all
  Active Directory querying, the compliance split, the counts and the report/mail
  happen inside the script.
- Consolidation of a divergent second copy of that toolbox (`cvs_functions-v2.ps1`)
  back into the single shared script.

**Out of scope**

- Accounts outside the supplied OUs. The report is only as complete as its OU list.
- Any modification of Active Directory. This workflow is **strictly read-only**.
- The `Set-L3-Admin-Accounts` capability in the same script, which *writes* the
  smart-card attribute in bulk. It is deliberately **not exposed** by this package.

## The action is read-only

The workflow issues `Get-ADUser` queries and sends an email. It cannot create,
modify, disable or delete any directory object. There is consequently no
"what-if"/preview gate — there is nothing to gate.

## Key benefits

| | |
|---|---|
| **Three templates become one** | Single- and multi-domain reporting were never different operations, only different scopes. One workflow, one report format, one place to change behaviour. |
| **Failures are visible to the people who act on them** | An OU that cannot be read is reported **on the report itself** — banner, per-OU flag, and an `[INCOMPLETE]` subject prefix — not just in the Orchestrator log. |
| **Failures are explained, not just reported** | Each failure is classified (scope error / unreachable / access denied / authentication) with guidance on who fixes it. A referral and a dead domain controller are different problems with different responses. |
| **Management-readable output** | Executive summary, per-domain status, then per-OU detail — answering "which domain and OU are worst?" without reading the whole table. |
| **Counts can be trusted** | Overlapping OU entries no longer inflate the figures; each account is counted exactly once. |
| **One shared script again** | The divergent fork is retired, ending the risk of fixes landing in only one copy. |

## Key risks

| Risk | Mitigation |
|---|---|
| **The report is only as complete as its OU list.** A privileged account outside the supplied OUs is not reported and not counted. | The scope is listed in full on every report. Confirm the OU list against the directory during validation. |
| **"Admin account" means "any user object in an admin OU"** — there is no privilege or group filter. Service accounts in those OUs are counted. | Documented in the Design Document and User Guide. See open items below. |
| **Disabled accounts are included in the non-compliance figure.** | Confirmed as the customer's intended metric. An **Account state** column now makes the composition visible without changing the number. |
| A partial sweep could previously be mistaken for a clean run. | Fixed. An unreadable OU now produces an error line, an `[INCOMPLETE]` subject and an on-report banner; the run ends *Completed with Errors*. |
| Report format changes from the current Ansible output. | Brief recipients before the first scheduled run. Rendered samples are available for review. |
| First run after deployment may show **lower** counts than the Ansible report. | Expected if the OU list overlaps — it is the de-duplication correcting an inflated figure, not a regression. Verify during validation and explain before cutover. |

## High-level approach

1. Operator (or a schedule) supplies a list of OU distinguishedNames and mail settings.
2. An Orchestrator action groups the OUs by domain — **derived from each DN itself** —
   and builds the PowerShell invocation.
3. The OOTB *Invoke a PowerShell script* workflow runs it on a pre-bound PowerShell
   host.
4. The script queries every OU, de-duplicates, builds the report and emails it.
5. Orchestrator classifies the transcript and routes to a success or
   completed-with-errors end state.

**Deployment is independent.** Orchestrator and the existing Ansible automation use
**separate PowerShell hosts in both development and production**. Deploying this
solution cannot affect any running Ansible job, so there is no cross-team deployment
sequencing to coordinate.

## Assurance

191 automated checks run offline — no Active Directory, SMTP, PowerShell host or
Orchestrator appliance required — covering the invocation building, the escaping
boundary between JavaScript and PowerShell, the report rendering, and the workflow's
own scriptable-task code. These are a delivery gate, not a one-off: they load the
functions under test out of the live files, so they cannot drift from shipping code.

Directory querying, mail delivery and Outlook rendering require the lab and are
covered by the Validation & Testing Plan.

## Open items requiring customer decision

| Item | Decision needed |
|---|---|
| **Report wording** | "Not enforced" is placeholder wording. If the customer has established compliance language, the report should adopt it. Labels only; no logic change. |
| **Service-account exemptions** | A service account legitimately exempt from smart-card enforcement is reported as non-compliant on every run. There is no allow-list. Options: an exemption input, a `Description` convention, or accept the recurring noise. Until resolved, expect a persistent non-compliance floor. |

Neither blocks deployment; both affect how the report reads in production.
