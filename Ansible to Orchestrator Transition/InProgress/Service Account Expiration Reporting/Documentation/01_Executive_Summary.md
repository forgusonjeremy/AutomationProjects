# Executive Summary — Service Account Expiration Reporting

## Business objective

Replace the Ansible service-account reporting job template with a VCF Orchestrator
workflow that reports **which service accounts have expired, and which expire within a
configurable look-ahead window**, across every organisational unit in a supplied scope.

The output is an HTML report, emailed to the operations distribution list, leading with
the accounts that need action and carrying the expired / expiring counts in the subject
line.

## The existing report is materially incomplete — read this first

This transition is not a like-for-like port. Four defects were found in the current
automation, and **three of them mean the report the customer receives today is not the
report they believe they are receiving**. All four were silent: the run reported success
every time.

| # | Defect | Consequence |
|---|---|---|
| 1 | An omitted parameter caused every run to query only accounts **not** requiring a smart card | **Any service account requiring a smart card has been missing from every report ever produced.** Nothing in the output indicated a filter was applied |
| 2 | The expiration date was queried but **never rendered** on the report | A report titled "Service Account Expiration" that showed password age and no expiry date — the one fact it exists to convey was absent |
| 3 | A password that had **never been set** was reported as an age of `0` | The accounts most in need of attention rendered identically to the healthiest ones, and sorted to the bottom of the list |
| 4 | An unassigned variable was appended to the result set | A blank row on every report |

**Expect the account count to rise on the first run.** That is defect 1 being corrected —
previously invisible accounts becoming visible — not a change of scope. See *Key risks*.

## Scope

**In scope**

- One workflow (`Get-ServiceAccountExpirationReport`) replacing the single
  `service_accounts_report.yml` job template.
- Reuse of the proven `cvs_functions.ps1` PowerShell toolbox via Orchestrator's
  PowerShell plug-in. Orchestrator supplies the scope and classifies the result; all
  Active Directory querying, the expiry classification and the report/mail happen inside
  the script.
- Correction of the four defects above, and adoption of the multi-domain, per-OU
  failure-isolated query path already proven by the Admin Accounts Report deliverable.
- A new **look-ahead window** so the report distinguishes "expiring soon" from "expired"
  and says so in the subject line.

**Out of scope**

- Accounts outside the supplied OUs. The report is only as complete as its OU list.
- Any modification of Active Directory. This workflow is **strictly read-only** — it does
  not renew, extend, disable or delete any account it reports on.
- **Password expiry.** The report shows how old a password is, not when it expires. It
  does not read the domain password policy. See *Open items*.

## The action is read-only

The workflow issues `Get-ADUser` queries and sends an email. It cannot create, modify,
disable or delete any directory object. There is consequently no "what-if"/preview gate —
there is nothing to gate.

## Key benefits

| | |
|---|---|
| **The report finally reports expiration** | An `Expires on` and a `Days to expiry` column, which the previous report never rendered at all. |
| **Complete scope** | Accounts requiring a smart card are no longer silently excluded. |
| **Actionable at a glance** | Expired and expiring accounts are lifted **above** the inventory, worst first, and the subject line carries the counts — a scheduled report can be triaged from the inbox without opening it. |
| **A trustworthy empty report** | "Nothing is expiring" and "the query never ran" are now distinguishable. Previously they looked identical. |
| **Failures are visible to the people who act on them** | An OU that cannot be read is reported **on the report itself** — banner, per-OU flag, and an `[INCOMPLETE]` subject prefix — not just in the Orchestrator log. |
| **Failures are explained, not just reported** | Each failure is classified (scope error / unreachable / access denied / authentication) with guidance on who fixes it. |
| **Correct password-hygiene signal** | A password that was never set now reads "Never set", in red, at the top of its group — not as an age of zero at the bottom. |
| **Scales without rework** | Scope is a list of OU distinguishedNames with the domain derived from each. Today's single OU is a list of one; adding OUs or domains later needs no change to the workflow. |

## Key risks

| Risk | Mitigation |
|---|---|
| **The account count will RISE on the first run**, and may rise substantially. | Expected — defect 1 is being corrected. Brief recipients before the first scheduled send so the increase is not read as a scope expansion or a directory change. |
| **The report is only as complete as its OU list.** A service account outside the supplied OUs is not reported. | The scope is listed in full on every report. Confirm the OU list against the directory during validation. |
| **"Service account" means "any user object in a service-account OU"** — there is no filter for account type or naming convention. | Documented in the Design Document and User Guide. Confirm the OU list genuinely contains what the customer means by service accounts. |
| **Password age is not password expiry.** A 400-day-old password may be entirely compliant under a policy that does not expire service accounts. | Stated on the report and in the User Guide. Computing true password expiry is an open item. |
| **Subject-line inbox rules will stop matching.** The subject now carries counts and an `[INCOMPLETE]` prefix on degraded runs. | Review any Outlook rule matching the old subject before the first scheduled send. |
| Report format changes substantially from the current Ansible output. | Brief recipients beforehand. Four rendered samples are available for review without a lab. |
| A window shorter than the schedule interval would let an account expire unwarned. | Documented; the default (30 days) suits a monthly or weekly schedule. Validation includes a check that the two are matched. |

## High-level approach

1. Operator (or a schedule) supplies a list of OU distinguishedNames, a look-ahead
   window and mail settings.
2. An Orchestrator action groups the OUs by domain — **derived from each DN itself** —
   validates the inputs, and builds the PowerShell invocation.
3. The OOTB *Invoke a PowerShell script* workflow runs it on a pre-bound PowerShell host.
4. The script queries every OU, classifies each account's expiry, de-duplicates, builds
   the report and emails it.
5. Orchestrator classifies the transcript and routes to a success or
   completed-with-errors end state.

**Deployment is independent.** Orchestrator and the existing Ansible automation use
**separate PowerShell hosts in both development and production**. Deploying this solution
cannot affect any running Ansible job, so there is no cross-team deployment sequencing to
coordinate.

## Assurance

256 automated checks run offline — no Active Directory, SMTP, PowerShell host or
Orchestrator appliance required — covering the invocation building, the escaping boundary
between JavaScript and PowerShell, the expiry classification, the report rendering, and
the workflow's own scriptable-task code. These are a delivery gate, not a one-off: they
load the functions under test out of the live files, so they cannot drift from shipping
code.

Twenty-one of those checks assert against the **shipping source** rather than behaviour.
This is deliberate: reintroducing defect 1 would silently narrow the report again, and
every behavioural test would still pass, because none of them supplies the input that
would expose it.

Directory querying, mail delivery and Outlook rendering require the lab and are covered by
the Validation & Testing Plan.

## Open items requiring customer decision

| Item | Decision needed |
|---|---|
| **Password expiry vs password age** | The report shows how old a password is, not when it expires. Computing true expiry means reading the domain's maximum password age (and any Fine-Grained Password Policy) and honouring `PasswordNeverExpires` — a more useful metric, and a new query per domain. Not implemented. |
| **Expected-expiry exemptions** | An account deliberately scheduled to expire — a contractor integration, a time-boxed migration account — is reported as Expiring on every run until it does. There is no allow-list. Options: an exemption input, a `Description` convention, or accept the recurring noise. |
| **Is the OU list complete?** | The report finds user objects in the OUs supplied. If service accounts exist elsewhere in the directory, they are invisible to it. Confirm during validation. |

None blocks deployment; all three affect how the report reads in production.
