# Change Register — Service Account Expiration Reporting

**Project:** Ansible → VCF Orchestrator transition — "Service Account Expiration Reporting"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Purpose of this document:** A single, customer-facing record of *how the service
account expiration report works today* and *every change* made to it during the
Orchestrator transition — what changed, and **why**.

> **Continues the shared `S-` / `P-` numbering.** `cvs_functions.ps1` is a shared
> toolbox. Changes **S-1 … S-5** / **P-1 … P-8** were made by the **Move Windows
> Event Logs** project, **S-6 … S-13** / **P-9 … P-13** by **Server Reboots**,
> **S-14 … S-15** / **P-14 … P-19** by **Windows Server Clean Disks**, and
> **S-16 … S-21** / **P-20 … P-26** by the **Admin Accounts Report** (each recorded in
> its own register). This deliverable adds **S-22 … S-24** and process changes
> **P-27 … P-32**.
>
> **Script under change (working copy):** `InProgress/psscript/files/cvs_functions.ps1`
> **Promoted to (on completion):** `Completed/_Shared References/psscript/files/cvs_functions.ps1`
> **Current-state baseline:** `InProgress/Service Account Expiration Reporting/service_accounts_report.yml` + `vars.txt`
>
> Only **two** working copies of the shared PowerShell exist: the In-Progress copy
> (edited while a project is in flight) and the Completed copy (what is migrated to the
> customer environment). The pre-transition originals under
> `Ansible Playbooks and Files - Sanitized/psscript/files/` are an **as-received source
> archive**, not a working copy, and are exempt from that rule.
>
> **This deliverable depends on the Admin Accounts Report.** It reuses the shared
> functions that deliverable introduced — `Resolve-DomainOUsMap`,
> `Get-ListOfUsers-MultiDomain`, `Remove-DuplicateAccounts`, `Get-ADFailureCategory`,
> `Format-HtmlTable` (S-16 … S-20). Both workflows must run against the **same** staged
> `cvs_functions.ps1`.

---

## 1. Current state — how the customer does it today

**Goal of the automation (unchanged):** report on the service accounts in a given OU so
that accounts approaching expiry are renewed before the services depending on them stop
working. The result is emailed as an HTML report.

**How it runs today (Ansible):**
- `service_accounts_report.yml` creates a temp dir on a Windows host over WinRM (5986),
  `win_copy`s the script folder, runs
  `cvs_functions.ps1 -Action Get-ServiceAccountExpiration -DomainName … -OUPath …`, then
  deletes the temp dir.
- The playbook is only a **delivery shell**. All real work happens in the script, on
  that one host.
- Production scope (`vars.txt`): **one domain, one OU** —
  `OU=Service Accounts,DC=corp,DC=local`.
- The script (`Get-ServiceAccountExpiration` case, as received):
  1. `Get-ListOfUsers -DomainName $DomainName` — a single `Get-ADUser` over `$OUPath` at
     `SearchScope Subtree`.
  2. Projects the accounts, computing a **password age** column.
  3. Sets the subject to the plain configured stem, with no counts.
  4. `GenerateReportServiceAccountExpiration` renders one HTML table and emails it.

**Unlike the Admin Accounts Report, there is no fork here.** One playbook, one job
template, invoking the mainline shared script. The transition is a straight replacement
plus the defect fixes below.

### 1A. Four pre-existing defects — all of them silent

Every one of these produced a report that looked correct and a run that reported
success. They are recorded in full because three of them mean **the report the customer
has been receiving is not the report they believe they have been receiving**.

| # | Defect | Effect |
|---|---|---|
| 1 | **Silent scope narrowing.** The action called `Get-ListOfUsers -DomainName $DomainName` with **no `-SC` argument**. `Get-ListOfUsers` declares `[bool]$SC`, so an omitted parameter **binds to `$false`** rather than staying null — and its guard `if ($SC -eq $true -OR $SC -eq $false)` is therefore **always true**, making the `-Filter *` branch beneath it **unreachable dead code**. Every run actually queried `SmartcardLogonRequired -eq $false`. | **Any service account that requires a smart card was silently omitted from every report ever produced.** Nothing in the output indicated a filter was applied |
| 2 | **The report never showed an expiration date.** `AccountExpirationDate` was selected by the action and then **omitted from the `ConvertTo-Html -Property` list**. The line `$body -replace 'AccountExpirationDate','ExpirationDate'` immediately below it had nothing to match. | A report titled "Service Account Expiration" that reported **password age only**. The single fact it exists to convey was absent |
| 3 | **A password that had never been set was reported as an age of 0.** `if($_.pwdLastSet -ne 0){ … } else { 0 }` — but `pwdLastSet = 0` means *never set*, or *must change at next logon*. The report also used `FromFileTimeUTC` for the age and `FromFileTime` for the display column. | The worst rows rendered identically to the best ones, and **sorted to the bottom** of a report ordered by age descending. The two password columns disagreed by the host's UTC offset |
| 4 | **`$Result += $Result2` — `$Result2` is never assigned** in this case. It is copy-paste residue from the admin-accounts case, where it holds the second sweep. | An unset variable appended a `$null` element, rendering **a blank row on every report** |

Alongside those, the action shared the resilience gaps the rest of this transition has
been closing: no `-ErrorAction Stop` and no `try`/`catch` around `Get-ADUser` (a bad OU
DN or an unreachable DC raised a **non-terminating** error the workflow never sees, and
an empty report was emailed as a success); an AD-module guard that logged an `Error:`
line and **fell through**, sending nothing; an **appending** report file that grew
without bound across scheduled runs; and `Write-Log "Info: $($body)"`, which wrote the
**entire HTML body** to stdout — the stream the workflow classifies on — after which
`SendMail` logged it a second time.

### 1A-i. Two SEPARATE environments — no shared PowerShell host

The PowerShell host used by **Orchestrator** is **NOT** the host the existing **Ansible**
job template runs against. They are **completely separate environments — in development
AND in production**, as established in the Admin Accounts Report register §1A-i.

Consequences, unchanged here: deploying the updated `cvs_functions.ps1` cannot disturb
the Ansible job; "parallel run" is environmental rather than file-level, and the two
systems are compared on their **output**; and there is **no deployment sequencing
dependency** between the two estates.

---

## 2. Changes to `cvs_functions.ps1`

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-22 | 2026-08-03 | `Get-ServiceAccountExpiration` case; new `ConvertFrom-ADFileTime`; new `Get-AccountExpiryState`; new `-ExpiringWithinDays` parameter | **Rebuilt the action on the shared multi-domain sweep and fixed all four §1A defects.** (a) Scope now comes from the domain→OU map via `Resolve-DomainOUsMap` (inline `-DomainOUs` or legacy `-DomainOUsFile`), and the sweep uses **`Get-ListOfUsers-MultiDomain` with NO `-SC` argument** — that function declares `$SC` untyped with a `$null` default, so omitting it genuinely reaches `-Filter *` and returns **every** account. (b) New **`ConvertFrom-ADFileTime`** returns `$null` for the FILETIME sentinels (`0`, and the "never" maximum) instead of a date, and uses `FromFileTime` throughout so the age and display columns share one time basis. (c) New **`Get-AccountExpiryState`** classifies each account as Expired / Expiring / Active / Never expires against a look-ahead window, handling AD's 1601 and 9999 sentinels. (d) The AD-module guard and the empty-scope guard now **throw**. (e) `Remove-DuplicateAccounts` runs **before** the counts. (f) The subject line carries `( N expired - M expiring within D days )`, prefixed `[INCOMPLETE] ` when any OU could not be read. (g) The phantom `$Result2` append is gone. | Defect 1 alone means the customer has never seen a complete list. Every one of the four is **invisible in the output** — the report looked right and the run reported success. For an expiration report the specific consequence is that an account expires and the service depending on it stops, having appeared in no report; "nothing is expiring" and "the query never ran" were indistinguishable in an inbox. Reusing the multi-domain sweep also brings per-OU failure isolation and classification (S-16/S-20) that this action never had. | Requires redeploying the updated `cvs_functions.ps1`. **The action is now driven by the OU map instead of `-DomainName`/`-OUPath`** — no caller is affected, because the Orchestrator and Ansible estates use separate PowerShell hosts (§1A-i). **Expect the account count to RISE** on the first run: that is defect 1 being fixed, not a scope change. Brief recipients first |
| S-23 | 2026-08-03 | `GenerateReportServiceAccountExpiration`; new `Format-ServiceAccountTable`, `Sort-ServiceAccountRows`, `Get-ServiceAccountSectionNote` | **Rebuilt the report** to the standard set by S-17, using the same helpers so the two deliverables look like one product. (a) **`Expires on` and `Days to expiry` columns restored** — defect 2. (b) An **Action required** block above the inventory holding the expired and expiring accounts across all domains, soonest first, with a Domain column. (c) Executive summary tiles, a per-domain summary with plain-language status, and a **full inventory** sectioned by domain and sub-sectioned by OU. (d) Query failures rendered **onto the report** with the S-20 classification and remediation guidance, plus `NOT READ` flags in the scope footnote. (e) `Never set` shown in the password columns, coloured, and **sorted to the top of its group** — defect 3. (f) All styling **inline** so it survives Outlook's Word rendering engine. (g) Writes to the Debug folder, creating it if absent, and **overwrites instead of appending**. (h) Logs a **one-line summary** instead of the entire HTML body. | The v1 report could not answer the question it existed to answer, because it had no expiration column. Beyond that: the people who act on this report read the email, not the Orchestrator transcript, so an unread OU has to be visible **on the report** — a failed OU produces no rows, which reads exactly like an OU with nothing expiring. Putting the actionable accounts above the inventory means a reader who stops after the first screen has still seen everything that needs doing. The unbounded append and the multi-kilobyte HTML blob on stdout were both operational hazards — the latter buries the `Error:`/`Warn:` lines the run is classified on. | Requires redeploying the updated `cvs_functions.ps1`. **The emailed report changes shape substantially** — brief the recipients before the first scheduled send. The subject line gains counts and an `[INCOMPLETE]` prefix on degraded runs; **any inbox rule matching the subject must be reviewed** |
| S-24 | 2026-08-03 | `Get-ListOfUsers` (marked SUPERSEDED); the S-21 comment in `Get-AllAdmin-Accounts` | **Documentation-only, no behaviour change.** (a) `Get-ListOfUsers` is marked **SUPERSEDED**, with its live defect recorded in place: the `[bool]$SC` binding that makes its guard always true and its `-Filter *` branch unreachable (the mechanism behind S-22 defect 1). Its only two callers, `Get-Users-SCenable` and `Set-L3-Admin-Accounts`, are **absent from the `-Action` ValidateSet** and cannot execute. (b) Corrected a now-false comment in the S-21 block, which stated that `-OUPath` and `-DomainName` remain in the param block *"because `Get-ServiceAccountExpiration` still uses them via `Get-ListOfUsers`"*. **That is no longer true** — S-22 moved this action onto the OU map, so `-OUPath` is now read by no reachable action. | A superseded function carrying an undocumented defect is a trap for the next person to reach for it — and this particular defect has already cost the customer a silently incomplete report for the life of the automation. The stale comment was worse: it recorded a dependency that no longer exists as the justification for keeping two parameters, which would have misled anyone auditing what is still live. | None — comments only. **See §5: whether to REMOVE `Get-ListOfUsers` and `-OUPath` outright is an open decision**, because doing so also affects the two disabled cases |

### S-22 detail — where the scope comes from

`Resolve-DomainOUsMap` (S-16) accepts the scope from either source, and **the file wins**
if both are supplied (logged, not silent):

| Source | Parameter | Used by |
|---|---|---|
| Inline JSON | `-DomainOUs` | **Orchestrator** — invokes a pre-staged script, has no staging step |
| JSON file | `-DomainOUsFile` | Legacy Ansible — retained, though this playbook never used it |

**No legacy `-DomainName` / `-OUPath` fallback was added**, deliberately, for the reason
S-21 removed one from the admin report: `$DomainName` is a *shared* script parameter, so
a hand-run or a future caller that set the legacy pair but omitted the map would quietly
produce a report covering **one OU** and report success. For an expiration report a
silently narrowed scope means an account expires with nobody warned — the exact failure
this report exists to prevent.

### S-22 detail — the look-ahead window

`-ExpiringWithinDays` (default `30`) decides which accounts are called out as
**Expiring** and counted in the subject line. It is important to be precise about what
it does **not** do:

- It **does not filter the report.** Every account in scope always appears in the
  inventory.
- It **does not affect expired accounts.** Anything past its expiration date is reported
  regardless of the window.
- It is **inclusive at its edge and rounds toward warning early**: an account 29.6 days
  away *is* flagged by a 29-day window. Warning one scheduled run late is the failure
  mode that matters; warning marginally early is free.

Bad input **degrades to 30 with a `Warn:`** in the script rather than failing the run —
a typo must not cost the customer the report. The vRO action validates it strictly and
rejects it up front, so the degradation path should never be reached from Orchestrator.

**Match the window to the schedule.** If the report runs monthly with a 7-day window, an
account can expire in the gap having never appeared in an Expiring section — it would go
straight from Active to Expired between two reports.

### Failure-handling contract after S-22 / S-23

| Condition | Behaviour |
|---|---|
| ActiveDirectory module missing | **`throw`** → OOTB *Invoke a PowerShell script* catch → **Failed** end state |
| Scope empty, unreadable or not valid JSON | **`throw`** → **Failed** end state |
| One domain/OU cannot be queried | `Error:` line → **Completed with Errors**; remaining OUs still swept; report **still sent**, marked `[INCOMPLETE]`, with the failure **classified** (S-20) |
| Scope valid but holds no accounts | `Warn:` → **success**; empty report sent **with** its scope footnote |
| `-ExpiringWithinDays` unparseable | `Warn:` → **success**; window degrades to 30 |
| Report file cannot be written | `Warn:` → the report is still emailed |

Note the deliberate asymmetry, inherited from the admin report: a **scope** problem fails
the run outright (nothing can be trusted), whereas a **per-OU** problem completes with
errors and still delivers a report that says which OUs are missing.

---

## 2A. What the report does and does not cover

> **This is a required, customer-facing section.** The figures carry assumptions that are
> not visible from the workflow inputs. Reproduce this list verbatim in
> `02_Design_Document` and `04_User_Guide` so no reader over-reads the numbers.

| # | Behaviour | Detail | Configurable? |
|---|---|---|---|
| 1 | **Scope is the OU list — nothing else** | Only the OUs in `domainOUs` are searched, at `SearchScope Subtree`. A service account outside those OUs is **not reported**. The report is only as good as the OU list. | Yes — via `domainOUs`. |
| 2 | **"Service account" means "in a service account OU"** | The query is `Get-ADUser` over the OU with **no filter** for account type, naming convention or `servicePrincipalName`. Anything that is a user object in those OUs is reported — including a human account someone parked there. | No — inherent to the design. |
| 3 | **"Expiration" means the ACCOUNT expiration date** | The report is built on `AccountExpirationDate` — the date the *account* stops being able to authenticate. It is **not** password expiry. | No — by design. See #4. |
| 4 | **Password age is AGE, not "days until the password expires"** | The password columns show how long ago the password was set. The report does **not** read the domain's maximum password age policy or `PasswordNeverExpires`, so it cannot say when a password will expire. A 400-day-old password may be entirely compliant under a policy that never expires service accounts. **Read the column as a hygiene signal, not a deadline.** | No — not implemented. **Open item, see §5.** |
| 5 | **"Never expires" is the AD default, not a finding** | An account with no expiration date is normal. It is reported as its own state so the reader can see how much of the estate has no expiry at all — a service account that never expires also never prompts a review — but it is **not** counted as expired or expiring. | No — by design. |
| 6 | **Disabled and locked-out accounts are included** | A disabled account that has expired **is** counted in the expired figure, and shown with its account state. Preserves the existing metric and makes the composition visible. | No — deliberate. Revisit only as an explicit metric change. |
| 7 | **Unread OUs are excluded from every figure** | A failed OU contributes no rows. The totals are a **floor, not a total** — which is why the report carries the `[INCOMPLETE]` banner and subject prefix. | No — by design. |
| 8 | **Read-only, always** | The action only runs `Get-ADUser`. It cannot renew, extend, disable or delete anything it reports on. There is no `whatIf` gate because there is nothing to gate. | No — by design. |
| 9 | **Searches are FULLY RECURSIVE** | Every AD query uses `-SearchScope Subtree`, which returns the search base **and every descendant at any depth**. Listing one OU covers everything beneath it. Inherited from the original script and preserved. | No — matches original. |
| 10 | **Overlapping OUs are de-duplicated** | A consequence of #9: listing both a parent OU **and** a descendant returns the deeper accounts twice. Each account is counted and listed **exactly once**, under the deepest OU that returned it (S-19), with an informational notice. | The de-duplication is automatic. Tidy `domainOUs` to make the notice go away. |
| 11 | **The window does not filter the report** | `expiringWithinDays` decides what is called out and counted, not what is listed. The full inventory is always present. | Yes — via `expiringWithinDays`. |

---

## 3. Changes to the automation process (Ansible → Orchestrator)

| # | Date | Area | Current process (Ansible) | New process (Orchestrator) | Reason |
|---|------|------|---------------------------|----------------------------|--------|
| P-27 | 2026-08-03 | Execution engine | `service_accounts_report.yml` stages the script folder with `win_copy` over WinRM and runs it with `win_command` | Workflow **Get-ServiceAccountExpirationReport** calls the **pre-staged** `cvs_functions.ps1` via the OOTB *"Invoke a PowerShell script"* over the PowerShell plug-in (WinRM/HTTPS/Kerberos) | Replace Ansible with Orchestrator while reusing proven script logic; eliminates per-run script staging |
| P-28 | 2026-08-03 | **Scope delivery** | `-DomainName` + a single `-OUPath`, one domain and one OU | Operator supplies a **flat list of OU distinguishedNames**, one per row. The **domain is DERIVED** from each DN's own `DC=` components; `buildServiceAccountExpirationInvocation` groups the rows by derived domain and passes the JSON map **inline** as `-DomainOUs` | A DN already contains its domain — asking for it separately is redundant data entry and something that can *disagree* with the DN beside it. Today's single OU is a list of one row, so nothing is lost; adding a second OU or a second domain later needs no change to the workflow. Rows keep the scope reviewable line-by-line in the request form and run history, and let the action reject a malformed entry with a pointed message instead of failing inside PowerShell. Mirrors P-22 |
| P-29 | 2026-08-03 | **New capability — the look-ahead window** | None. The report had no concept of "expiring soon"; it listed accounts and left the reader to compare dates by eye — which was impossible in any case, because no date was rendered (§1A defect 2) | **`expiringWithinDays`** (default 30) drives an *Action required* section and the subject-line counts | A report is only useful if it makes the next action obvious. The subject line now carries the finding, so a scheduled report can be triaged from the inbox without opening it — and a run with nothing to do says so unambiguously, which is what makes an empty report trustworthy rather than suspicious |
| P-30 | 2026-08-03 | Variables / secrets | `vars` / `group_vars` | Workflow inputs with defaults set directly on each input (no Configuration Element); credentials via the PS host plug-in service account | Standard Orchestrator patterns; these values are static per environment, so self-contained inputs are preferred over a shared Config Element (same decision as P-8 / P-17 / P-23) |
| P-31 | 2026-08-03 | **Report audience** | One flat table, sorted by password age, with no expiry date, no counts and no indication of failure | **Action-first**: expired and expiring accounts lifted above the inventory, executive summary, per-domain status, failures rendered onto the report and flagged in the subject | The report is read by people who will renew the accounts, not by whoever runs the workflow. They cannot be expected to open Orchestrator to discover why a figure is wrong, and a failed OU is indistinguishable from a healthy one unless the report says so |
| P-32 | 2026-08-03 | **Pre-delivery validation** | None — correctness was established by running against production AD | **Offline regression suite** (`lab/Run-AllTests.ps1`, **248 checks**) covering the vRO action, the PowerShell functions, the workflow's scriptable tasks and the JS→PowerShell escaping boundary. No AD, SMTP, PS host or vRO appliance required. Plus `lab/New-ServiceAccountTestData.ps1`, which seeds a lab directory **and prints the figures the report should produce** | The JSON → PowerShell-quoting → `ConvertFrom-Json` chain is the one place a quoting bug silently corrupts the report **scope**, and a corrupted DN does not throw — it searches somewhere else. The suite loads the functions under test **out of the live files by AST**, so it cannot drift from shipping code, and §8 asserts against the **shipping switch-case source** because a behavioural test cannot catch the re-introduction of `-SC $false` (see P-32 detail) |

### P-32 detail — why some tests read the source

Most of the suite is behavioural. Twenty-one checks are not: they assert against the
**text of the shipping switch case**, with comments stripped.

They exist because the regression that matters most here is invisible to behaviour.
Re-adding `-SC $false` to the sweep would restore §1A defect 1 — a silently narrowed
report — and **every behavioural test would still pass**, because none of them supplies
the input that would expose it. The same applies to a reinstated `-OUPath` fallback and
to the phantom `$Result2`.

The comments are stripped deliberately: the case quotes the old defective code verbatim
to explain why each guard exists, and an assertion run against raw text would fail on its
own documentation — where the tempting "fix" is to delete the explanation.

**Net result:** **1** job template → **1** workflow
(`Get-ServiceAccountExpirationReport`); the invoked action
(`Get-ServiceAccountExpiration`) already exists in the deployed script but is
substantially rewritten (**S-22**) with its report rebuilt (**S-23**); four silent
defects are fixed; and the shared `parseScriptOutput` / OOTB *Invoke a PowerShell
script* contract is reused unchanged.

---

## 4. Current vs new — quick mapping

| Today (Ansible job template) | Script called | Scope passed as | New (Orchestrator workflow) |
|---|---|---|---|
| `service_accounts_report.yml` (×1 template) | `cvs_functions.ps1` | `-DomainName` + single `-OUPath` | `Get-ServiceAccountExpirationReport` |

**Variable mapping:**

| Ansible var (`vars.txt`) | vRO workflow input | Script parameter |
|---|---|---|
| `var_OUPath` + `var_DomainName` | `domainOUs` — Array/string, **one OU DN per row**; domain derived from `DC=` | `-DomainOUs` (JSON map, built by the action) |
| — (no equivalent today) | `expiringWithinDays` (number, default 30) | `-ExpiringWithinDays` |
| `var_eMailReport` (`yes`) | `emailReport` (boolean) | `-eMailReport` |
| `var_SMTPServer` (`mailrelay.corp.local`) | `smtpServer` | `-SMTPServer` |
| `var_MailToString` | `mailTo` (Array/string, one address per element) | `-MailToString` |
| `var_MailCcString` | `mailCc` (Array/string, optional) | `-MailCcString` |
| `var_MailSubjectstring` | `mailSubject` | `-MailSubjectstring` |
| `var_ps_folder` / `var_ps_script_file` | folded into `scriptPath` | `& "<scriptPath>"` |
| `var_parameter_action` (`Get-ServiceAccountExpiration`) | fixed in the build action | `-Action 'Get-ServiceAccountExpiration'` |
| `var_cleanup_temporary_folder` | *(no equivalent — nothing is staged)* | — |
| — | *(none — removed by S-22)* | ~~`-DomainName`~~ / ~~`-OUPath`~~ |

---

## 5. Outstanding / deferred

| Item | Status / note |
|---|---|
| **Remove `Get-ListOfUsers` and the `-OUPath` parameter outright?** | **CLOSED 2026-08-03 — keep both, marked SUPERSEDED.** After S-22 neither has a reachable caller (§2 S-24), so removal would be tidy and would match the S-21 reasoning. It was **not** done, for one reason: `Get-ListOfUsers` is still referenced by two cases disabled *only* by their absence from the `-Action` ValidateSet, and one of them — `Set-L3-Admin-Accounts` — performs an unattended **mass write** of `SmartcardLogonRequired` and is documented as deliberately unreachable (Admin register §2A-i, *"do not add to the ValidateSet without a separate, reviewed change"*). Deleting the function it depends on would disarm it further, which is probably desirable, but it is a change to code another register has fenced off. **The distinction that decided it: `-OUPath` is now INERT, not a silent alternate path.** S-21 removed the admin report's fallback because a caller could set it and quietly get a *narrower report reported as success*; nothing reachable reads `-OUPath` any more, so setting it now does nothing at all. Dead weight, carrying a documented defect warning, is an acceptable end state; a silent alternate path was not. Revisit if and when the two disabled cases are formally retired |
| **Password EXPIRY vs password AGE** | **Open — awaiting customer decision.** The report shows how old a password is, not when it expires (§2A #4). Computing days-until-password-expiry would mean reading the domain's `maxPwdAge` (and any Fine-Grained Password Policy that applies to the account) and honouring `PasswordNeverExpires` — a genuinely different, more useful metric, and a new AD query per domain. **Not implemented.** Until it is, the password columns must be read as a hygiene signal only, and the User Guide says so |
| **Should the report cover accounts outside the service-account OUs?** | **Open.** §2A #2 — the report finds "user objects in these OUs", not "service accounts". If the customer has service accounts living elsewhere, or a naming convention / SPN that identifies them, a different scoping strategy may be wanted. Confirm the OU list is genuinely complete during lab validation |
| **Exemptions / expected-expiry allow-list** | **Open.** An account deliberately scheduled to expire (a contractor integration, a time-boxed migration account) is reported as Expiring on every run until it does. No allow-list exists. Options mirror the admin report's open item: an allow-list input, a `Description` convention, or accept the noise |
| **Confirm real AD exception type names** | Inherited from S-20. `ExceptionType` is recorded verbatim on every failure record; provoke each failure mode against real AD during lab validation and tighten the hint table. Message patterns are **locale-sensitive** — a non-English DC falls through to *Unclassified*, which is the safe degradation |
| **Subject-line inbox rules** | **Action required before first scheduled send.** The subject gains ` ( N expired - M expiring within D days )` and an `[INCOMPLETE] ` prefix on degraded runs. Any existing Outlook rule matching the old subject exactly will stop matching |
| **Brief recipients that the account count will RISE** | **Action required before first scheduled send.** §1A defect 1 — accounts requiring a smart card were silently excluded from every previous report. The increase is previously-invisible scope becoming visible, not a scope expansion |
| Workflow ID | **TBD** — assign on first save in vRO, then record it in `Get-ServiceAccountExpirationReport_spec.js` |
| `.package` export (`com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry`) | Built from the action + workflow once the workflow is assembled in vRO. Depends on the Event Log package for `parseScriptOutput` |
| Customer documentation set (`01_Executive_Summary` … `05_Validation_and_Testing_Plan`) | **COMPLETE 2026-08-04.** §2A is reproduced in `02_Design_Document` §5 and condensed in `04_User_Guide` §7; §1A defect 1 (the count will rise) leads `01_Executive_Summary` and is a blocking exit criterion in `05_Validation_and_Testing_Plan` (H2, I3) |
| Lab validation against real AD | **Pending.** The offline suite (P-32) cannot cover the `Get-ADUser` queries, per-OU failure isolation against a genuinely unreachable DC, real `pwdLastSet` values, SMTP delivery, or Outlook rendering — all belong in `05_Validation_and_Testing_Plan` |
| Back-dating `pwdLastSet` in the lab seeder | **Not possible.** `pwdLastSet` is written by the directory when the password changes; there is no supported way to set it to an arbitrary age. The seeder covers the case that mattered (`pwdLastSet = 0`) via `-ChangePasswordAtLogon`. Password-age *values* can only be observed against real accounts |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-08-03 | Automation transition | Initial register. Script changes **S-22** (action rebuilt on the shared multi-domain sweep; four silent defects fixed — the omitted `-SC` argument that narrowed every previous report to non-smartcard accounts, the missing expiration column, the `pwdLastSet = 0` age-of-zero, and the phantom `$Result2` blank row; AD-module and zero-scope guards now throw; new `ConvertFrom-ADFileTime` and `Get-AccountExpiryState`; new `-ExpiringWithinDays` window), **S-23** (report rebuilt: expiration columns restored, action-required sections above the inventory, per-domain and per-OU sectioning, failure classification surfaced onto the report, inline styling for Outlook, overwrite instead of append, one-line log summary instead of the whole HTML body) and **S-24** (documentation only: `Get-ListOfUsers` marked SUPERSEDED with its live defect recorded; corrected a now-false S-21 comment about why `-OUPath` survives). Process changes **P-27 … P-32** (Ansible→Orchestrator; scope delivered inline as a flat DN list; the look-ahead window as a new capability; inputs with direct defaults; action-first report; offline regression suite of 248 checks). Code: `buildServiceAccountExpirationInvocation` action + `Get-ServiceAccountExpirationReport` workflow spec + `lab/` regression suite and AD seeder. Open items: password expiry vs password age, and an exemptions allow-list. |
| 2026-08-04 | Automation transition | **Customer documentation set completed** — `01_Executive_Summary`, `02_Design_Document`, `03_Implementation_Guide`, `04_User_Guide`, `05_Validation_and_Testing_Plan`. §2A is reproduced in the Design Document and condensed in the User Guide as required. Two facts are carried through all five as the deliverable's headline: the corrected report will list **more** accounts than the Ansible one (defect 1), and the subject line has changed — both are pre-send briefing actions and blocking exit criteria (Phase H2, I3, I5). The Validation Plan also makes the two silent-defect `Select-String` guards (A8) and the run against the *deployed* script (C2) blocking, since neither failure mode is visible in a report. Phase F4 is recorded as a deliverable in its own right: observe the real AD exception type names, which S-20 could only guess at. |
| 2026-08-04 | Automation transition | **Lab tooling fix — no change to the deliverable's behaviour.** The first real lab run of `New-ServiceAccountTestData.ps1` aborted on its own normal path: the ActiveDirectory cmdlets raise `ADIdentityNotFoundException` as a **terminating** error when `-Identity` or `-SearchBase` does not resolve, and **`-ErrorAction SilentlyContinue` does not suppress a terminating error**. The seeder's "does this OU exist yet?" checks therefore killed the script whenever the OU did *not* exist — precisely the case it is written to handle. Replaced with `try`/`catch` wrappers (`Get-OUOrNull`, `Get-UsersOrEmpty`) matching the exception by **type name** rather than a `[type]` literal so it survives module-version differences; added an explicit check that a supplied `-OUPath` parent exists, so a typo says so instead of surfacing later as a `New-ADOrganizationalUnit` failure; and made `-Remove` exit cleanly when the test OU is already gone. Regression suite gains a new §10 asserting the broken pattern cannot return (256 checks). Recorded because the same trap applies to any AD code in this toolbox, and it reads as correct to anyone who has not hit it. |
| 2026-08-03 | Automation transition | **Decision recorded:** `Get-ListOfUsers` and `-OUPath` are **kept, marked SUPERSEDED**, rather than removed (§5). The deciding distinction is that `-OUPath` is now **inert** — nothing reachable reads it — whereas the S-21 fallback it superficially resembles was a **silent alternate path** that could produce a narrower report reported as success. Removing the function would also disarm `Set-L3-Admin-Accounts` further, which belongs to the Admin Accounts Report register, not this one. Customer documentation set **deferred** to a later session; the code, tests and this register are complete. |
