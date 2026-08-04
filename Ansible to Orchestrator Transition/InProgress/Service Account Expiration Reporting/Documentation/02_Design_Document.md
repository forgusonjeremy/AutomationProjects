# Design Document — Service Account Expiration Reporting

**Workflow:** `Get-ServiceAccountExpirationReport`
**Script action:** `Get-ServiceAccountExpiration` in `cvs_functions.ps1`
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Change Register:** S-22 … S-24, P-27 … P-32

---

## 1. Architecture overview

```
[Operator / Schedule]
        │  domainOUs, expiringWithinDays, mail settings
        ▼
┌──────────────────────────────────────────────────────────────┐
│ VCF Operations Orchestrator 9                                │
│                                                              │
│  Get-ServiceAccountExpirationReport (workflow)               │
│    ├── buildServiceAccountExpirationInvocation (action)      │
│    │     • validates inputs, fails fast on a bad scope       │
│    │     • derives each domain from its own DN               │
│    │     • emits the PowerShell invocation string            │
│    ├── Invoke a PowerShell script (OOTB workflow)  ──────────┼──► [PowerShell host]
│    └── parseScriptOutput (shared action)                     │         │
│          • classifies the transcript → success / errors      │         │
└──────────────────────────────────────────────────────────────┘         │
                                                                          ▼
                                              cvs_functions.ps1 -Action Get-ServiceAccountExpiration
                                                          │
                                          ┌───────────────┼───────────────┐
                                          ▼               ▼               ▼
                                   [Active Directory]  [Debug folder]  [SMTP relay]
                                    Get-ADUser only     HTML copy       HTML report
```

**Division of responsibility.** Orchestrator assembles and validates the scope, invokes,
and classifies the outcome. The PowerShell script does all directory querying, expiry
classification, report construction and mail delivery. Orchestrator never parses account
data — it reads the transcript for `Error:` / `Warn:` prefixes only.

**Separate estates.** The PowerShell host this workflow targets is **not** the host the
Ansible job template runs against, in development or production. Deploying the updated
script cannot disturb the existing Ansible automation, and there is no deployment
sequencing dependency between the two.

---

## 2. Components

| Component | Type | Module / Location |
|---|---|---|
| `Get-ServiceAccountExpirationReport` | vRO workflow | `Production > Identity > Active Directory > Reporting` |
| `buildServiceAccountExpirationInvocation` | vRO action (JavaScript) | `com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry` |
| `parseScriptOutput` | vRO action (shared, **reused**) | `com.broadcom.pso.vcf.vm.guestOps.files.windows.logs` |
| *Invoke a PowerShell script* | OOTB library workflow | vRO library |
| `cvs_functions.ps1` | PowerShell toolbox | PS host script folder (pre-staged) |

### Script functions used

| Function | Role | Introduced |
|---|---|---|
| `Resolve-DomainOUsMap` | Parses the inline JSON scope map; throws on malformed input | S-16 (reused) |
| `Get-ListOfUsers-MultiDomain` | Sweeps every OU in every domain, isolates per-OU failures, tags `SourceDomain` / `SourceOU` | S-16 (reused) |
| `Remove-DuplicateAccounts` | Collapses accounts returned by overlapping OU searches | S-19 (reused) |
| `Get-ADFailureCategory` | Classifies a failed query and supplies remediation guidance | S-20 (reused) |
| `Format-HtmlTable` | Applies inline styling so tables survive Outlook | S-16 (reused) |
| `ConvertFrom-ADFileTime` | Converts `pwdLastSet`, returning `$null` for the sentinels | **S-22 (new)** |
| `Get-AccountExpiryState` | Classifies an account as Expired / Expiring / Active / Never expires | **S-22 (new)** |
| `Sort-ServiceAccountRows` | One worst-first ordering, used by every table | **S-23 (new)** |
| `Get-ServiceAccountSectionNote` | The composition note above each table | **S-23 (new)** |
| `Format-ServiceAccountTable` | One styled account table, used by every section | **S-23 (new)** |
| `GenerateReportServiceAccountExpiration` | Builds and sends the report | **S-23 (rebuilt)** |

**Reuse is deliberate.** Five of the eleven functions come from the Admin Accounts Report
deliverable. Both workflows must run against the **same staged `cvs_functions.ps1`**.

---

## 3. Data flow

1. **Inputs** — `domainOUs` (one OU DN per row), `expiringWithinDays`, `emailReport`,
   `smtpServer`, `mailTo`, `mailCc`, `mailSubject`, `scriptPath`.
2. **Build action** validates every row, derives each domain from the DN's `DC=`
   components, groups rows by domain, encodes the map as JSON and emits the invocation
   string. A malformed row **fails the run here**, before PowerShell is reached.
3. **PowerShell link** executes the invocation on the pre-bound host, merging all output
   streams (`*>&1 | Out-String -Width 4096`) so the transcript is returned intact.
4. **Script** resolves the map, sweeps each OU once with `Get-ADUser -Filter *` at
   `SearchScope Subtree`, de-duplicates, classifies each account's expiry, sets the
   subject line, builds the HTML and sends it.
5. **parseScriptOutput** scans the transcript for `Error:` lines and returns
   `success = true|false`.
6. **Decision** routes to *Log Success* or *Log Failures*, then to the corresponding end
   state.

### Why the scope is passed inline

The Ansible playbook staged files to a temp directory with `win_copy`. Orchestrator
invokes a **pre-staged** script and has no equivalent staging step, so the scope map is
passed **inline** as `-DomainOUs` JSON. The legacy `-DomainOUsFile` path remains in the
script but is not used by this workflow.

Keeping the operator-facing form a **list of DNs** rather than raw JSON means the scope is
reviewable row-by-row in the request form and run history, and a malformed entry is
rejected with a pointed message instead of failing inside PowerShell.

### Why the domain is derived, not supplied

A distinguishedName already contains its domain in its `DC=` components. Asking for the
domain separately would be redundant data entry and — more importantly — something that
can *disagree* with the DN sitting next to it. Deriving it removes that failure mode and
removes the single-domain / multi-domain distinction from the operator's hands entirely.

An override form `<server>|<OU DN>` exists for cross-forest search bases, domain aliases
or targeting a specific DC. It warns when the override disagrees with the DN's own domain.

---

## 4. Expiry classification

Each account is classified from its `AccountExpirationDate` against the look-ahead window:

| State | Meaning |
|---|---|
| **Expired** | The expiration date is in the past. The account can no longer authenticate; anything depending on it has already stopped working, or is about to. |
| **Expiring** | Expires within `expiringWithinDays`. **The actionable set** — the reason the report exists. |
| **Active** | Has an expiration date, beyond the window. |
| **Never expires** | No expiration date is set. The Active Directory default, and **not a finding by itself** — reported as its own state so the reader can see how much of the estate has no expiry at all. |

**The window does not filter the report.** Every account in scope is always listed in the
inventory. The window decides only which accounts are lifted into the *Action required*
section and counted in the subject line. Expired accounts are reported regardless of it.

**The window is inclusive at its edge and rounds toward warning early**: an account 29.6
days away *is* flagged by a 29-day window. Warning one scheduled run late is the failure
mode that matters; warning marginally early is free.

Active Directory's "never" sentinels (dates in 1601 or 9999) are treated as *Never
expires* rather than as a fictitious finding.

---

## 5. Scope semantics — what the report does and does not cover

> Reproduced verbatim from Change Register §2A. These assumptions are **not visible from
> the workflow inputs** and materially affect how the figures should be read.

| # | Behaviour | Detail | Configurable? |
|---|---|---|---|
| 1 | **Scope is the OU list — nothing else** | Only the OUs in `domainOUs` are searched, at `SearchScope Subtree`. A service account outside those OUs is **not reported**. The report is only as good as the OU list. | Yes — via `domainOUs`. |
| 2 | **"Service account" means "in a service account OU"** | The query is `Get-ADUser` over the OU with **no filter** for account type, naming convention or `servicePrincipalName`. Anything that is a user object in those OUs is reported — including a human account someone parked there. | No — inherent to the design. |
| 3 | **"Expiration" means the ACCOUNT expiration date** | The report is built on `AccountExpirationDate` — the date the *account* stops being able to authenticate. It is **not** password expiry. | No — by design. See #4. |
| 4 | **Password age is AGE, not "days until the password expires"** | The password columns show how long ago the password was set. The report does **not** read the domain's maximum password age policy or `PasswordNeverExpires`, so it cannot say when a password will expire. A 400-day-old password may be entirely compliant under a policy that never expires service accounts. **Read the column as a hygiene signal, not a deadline.** | No — not implemented. **Open item.** |
| 5 | **"Never expires" is the AD default, not a finding** | An account with no expiration date is normal. It is reported as its own state so the reader can see how much of the estate has no expiry at all — a service account that never expires also never prompts a review — but it is **not** counted as expired or expiring. | No — by design. |
| 6 | **Disabled and locked-out accounts are included** | A disabled account that has expired **is** counted in the expired figure, and shown with its account state. Preserves the existing metric and makes the composition visible. | No — deliberate. Revisit only as an explicit metric change. |
| 7 | **Unread OUs are excluded from every figure** | A failed OU contributes no rows. The totals are a **floor, not a total** — which is why the report carries the `[INCOMPLETE]` banner and subject prefix. | No — by design. |
| 8 | **Read-only, always** | The action only runs `Get-ADUser`. It cannot renew, extend, disable or delete anything it reports on. There is no `whatIf` gate because there is nothing to gate. | No — by design. |
| 9 | **Searches are FULLY RECURSIVE** | Every AD query uses `-SearchScope Subtree`, which returns the search base **and every descendant at any depth**. Listing one OU covers everything beneath it. Inherited from the original script and preserved. | No — matches original. |
| 10 | **Overlapping OUs are de-duplicated** | A consequence of #9: listing both a parent OU **and** a descendant returns the deeper accounts twice. Each account is counted and listed **exactly once**, under the deepest OU that returned it, with an informational notice. | The de-duplication is automatic. Tidy `domainOUs` to make the notice go away. |
| 11 | **The window does not filter the report** | `expiringWithinDays` decides what is called out and counted, not what is listed. The full inventory is always present. | Yes — via `expiringWithinDays`. |

---

## 6. Failure handling

| Condition | Script behaviour | Workflow end state |
|---|---|---|
| Bad inputs (malformed row, OU without `DC=`, bad recipient, no scope, non-integer window) | PS link never reached | Action task **faults the run** |
| PS host unreachable | — | catch → *Throw Error* → **Failed** |
| ActiveDirectory module missing | **`throw`** | catch → **Failed** |
| Scope empty, unreadable or not valid JSON | **`throw`** | catch → **Failed** |
| One domain/OU cannot be queried | `Error:` line; remaining OUs still swept; report **still sent**, marked `[INCOMPLETE]` | **Completed with Errors** |
| Scope valid but holds no accounts | `Warn:`; empty report sent **with** its scope footnote | **Success** |
| `expiringWithinDays` unparseable at the script | `Warn:`; degrades to 30 days | **Success** |
| Report file cannot be written to disk | `Warn:`; the report is still emailed | **Success** |

**Note the deliberate asymmetry.** A **scope** problem fails the run outright — nothing can
be trusted. A **per-OU** problem completes with errors and still delivers a report that
says which OUs are missing. Partial information, clearly labelled as partial, is more
useful than none.

**Success means the sweep completed — not that nothing is expiring.** Expired and expiring
accounts are findings *on* the report, not run failures. A scheduled run that found twelve
expiring accounts still ends successfully; treating findings as errors would alarm every
time the report did its job.

### Failure classification

A failed query is classified so the report can say what kind of problem it is and who
fixes it:

| Category | Meaning | Retry helps? |
|---|---|---|
| **Scope error** | The server answered and said the naming context is not its own, or the OU does not exist. A targeting fault. | **No** — deterministic. Correct the OU list. |
| **Access denied** | The PS host service account cannot read the OU. | No — grant read access. |
| **Authentication** | The directory rejected the credentials. | No — check the service account. |
| **Unreachable** | The domain controller could not be contacted. An availability fault. | **Possibly** — may clear on its own. |
| **Unclassified** | Not a pattern the classifier recognises. The raw message is shown in full. | Read the detail. |

Classification matches on the exception **message** first, with the type name as a
corroborating hint, and degrades safely to *Unclassified* rather than mislabelling.
Message patterns are **locale-sensitive**; a non-English DC would fall through to
*Unclassified* with its raw text intact.

---

## 7. Dependencies

| Dependency | Notes |
|---|---|
| PowerShell host registered in vRO | WinRM/HTTPS, Kerberos. Pre-bound as a workflow attribute, not a run-time input |
| RSAT `ActiveDirectory` module on the PS host | Absence **fails the run** (S-22) |
| LDAP reachability to every domain in scope | The domain is derived per-DN and used as `-Server` |
| Read rights on every OU in scope | For the PS host's service account |
| SMTP relay reachable from the PS host | The script sends the mail, not Orchestrator |
| Event Log package installed in vRO | Supplies the shared `parseScriptOutput` action |
| `cvs_functions.ps1` staged with S-16 … S-24 | Shared with the Admin Accounts Report — **same file, same host** |

---

## 8. Security considerations

- **Read-only.** The action issues `Get-ADUser` only. It holds no capability to modify the
  directory.
- **The disarmed mass-write case.** `cvs_functions.ps1` contains a `Set-L3-Admin-Accounts`
  case that performs an unattended bulk write of `SmartcardLogonRequired`. It is **absent
  from the `-Action` ValidateSet**, so the parameter is rejected before dispatch and the
  case cannot execute. **That omission is the only thing preventing it, and it is
  deliberate.** Do not add it to the ValidateSet without a separate, reviewed change.
- **Credentials.** No credentials are handled by the workflow or the action. Authentication
  is the PS host plug-in's Kerberos service account.
- **Report content.** The report contains account names, UPNs, descriptions and expiry
  dates — directory metadata, no secrets. It is emailed in clear text over the customer's
  SMTP relay; the distribution list should be scoped accordingly.
- **Input handling.** The scope crosses three quoting regimes (JavaScript → JSON →
  PowerShell single-quote → `ConvertFrom-Json`). Encoding is explicit and engine-independent,
  and the boundary is covered by dedicated regression tests. A corrupted DN does not
  throw — it searches somewhere else — which is why this path is tested directly.

---

## 9. Operational considerations

- **Schedule it.** This is a recurring report; use the OOTB *Schedule a workflow* or a
  recurrent task. All inputs are static per environment, so the schedule carries the whole
  scope.
- **Match the window to the schedule.** `expiringWithinDays` must be at least as long as
  the gap between runs, or an account can expire in the gap having never appeared in an
  *Expiring* section — going straight from Active to Expired between two reports. A monthly
  schedule wants 30+; a weekly schedule at 30 gives four warnings before the date.
- **The report file is overwritten**, not appended, so it cannot grow without bound across
  scheduled runs.
- **The transcript stays readable.** The report body is no longer written to the log; only
  a one-line summary is. A multi-kilobyte HTML blob on stdout would bury the `Error:` /
  `Warn:` lines the run is classified on.
- **Subject-line rules.** The subject gains ` ( N expired - M expiring within D days )`
  and an `[INCOMPLETE] ` prefix on degraded runs. Existing inbox rules matching the old
  subject exactly will stop matching.

---

## 10. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| 1 | The supplied OUs contain the customer's service accounts, and service accounts do not live elsewhere | Accounts outside the list are invisible to the report. Confirm during validation |
| 2 | `AccountExpirationDate` is the attribute the customer manages expiry with | The report measures the wrong thing. Confirm against a known-expiring account |
| 3 | The Orchestrator and Ansible estates never share a PowerShell host | Deployment sequencing would need coordinating. Confirmed for both dev and production |
| 4 | The PS host service account can read every OU in scope | Affected OUs report as *Access denied* and are excluded from the figures |
| 5 | Recipients read the email rather than the Orchestrator transcript | Drives the decision to render failures onto the report itself |
| 6 | Report volume is small enough for one email | A very large inventory could exceed practical mail size. Not observed; verify with production-scale data |
