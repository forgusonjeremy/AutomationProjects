# Change Register — Admin Accounts Report

**Project:** Ansible → VCF Orchestrator transition — "Admin Accounts Report"
(administrative account smart card / PKI compliance reporting)
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Purpose of this document:** A single, customer-facing record of *how the admin
account compliance report works today* and *every change* made to it during the
Orchestrator transition — what changed, and **why**.

> **Continues the shared `S-` / `P-` numbering.** `cvs_functions.ps1` is a shared
> toolbox. Changes **S-1 … S-5** / **P-1 … P-8** were made by the **Move Windows
> Event Logs** project, **S-6 … S-13** / **P-9 … P-13** by **Server Reboots**, and
> **S-14 … S-15** / **P-14 … P-19** by **Windows Server Clean Disks** (each recorded
> in its own register). This deliverable adds **S-16 … S-21** and process changes
> **P-20 … P-26**.
>
> **Script under change (working copy):** `InProgress/psscript/files/cvs_functions.ps1`
> **Promoted to (on completion):** `Completed/_Shared References/psscript/files/cvs_functions.ps1`
> **Current-state baseline:** `InProgress/psscript/Admin Accounts Report/admin_accounts_report-v2.yml` + `vars.txt`
>
> Only **two** working copies of the shared PowerShell exist: the In-Progress copy
> (edited while a project is in flight) and the Completed copy (what is migrated to
> the customer environment). The pre-transition originals under
> `Ansible Playbooks and Files - Sanitized/psscript/files/` are an **as-received
> source archive**, not a working copy, and are exempt from that rule.

---

## 1. Current state — how the customer does it today

**Goal of the automation (unchanged):** report on every privileged ("admin") account
across the estate and identify which ones do **not** require a smart card to log on
(`SmartcardLogonRequired = False`) — i.e. which privileged accounts are outside PKI
enforcement. The result is emailed as an HTML report with the compliant /
non-compliant counts in the subject line.

**How it runs today (Ansible):**
- `admin_accounts_report-v2.yml` creates a temp dir on a Windows host over WinRM
  (5986), renders `var_DomainOUs` to JSON with `to_json` and `win_copy`s it to
  `domain_ous.json`, `win_copy`s the script folder, runs
  `cvs_functions-v2.ps1 -Action Get-AllAdmin-Accounts -DomainOUsFile …`, then
  deletes the temp dir.
- The playbook is only a **delivery shell**. All real work happens in the script, on
  that one host, querying every domain over LDAP.
- Production scope (`vars.txt`): **7 domains × 2 OUs** — an `Admin Accounts` OU under
  `Servers` and one under `Workstations` in each domain.
- The script (`Get-AllAdmin-Accounts` case in the **v2 fork**, as received):
  1. Reads and `ConvertFrom-Json`s the OU map from `-DomainOUsFile`.
  2. `Get-ListOfUsers-MultiDomain` runs **two** `Get-ADUser` sweeps per OU —
     `SmartcardLogonRequired -eq $true`, then `-eq $false` — at `SearchScope Subtree`.
  3. Counts each set, folds them into the subject as
     `( N Non-Compliance - M Compliance )`.
  4. `GenerateReportPKI-v2` renders one merged HTML table plus a footnote listing the
     OUs queried, and emails it.

### 1A. The fork problem — why this transition starts with a merge

**This deliverable is different from the others.** The playbook does not invoke the
shared `cvs_functions.ps1` at all — it invokes **`cvs_functions-v2.ps1`, a separate
fork**. The two had diverged in opposite directions:

| | `cvs_functions.ps1` (mainline) | `cvs_functions-v2.ps1` (fork) |
|---|---|---|
| `Get-AllAdmin-Accounts` | **Single** domain + single OU (`-DomainName` + `-OUPath`) | **Multi**-domain OU map (`-DomainOUsFile`) |
| Multi-domain functions | absent | `Get-ListOfUsers-MultiDomain`, `GenerateReportPKI-v2` |
| Hardening S-1 … S-15 | present | **absent** |
| `move-archived-logs-ByCN`, `Get-ServerRebootReportStatus-ByCN`, `Delete-OldFiles-UNC-Share` | present | **absent** |
| Hardened resolvers (`-ByCN`, `-Direct`) | present | **absent** |

The multi-domain capability the customer actually runs existed **only** in the fork,
and the fork predates every resilience change made during this transition. Carrying
the fork forward would mean maintaining two divergent copies of a shared toolbox
indefinitely — directly against the two-working-copies rule above.

**Resolution:** the fork's multi-domain capability is **merged into the hardened
mainline** (S-16 / S-17) and the fork is **retired** (P-21). After this deliverable
there is again exactly one working copy of the shared script.

**Which jobs point where (confirmed against the job templates):**

| Script on the **Ansible** PS host | Job templates using it |
|---|---|
| `cvs_functions.ps1` | Move Event Logs · Server Reboots · Reboot Report ByCN · Clean Disks · Service Account Expiration · Get Datastores >75% · **Admin Accounts Report (single-OU template)** |
| `cvs_functions-v2.ps1` | **Admin Accounts Report (2 multi-domain templates) — nothing else** |
| `cvs_report_script.ps1` | VMware Disable SSH (a **third** divergent copy — out of scope here, see §5) |

### 1A-i. Two SEPARATE environments — no shared PowerShell host

> **This is the single most important operational fact in this register, and it is
> easy to get wrong.**

The PowerShell host used by **Orchestrator** is **NOT** the PowerShell host the
existing **Ansible** job templates run against. They are **completely separate
environments — in development AND in production**. The two estates never share a
PowerShell host at any stage.

Consequences:

- **Deploying the merged `cvs_functions.ps1` cannot disturb any Ansible job.** The
  Ansible host keeps its own copies of `cvs_functions.ps1`, `cvs_functions-v2.ps1`
  and `cvs_report_script.ps1`, untouched. There is no shared file to overwrite and
  therefore **no deployment prerequisite** to coordinate before the vRO side ships.
- **"Parallel run" is environmental, not file-level.** The two systems run
  side by side on different hosts against the same directory, and are compared on
  their *output*. Nothing has to interleave on one machine.
- **Retiring the fork affects only the job being transitioned** (P-21); no other
  automation regresses.
- **S-18 (the legacy `-DomainName` / `-OUPath` fallback) was therefore protecting
  against a break that could never happen, and has been REMOVED by S-21** — see the
  S-18 → S-21 note below.

**Pre-existing defects found during the merge (all fixed here):**
- **Inline scope silently ignored.** `$DomainOUsMap` was only ever built inside
  `if ($DomainOUsFile)`. Passing the map inline via `-DomainOUs` left it **unset** —
  the sweep iterated nothing, and the run **emailed an empty compliance report and
  reported success**. This is the exact path Orchestrator needs (see P-22).
- **Unhandled malformed JSON.** `ConvertFrom-Json` had no error handling; a bad map
  produced a parser error on the PS *error stream* (invisible to the workflow, which
  classifies `Error:` lines on stdout) and the run continued with a null map.
- **Hashtable fallback corrupted the footnote.** The empty case assigned `@{}`; every
  consumer walks `.PSObject.Properties.Name`, which on a hashtable returns its .NET
  members (`Keys`, `Values`, `Count`, …) — rendered as though they were domain names.
- **Silent partial sweeps.** `Get-ADUser` had no `-ErrorAction Stop` and no
  `try`/`catch`. A bad OU DN, an unreachable domain controller or a broken trust
  raised a **non-terminating** error the workflow never saw, so a partial sweep was
  reported as a clean run — **and the missing accounts read as compliant**.
- **`Write-Host "DEBUG: …"`** bypassed `Write-Log`, so it reached neither the log file
  nor any prefix the workflow recognises.

---

## 2. Changes to `cvs_functions.ps1`

| # | Date | Function / Section | Change | Reason | Deployment impact |
|---|------|--------------------|--------|--------|-------------------|
| S-16 | 2026-07-28 | `Get-AllAdmin-Accounts` case; new `Resolve-DomainOUsMap`; new `Get-ListOfUsers-MultiDomain`; `InitializeVariables` | Merged the fork's **multi-domain** capability into the mainline script and hardened it: (a) new **`Resolve-DomainOUsMap`** accepts the scope **inline (`-DomainOUs`) or as a file (`-DomainOUsFile`)**, fixing the inline-ignored defect, adding `try`/`catch` around `ConvertFrom-Json`, and returning `$null` (not `@{}`) when empty; (b) new **`Get-ListOfUsers-MultiDomain`** sweeps every OU in every domain with **per-OU `try`/`catch` + `-ErrorAction Stop`**, tags each account with **`SourceDomain` / `SourceOU`**, records failures on **`$Global:QueryFailures`**, and logs via `Write-Log` (not `Write-Host "DEBUG:"`); (c) the switch case now **throws** when the ActiveDirectory module is missing or the scope is empty/unparseable, takes counts with `Measure-Object` on forced arrays, and logs the disabled-account breakdown. | The capability the customer runs existed only in an unhardened fork. Every defect in §1A produces the same failure mode — **an under-reported or empty compliance report that looks successful**. For a compliance deliverable that is the worst possible outcome: "no non-compliant accounts found" and "the query never ran" were indistinguishable. | Requires redeploying the updated `cvs_functions.ps1`. `Get-AllAdmin-Accounts` is now driven by the OU map rather than `-DomainName` / `-OUPath` — and **no caller is affected**: the Orchestrator and Ansible estates use separate PowerShell hosts (§1A-i), so no existing job reaches this action. `-OUPath` remains in use by `Get-ServiceAccountExpiration`. Retires `cvs_functions-v2.ps1` (P-21). |
| S-20 | 2026-07-29 | New `Get-ADFailureCategory`; `Get-ListOfUsers-MultiDomain` catch block; `GenerateReportPKI-v2` failure table | **Classify** each failed OU query instead of printing a raw exception string. The catch block now captures the exception **type** as well as its message and records `Category`, `Guidance` and `ExceptionType` on the failure. The report's failure table gains **Problem** and **What to do** columns, colour-codes the category, breaks the count down by category in the banner ("2 OU(s) … (1 scope error, 1 unreachable)"), and names the category in the per-OU note. Categories: **Scope error**, **Access denied**, **Authentication**, **Unreachable**, **Unclassified**. | "A referral was returned from the server" and "The server is not operational" are equally opaque on a report but are *entirely different problems*. A **referral means the server ANSWERED** and said the naming context is not its own — a **targeting** fault that is deterministic, will recur on every run, and is fixed by correcting the OU list. "Not operational" is an **availability** fault that may clear by itself. Retrying helps the second and never the first. The reader has to be able to tell which they have, and who fixes it. | Requires redeploying the updated `cvs_functions.ps1`. Failure records gain three fields; **older records without them still render**, defaulting to *Unclassified* with a fallback instruction. No input or workflow change. |
| S-19 | 2026-07-28 | `GenerateReportPKI-v2`; new `Format-PKIAccountTable` | (a) **Sub-section by OU** inside each domain section, when that domain has **more than one** OU in scope. Driven from the scope map in the operator's own order, so an OU that returned nothing still gets a heading saying so, and an unreadable OU is flagged **at the OU** rather than only at the domain. A domain with a single OU is deliberately **not** sub-sectioned — the heading would only repeat the scope footnote. (b) **De-duplication** via the new `Remove-DuplicateAccounts`: an account returned by more than one OU search is collapsed to **one** entry, kept under the **deepest (most specific)** OU that returned it, and an informational notice lists what was collapsed. Called from the action **before the counts are taken** — and again, idempotently, inside the report. (c) Table rendering extracted to `Format-PKIAccountTable` so the domain-level and OU-level tables cannot drift apart. | Per-OU sectioning answers "which OU is the problem?", not just which domain — the OU is the unit an administrator actually remediates. De-duplication is needed because searches run at **`SearchScope Subtree`, which is FULLY RECURSIVE**: an OU list containing a parent *and* a descendant returns the deeper accounts twice. The recursive search is **inherited behaviour and deliberately unchanged** — the OU list is built against a directory we cannot inspect, so narrowing scope could silently drop accounts that are in scope today. Correcting the *outcome* is safe; changing the *query* is not. | Requires redeploying the updated `cvs_functions.ps1`. **The emailed report changes shape again** for any domain with 2+ OUs in scope — brief recipients alongside S-17. No input or workflow change. **Counts may drop** on the first run after deployment if the OU list overlaps — that is the correction, not a regression. |
| S-21 | 2026-07-29 | `Get-AllAdmin-Accounts` scope resolution | **Removed the S-18 legacy fallback.** The OU map is now the **only** way to scope this action; no map means the run throws. The `-OUPath` / `-DomainName` **parameters remain** in the param block — `Get-ServiceAccountExpiration` still uses them via `Get-ListOfUsers` — only this action's use of them is gone. | Confirmed that Orchestrator uses a PowerShell host **separate from the Ansible templates in BOTH development and production**, so no caller can reach this action the legacy way. The fallback was not merely dead code, it was a **silent alternate path**: `$DomainName` is a shared script parameter, so a hand-run or future caller that set `-DomainName`/`-OUPath` but omitted `-DomainOUs` would have quietly produced a report covering **one OU** and reported success, rather than failing and saying what was missing. Silently narrowing a compliance report's scope is the worst available outcome — the same reasoning behind every other guard in this action. | Requires redeploying `cvs_functions.ps1`. **No caller is affected** in either environment. A run that supplies no OU map now fails with a clear message instead of producing a single-OU report. |
| ~~S-18~~ | ~~2026-07-28~~ | **SUPERSEDED by S-21 — see below.** `Get-AllAdmin-Accounts` scope resolution | ~~**Legacy single-domain fallback.**~~ When no `-DomainOUs` / `-DomainOUsFile` map is supplied but the legacy `-DomainName` **and** `-OUPath` pair is, they are promoted to a one-entry map and the run proceeds normally (logged as a `Warn:` on every use). Supplying **both** still prefers the map. Supplying **half** the legacy pair still throws — a domain with no OU must never silently search the entire domain. | One Ansible job template calls this action the pre-merge way against **this** script (not the v2 fork), so the merged script had to keep accepting that shape. A single domain + single OU *is* a one-entry map, so the legacy inputs are promoted rather than special-cased: sweep, sectioning, failure handling and report are identical. **See the correction below — this is insurance, not a prerequisite.** | None. **Deprecated:** once no caller uses the legacy pair, this block and the `-OUPath` / `-DomainName` parameters can be removed from this action. Every use is logged as a `Warn:` so remaining callers are visible in the transcript. |
| S-17 | 2026-07-28 | `GenerateReportPKI-v2`; new `Format-HtmlTable`; `Get-AllAdmin-Accounts` subject line | Rebuilt the report for a **management** audience and made data-quality visible: (a) **per-domain sections** driven by the **scope map, not the returned data**, with an executive summary and a per-domain summary table carrying a plain-language status; (b) **query failures rendered onto the report** — a leading banner, a per-domain PARTIAL-list warning, `NOT READ` flags in the scope list, and an **`[INCOMPLETE]` subject-line prefix**; duplicate failures (one per sweep) collapsed; (c) added the **Account state** column and friendly headers; booleans **projected** to text before `ConvertTo-Html` so colouring is unambiguous; (d) all styling **inline** via the new `Format-HtmlTable` helper; (e) writes to the Debug folder, creating it if absent, and **overwrites instead of appending**. | The single merged table could not answer the actual management question — *which domain is worst?* — and forced the reader to infer a row's domain from its UPN suffix. More seriously, **a failed OU produces no rows, which reads exactly like a compliant OU**; the people who act on this report read the email, not the Orchestrator transcript, so an unread OU has to be visible on the report itself. Appending grew `PKI_result.html` without bound across scheduled runs. | Requires redeploying the updated `cvs_functions.ps1`. **The emailed report changes shape** — brief the recipients before the first scheduled run. Subject line gains an `[INCOMPLETE]` prefix on degraded runs; any inbox rule matching the subject must be reviewed. `GenerateReportPKI` (v1) becomes uncalled — retained as reference, marked SUPERSEDED. |

### S-16 detail — where the scope comes from

`Resolve-DomainOUsMap` accepts the scope from either source, and **the file wins** if
both are supplied (logged, not silent):

| Source | Parameter | Used by |
|---|---|---|
| Inline JSON | `-DomainOUs` | **Orchestrator** — invokes a pre-staged script, has no staging step |
| JSON file | `-DomainOUsFile` | Legacy Ansible — `win_copy` wrote `domain_ous.json` to a temp dir |

The legacy file path is deliberately **kept working** so the existing playbook could
run unchanged against the merged script if it were ever pointed at one.

### S-18 → S-21 — the legacy fallback, added then removed

Recorded in full because the reasoning matters more than the code did.

**S-18 (2026-07-28)** added a fallback promoting a legacy `-DomainName` + `-OUPath`
pair to a one-entry map, justified as stopping a live Ansible template from breaking
when the merged script was copied to "the" PowerShell host.

**That justification was wrong.** Orchestrator uses a PowerShell host **separate from
the Ansible templates — in development *and* in production** (§1A-i). Deploying the
merged script cannot reach, overwrite or break any Ansible job. The break S-18
protected against was never possible.

**S-21 (2026-07-29)** therefore removes it. Two reasons, and the second is the
stronger one:

1. **No caller can reach it.** With the estates permanently separate, nothing invokes
   `Get-AllAdmin-Accounts` the legacy way in either environment.
2. **It was a silent alternate path, not just dead code.** `$DomainName` is a *shared*
   script parameter used by several other actions. A hand-run — or any future caller —
   that set `-DomainName` / `-OUPath` but omitted `-DomainOUs` would have quietly
   produced a report covering **one OU**, and reported **success**, instead of failing
   and naming what was missing. That is precisely the silent-narrowing failure mode
   this whole deliverable exists to eliminate; keeping a convenience path that can
   cause it contradicts every other guard in the action.

**What did NOT change:** the `-OUPath` and `-DomainName` **parameters remain in the
param block**. `Get-ServiceAccountExpiration` is a live action in the `ValidateSet`
and reaches `$OUPath` through `Get-ListOfUsers`; removing the parameters would break
it. Only `Get-AllAdmin-Accounts`' use of them is gone. Tests assert both halves — that
the fallback is absent, and that the parameters survive.

**Guarding against reintroduction:** the regression suite asserts against the
**shipping switch-case source**, not just behaviour. A behavioural test alone would
not catch the fallback coming back, because a reinstated fallback only fires on inputs
a passing test never supplies.

**Failure-handling contract after S-16 … S-17:**

| Condition | Behaviour |
|---|---|
| ActiveDirectory module missing | **`throw`** → OOTB *Invoke a PowerShell script* catch → **Failed** end state |
| Scope empty, unreadable or not valid JSON | **`throw`** → **Failed** end state |
| One domain/OU cannot be queried | `Error:` line → **Completed with Errors**; remaining OUs still swept; report **still sent**, marked `[INCOMPLETE]`, with the failure **classified** (S-20) so the reader knows whether it is a targeting fault or an availability one |
| Scope valid but holds no accounts | `Warn:` → **success**; empty report sent **with** its scope footnote |
| Report file cannot be written | `Warn:` → the report is still emailed |

Note the deliberate asymmetry: a **scope** problem fails the run outright (nothing
can be trusted), whereas a **per-OU** problem completes with errors and still
delivers a report that says which OUs are missing.

### S-17 detail — two silent-failure defects found by the regression suite

Both were introduced during this change and caught before delivery. They are recorded
because both are the *same class of fault this deliverable exists to eliminate* — a
non-terminating error that removes content while the run still reports success.

| Defect | Symptom | Fix |
|---|---|---|
| `Format-HtmlTable` declared `[string] $Fragment`, but `ConvertTo-Html -Fragment` emits `Object[]` | Parameter binding raised a **non-terminating** "Cannot convert value to type System.String". **Every styled table evaluated to nothing** — the report still sent and still looked well-formed, having quietly lost its content. | Parameter left **untyped**; the fragment is flattened inside the function. A regression check now fails the suite on **any** unexpected non-terminating error, since no content assertion would have caught this. |
| `Get-ListOfUsers-MultiDomain` declared `$DomainOUsMap` as `Mandatory=$true` | `Mandatory` **rejects `$null` at bind time**, making the function's own null guard unreachable dead code — it returned nothing without logging why. The test passed for the wrong reason. | `Mandatory=$false` + `[AllowNull()]` so the explicit guard actually runs and logs. |

---

## 2A. What the report does and does not cover

> **This is a required, customer-facing section.** The compliance figures carry
> assumptions that are not visible from the workflow inputs. Reproduce this list
> verbatim in `02_Design_Document` and `04_User_Guide` so no reader over-reads the
> numbers.

| # | Behaviour | Detail | Configurable? |
|---|---|---|---|
| 1 | **Scope is the OU list — nothing else** | Only the OUs in `domainOUs` are searched, at `SearchScope Subtree`. A privileged account outside those OUs is **not reported and not counted**. The report is only as good as the OU list. | Yes — via `domainOUs`. |
| 2 | **"Admin account" means "in an admin OU"** | The query is `Get-ADUser` over the OU. It applies **no** filter for privilege, group membership or naming. Anything that is a user object in those OUs is counted — including service accounts. | No — inherent to the design. |
| 3 | **Disabled accounts are counted** | A disabled account with `SmartcardLogonRequired = False` **is** included in the "Non-Compliance" figure. **Confirmed decision (2026-07-28): keep as-is** — this preserves the customer's existing metric. The **Account state** column (added by S-17) makes the composition visible, and the disabled subtotal is written to the transcript. | No — deliberate. Revisit only as an explicit metric change. |
| 4 | **No exemption mechanism** | An account that is legitimately exempt from smart card enforcement (typically a service account) is reported as non-compliant on **every** run. There is no allow-list. **Open item — see §5.** | No — not implemented. |
| 5 | **Two sweeps per OU, not one** | Each OU is queried twice (`-eq $true`, then `-eq $false`). An account whose attribute is **not set at all** may be absent from both sweeps and therefore from the report entirely. Inherited from the original script and preserved. | No — matches original. |
| 6 | **Unread OUs are excluded from every figure** | A failed OU contributes no rows. The totals are a **floor, not a total** — which is precisely why S-17 surfaces failures on the report and prefixes the subject. | No — by design. |
| 7 | **Read-only, always** | The action only runs `Get-ADUser`. It cannot create, modify or disable anything. There is no `whatIf` gate because there is nothing to gate. | No — by design. |
| 8 | **Searches are FULLY RECURSIVE** | Every AD query uses `-SearchScope Subtree`, which returns the search base **and every descendant at any depth** — not just immediate children. (The alternatives are `Base`, the object only, and `OneLevel`, immediate children only.) Listing one OU therefore covers everything beneath it. This is inherited from the original script and preserved. | No — matches original. |
| 9 | **Overlapping OUs are de-duplicated** | A direct consequence of #8: listing both a parent OU **and** one of its descendants means the deeper accounts are returned by **both** searches. **Each account is counted and listed exactly once** (S-19, `Remove-DuplicateAccounts`), under the deepest OU that returned it, so the figures are correct regardless of how the OU list is written. An informational notice on the report names what was collapsed, and the build action separately warns about nesting it can see in the DNs. Neither removes an OU from the list — which of a nested pair is redundant is the operator's call. | The de-duplication is automatic and not configurable. Tidy `domainOUs` to make the notice go away. |

### 2A-i. `Set-L3-Admin-Accounts` — an unreachable case, deliberately left unreachable

`Main` contains a `Set-L3-Admin-Accounts` case that performs a **mass write**:

```powershell
Get-AdUser -Identity $($user) | Set-AdUser -SmartcardLogonRequired $True
```

It is **absent from the `-Action` `ValidateSet`**, so the parameter is rejected before
`Main` dispatches and the case can never execute. **This omission is the only thing
preventing an unattended mass write across the admin OUs**, and it is easily mistaken
for an oversight — syncing the `ValidateSet` to the `switch` "for tidiness" would arm
it silently.

**Recorded here so the omission is understood as deliberate.** Do not add
`Set-L3-Admin-Accounts` (or `Get-Users-SCenable`, unreachable for the same reason) to
the `ValidateSet` without a separate, reviewed change. No code change made.

---

## 3. Changes to the automation process (Ansible → Orchestrator)

| # | Date | Area | Current process (Ansible) | New process (Orchestrator) | Reason |
|---|------|------|---------------------------|----------------------------|--------|
| P-20 | 2026-07-28 | Execution engine | `admin_accounts_report-v2.yml` stages the script folder with `win_copy` over WinRM and runs it with `win_command` | Workflow **Get-AdminAccountsReport** calls the **pre-staged** `cvs_functions.ps1` via the OOTB *"Invoke a PowerShell script"* over the PowerShell plug-in (WinRM/HTTPS/Kerberos) from a single PS host | Replace Ansible with Orchestrator while reusing proven script logic; eliminates per-run script staging |
| P-21 | 2026-07-28 | **Script lineage** | Two divergent copies: `cvs_functions.ps1` (hardened, single-domain report) and `cvs_functions-v2.ps1` (multi-domain report, no hardening) | **One** shared toolbox. The fork's capability is merged in (S-16 / S-17); **`cvs_functions-v2.ps1` is retired** and remains only in the as-received source archive | The fork was the only source of the multi-domain report but lacked every S-1 … S-15 resilience change and three later actions. Maintaining two copies of a shared toolbox is untenable and violates the two-working-copies rule |

### P-21 detail — retiring the fork in the right ORDER

Retirement happens in two separate places, and **only the first is safe now**:

| # | Where | Status | Why |
|---|---|---|---|
| 1 | **Repo working copy** — `InProgress/psscript/files/cvs_functions-v2.ps1` | **DELETED 2026-07-29** | Verified before deleting: the merged mainline contains **every** function and **every** implemented switch case the fork had, and the copy under `Ansible Playbooks and Files - Sanitized/psscript/files/` is **byte-identical** (SHA256 `1DFD720C…CC51C3`), so it is fully recoverable. Leaving it created a real risk of someone staging the wrong file to the PS host — the two names differ by four characters. All surviving references are documentation, code comments, or the as-received `vars.txt` baseline; none is a live dependency. |
| 2 | **The ANSIBLE PowerShell host** — `…\ps_scripts\cvs_functions-v2.ps1` | **DO NOT DELETE YET** | **Two live Ansible job templates still invoke it by name on that host.** Deleting it there breaks them immediately. It must stay until those templates are cut over to the `Get-AdminAccountsReport` workflow and decommissioned. |
| 3 | **The Orchestrator PowerShell host** | **Nothing to do** | A **separate host** (§1A-i). Only the merged `cvs_functions.ps1` is staged there; the fork was never deployed to it. |

Because the two estates use **different PowerShell hosts**, deploying the merged
`cvs_functions.ps1` for Orchestrator cannot touch the Ansible host's copies at all.
Removal of the Ansible-side fork is therefore an **Ansible decommissioning task**,
sequenced after the last template naming it is retired — not a step in this
deliverable's deployment.
| P-22 | 2026-07-28 | **Scope delivery** | `var_DomainOUs` — a domain→OU **map** — rendered by `to_json` and `win_copy`d to `domain_ous.json`; passed as `-DomainOUsFile`. The legacy template instead passed `-DomainName` + a single `-OUPath` | Operator supplies a **flat list of OU distinguishedNames**, one per row. The **domain is DERIVED** from each DN's own `DC=` components; `buildAdminAccountsReportInvocation` groups the rows by derived domain and passes the JSON map **inline** as `-DomainOUs` | Orchestrator invokes a pre-staged script and has no staging step, so the file mechanism has no equivalent. A DN already contains its domain — asking for it separately is redundant data entry and, worse, something that can *disagree* with the DN beside it. A flat DN list also removes the single-vs-multi-domain distinction from the operator's hands entirely (see P-26). Rows rather than raw JSON keep the scope reviewable line-by-line in the request form and run history, and let the action reject a malformed entry with a pointed message instead of failing inside PowerShell. The `-DomainOUsFile` path is retained for the legacy playbook |
| P-26 | 2026-07-28 | **Job-template consolidation** | **Three** job templates: two multi-domain (`admin_accounts_report-v2.yml` → `cvs_functions-v2.ps1`, passing an OU map) and one single-OU (`admin_accounts_report.yml` → `cvs_functions.ps1`, passing `-DomainName` + `-OUPath`) | **One** workflow, `Get-AdminAccountsReport`, for all three. Scope differences are expressed purely as the contents of the `domainOUs` list | Single-domain and multi-domain were never different *operations* — only different scopes. With the domain derived per-DN (P-22), "does this report span domains?" falls out of the DNs supplied instead of being a mode the operator selects or a template they must pick between. One workflow, one report format, one place to change behaviour. Mirrors the R-1 consolidation in the Server Reboot Report deliverable |
| P-23 | 2026-07-28 | Variables / secrets | `vars` / `group_vars` | Workflow inputs with defaults set directly on each input (no Configuration Element); credentials via the PS host plug-in service account | Standard Orchestrator patterns; these values are static per environment, so self-contained inputs are preferred over a shared Config Element (same decision as P-8 / P-17) |
| P-24 | 2026-07-28 | **Report audience** | One flat table merging all domains; failures visible only in the Ansible console | **Sectioned by domain** with an executive summary and per-domain status; **failures rendered onto the report** and flagged in the subject line | The report is read by management, who cannot be expected to open Orchestrator to discover why a figure is wrong. A failed OU is indistinguishable from a compliant one unless the report says so |
| P-25 | 2026-07-28 | **Pre-delivery validation** | None — correctness was established by running against production AD | **Offline regression suite** (`lab/Run-AllTests.ps1`, 100 checks) covering the vRO action, the PowerShell functions and the JS→PowerShell escaping boundary. No AD, SMTP, PS host or vRO appliance required | The JSON → PowerShell-quoting → `ConvertFrom-Json` chain is the one place a quoting bug silently corrupts the report **scope**, and scope errors are invisible in the output. The suite loads the functions under test **out of the live files by AST**, so it cannot drift from shipping code. It caught both S-17 defects before delivery |

**Net result:** **3** job templates → **1** workflow (`Get-AdminAccountsReport`); the
invoked action (`Get-AllAdmin-Accounts`) already exists in the deployed script but is
substantially rewritten (**S-16**), its report rebuilt (**S-17**) and sectioned to OU
level with duplicate detection (**S-19**), and its legacy callers preserved
(**S-18**); the fork is retired (**P-21**). The shared
`parseScriptOutput` / `handlePSFailure` / OOTB *Invoke a PowerShell script* contract
is reused unchanged.

---

## 4. Current vs new — quick mapping

**Three job templates → one workflow (P-26):**

| Today (Ansible job template) | Script called | Scope passed as | New (Orchestrator workflow) |
|---|---|---|---|
| `admin_accounts_report-v2.yml` (×2 templates) | `cvs_functions-v2.ps1` | `-DomainOUsFile` (domain→OU map) | `Get-AdminAccountsReport` |
| `admin_accounts_report.yml` (×1 template) | `cvs_functions.ps1` | `-DomainName` + single `-OUPath` | `Get-AdminAccountsReport` |

All three become the same workflow run with a different `domainOUs` list. The
single-OU template is a list of one.

**Variable mapping:**

| Ansible var (`vars.txt`) | vRO workflow input | Script parameter |
|---|---|---|
| `var_DomainOUs` (7 domains × 2 OUs) | `domainOUs` — Array/string, **one OU DN per row**; domain derived from `DC=` | `-DomainOUs` (JSON map, built by the action) |
| `var_DomainName` + `var_OUPath` (legacy template) | folded into the same `domainOUs` list — one row | `-DomainOUs`. *(The legacy pair is no longer accepted by this action — S-21)* |
| — (`win_copy` to `domain_ous.json`) | *(no equivalent — passed inline, P-22)* | `-DomainOUsFile` (legacy path, retained) |
| `var_eMailReport` (`yes`) | `emailReport` (boolean) | `-eMailReport` |
| `var_SMTPServer` (`smtp.corp.local`) | `smtpServer` | `-SMTPServer` |
| `var_MailToString` | `mailTo` (Array/string, one address per element) | `-MailToString` |
| `var_MailCcString` | `mailCc` (Array/string, optional) | `-MailCcString` |
| `var_MailSubjectstring` | `mailSubject` | `-MailSubjectstring` |
| `var_ps_folder` / `var_ps_script_file` | folded into `scriptPath` | `& "<scriptPath>"` |
| `var_parameter_action` (`Get-AllAdmin-Accounts`) | fixed in the build action | `-Action 'Get-AllAdmin-Accounts'` |
| — | *(none — removed by S-16)* | ~~`-DomainName`~~ / ~~`-OUPath`~~ |

---

## 5. Outstanding / deferred

| Item | Status / note |
|---|---|
| **Report wording — "Not enforced"** | **Open — awaiting customer input.** Placeholder wording chosen during this transition. If the customer has established compliance language (e.g. "PKI exempt", "non-conformant"), the report should adopt it. Affects `GenerateReportPKI-v2` labels only; no logic change |
| **Service-account exemptions** | **Open — awaiting customer decision.** A service account sitting in an admin OU and legitimately exempt from smart card enforcement is reported as non-compliant on **every** run, with no way to mark it. Options: an allow-list input; a `Description` convention; or accept the recurring noise. Until resolved, expect a persistent non-compliance floor (§2A #4) |
| Excluding disabled accounts from the counts | **Closed 2026-07-28 — keep them in** (§2A #3). The Account state column now makes them visible without changing the metric |
| Per-account **Domain** column in the detail tables | **Closed** — superseded by S-17. Sectioning by domain conveys the same information without a redundant column |
| Legacy single-OU Ansible template breaking on deployment | **Closed 2026-07-29 — the risk does not exist.** Orchestrator development uses a **separate PowerShell host** from the Ansible templates (§1A-i), so deploying the merged script cannot reach or break any Ansible job. S-18 has been removed outright by **S-21** — see the S-18 → S-21 note in §2 |
| PRODUCTION PowerShell host topology | **Closed 2026-07-29 — production is completely separate too.** The Orchestrator and Ansible estates never share a PowerShell host, in development or production. Consequences: the S-18 fallback was removed (**S-21**); the merged `cvs_functions.ps1` never shares a folder with the Ansible copies, so the wrong-file-staged risk exists only on the Ansible side; and there is no deployment sequencing dependency between the two estates |
| **Confirm the real AD exception type names** | S-20 classifies on the exception **message** first-class, with the **type name** only as a corroborating hint, and every failure record now carries `ExceptionType` verbatim. `ADServerDownException` and `ADIdentityNotFoundException` are well established; the referral-specific type name is an **unverified hint** that costs nothing if wrong. **During lab validation, provoke each failure mode against real AD and record the observed type names**, then tighten the hint table. Message patterns are also **locale-sensitive** — a non-English DC would fall through to *Unclassified* (raw text still shown), which is the safe degradation but worth confirming |
| Referral chasing / Global Catalog as a mitigation | **Investigated, not adopted.** `Get-ADUser` is not believed to expose a referral-chasing switch (referral chasing sits at the `DirectorySearcher` / `LdapSessionOptions` layer). Querying a Global Catalog (`-Server <domain>:3268`) would let one query span the forest, but the GC holds only a **partial attribute set** and it is **not confirmed** that the smart-card attribute is in it — a silently wrong compliance answer is worse than a visible failure. **Do not adopt without testing.** The structural fix already in place is deriving the server from the DN (P-22), which removes the most common cause of referrals outright. Also note a referral is **deterministic** — a retry loop would never help |
| **`cvs_report_script.ps1` — a THIRD divergent toolbox copy** | **Out of scope, recorded so it is not a surprise.** 834 lines, used only by the VMware Disable SSH job. Also contains a `Get-AllAdmin-Accounts` case (single-domain, `-OUPath`) which is **not** reachable from any admin-report job template. Fold into the VMware Disable SSH transition; a full three-way consolidation map should be produced then |
| Nested OUs in `domainOUs` | **Closed 2026-07-28 by S-19** — overlapping OUs are de-duplicated automatically, so the figures are correct whatever the list contains (§2A #9). Two advisories remain (build-action warning, report notice) so the redundancy can be tidied. **Check the production 7×2 list for overlap during lab validation**: if any exists, expect the counts to drop on the first run — that is the correction landing, not a regression, and it should be explained to recipients before the first scheduled send |
| Workflow ID | **TBD** — assign on first save in vRO, then record it in `Get-AdminAccountsReport_spec.js` |
| `.package` export (`com.broadcom.pso.vcf.identity.ad.accounts.adminReport`) | Built from the action + workflow once the workflow is assembled in vRO. Depends on the Event Log package for `parseScriptOutput` |
| Customer documentation set (`01_Executive_Summary` … `05_Validation_and_Testing_Plan`) | **Pending.** §2A and §2A-i are required content for `02_Design_Document` and `04_User_Guide` |
| Lab validation against real AD | **Pending.** The offline suite (P-25) cannot cover the `Get-ADUser` queries, per-OU failure isolation against a genuinely unreachable DC, SMTP delivery, or Outlook rendering — all belong in `05_Validation_and_Testing_Plan` |
| `GenerateReportPKI` (v1) now uncalled | Retained and marked **SUPERSEDED** in-line, as the reference for the pre-transition single-domain report shape. Do not extend it |
| Accounts with `SmartcardLogonRequired` unset | Potentially absent from both sweeps and therefore from the report (§2A #5). Inherited behaviour, preserved deliberately. Worth confirming against real AD during lab validation |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-07-28 | Automation transition | Initial register. Script changes **S-16** (multi-domain `Get-AllAdmin-Accounts` merged in from the retired `cvs_functions-v2.ps1` fork; new `Resolve-DomainOUsMap` and `Get-ListOfUsers-MultiDomain`; inline-scope, malformed-JSON, hashtable-fallback and silent-partial-sweep defects fixed; AD-module and zero-scope guards now throw) and **S-17** (report rebuilt into per-domain sections with an executive summary; query failures surfaced on the report and in the subject line; Account state column; inline styling via new `Format-HtmlTable`; overwrite instead of append). Process changes **P-20 … P-25** (Ansible→Orchestrator; fork retired onto the single shared toolbox; scope delivered inline from `domain\|OU` form rows; inputs with direct defaults; management-oriented report; offline regression suite). Code: `buildAdminAccountsReportInvocation` action + `Get-AdminAccountsReport` workflow spec + `lab/` regression suite (100 checks). Documented the deliberately-unreachable `Set-L3-Admin-Accounts` mass-write case (§2A-i). Open items: report wording and service-account exemptions. |
| 2026-07-28 | Automation transition | **Input model revised** after confirming the live job templates: `domainOUs` is now a **flat list of OU distinguishedNames** with the domain **derived** from each DN's `DC=` components, rather than `domain\|OU` pairs (**P-22** rewritten). Added **P-26** — the **three** admin-report job templates (two multi-domain on the fork, one single-OU on the mainline) consolidate onto the single `Get-AdminAccountsReport` workflow, since single- and multi-domain differ only in the DNs supplied. Added **S-18**, the legacy `-DomainName` / `-OUPath` fallback that keeps the single-OU Ansible template working against the merged script through parallel run — this removes the breaking change previously recorded against S-16. Added §2A #8 (nested OUs double-count at Subtree scope; the action warns) and the job-template→script map in §1A. Recorded `cvs_report_script.ps1` as a third divergent toolbox copy, out of scope. Regression suite updated and extended to **115 checks**. |
| 2026-07-28 | Automation transition | Added **S-19**: the report now **sub-sections by OU** within each domain that has more than one OU in scope (a single-OU domain is left un-sub-sectioned), and **detects duplicated accounts**, naming them and reporting the true distinct total alongside the inflated one. Table rendering extracted to `Format-PKIAccountTable`. **Verified and documented that all AD queries use `-SearchScope Subtree`, which is FULLY RECURSIVE** — §2A split into #8 (recursion, inherited) and #9 (overlapping OUs double-count, the consequence). Fixed a defect found by the new tests: `SourceOU` was dropped by the report's projection, so every OU bucket resolved empty — the same silent-content class as the S-17 defects, and it also made a duplicate-banner assertion pass for the wrong reason. Added the same load/error guards to `lab/New-SampleReport.ps1`. Regression suite extended to **134 checks**. |
| 2026-07-28 | Automation transition | **S-19 revised from *detect* to *de-duplicate*.** New idempotent `Remove-DuplicateAccounts` collapses an account returned by several OU searches to a single entry, kept under the deepest OU that returned it. Called from the action **before the counts are taken**, so the subject line and report body cannot disagree, and again defensively inside the report so any caller gets a correct result. The recursive `SearchScope Subtree` query is **deliberately left unchanged** — the customer's OU list targets a directory that cannot be inspected from here, so narrowing scope risks silently dropping in-scope accounts; correcting the outcome is safe, changing the query is not. The report's alert is downgraded from "FIGURES ARE INFLATED" to an informational "totals are correct" notice, and the log line from `Error:` to `Warn:` — an `Error:` would flip `parseScriptOutput` to `success=false` and route the run to *Completed with Errors*, which would now be wrong. §2A #9 rewritten. Regression suite extended to **144 checks**. |
| 2026-07-29 | Automation transition | Added **S-20**: failed OU queries are now **classified** (Scope error / Access denied / Authentication / Unreachable / Unclassified) with per-category remediation guidance rendered on the report, a category breakdown in the banner, and the category named in the per-OU note. Prompted by the question of what "a referral was returned" actually means: a referral is the server **answering** to say the naming context is not its own — a deterministic **targeting** fault, categorically different from an unreachable DC, and not something a retry can help. Classification matches on the exception **message** with the **type name** as a corroborating hint only; unrecognised failures degrade to *Unclassified* with the raw text intact rather than being mislabelled, and `ExceptionType` is recorded verbatim so the real type names can be **observed** in lab validation instead of guessed. Recorded referral-chasing / Global Catalog as investigated-but-not-adopted, with the reasoning. Regression suite extended to **170 checks**. |
| 2026-07-29 | Automation transition | **Correction — separate environments.** The PowerShell host used for Orchestrator development is **not** the host the Ansible job templates run against; they are entirely separate environments. Added **§1A-i** stating this explicitly. This **invalidates the original justification for S-18**, which claimed the fallback was needed to stop the merged script breaking a live Ansible template on deployment — deployment cannot reach that host, so no such break was possible and there is **no deployment prerequisite** to coordinate. S-18 is **retained on revised grounds** (low-cost insurance for a shared toolbox, should the estates ever consolidate) and re-documented as such in §2, the script comment and the workflow spec; it is no longer presented as protecting against a real break. Also corrected: "parallel run" is environmental rather than file-level; the P-21 removal table now distinguishes the **Ansible** host (fork must stay until its templates retire) from the **Orchestrator** host (fork was never deployed there). New §5 item: confirm the **production** PS host topology, which decides whether S-18 and the `-OUPath` / `-DomainName` parameters can be dropped entirely. No code behaviour change. |
| 2026-07-29 | Automation transition | **Production confirmed separate too** — the Orchestrator and Ansible estates never share a PowerShell host at any stage. Closed the §5 topology item and added **S-21: the S-18 legacy fallback is REMOVED**. The OU map is now the only way to scope `Get-AllAdmin-Accounts`; no map throws. Removal was justified not only by the fallback being unreachable but by it being a **silent alternate path** — `$DomainName` is a shared script parameter, so a caller setting `-DomainName`/`-OUPath` while omitting `-DomainOUs` would have quietly produced a **single-OU** report and reported success. The `-OUPath` / `-DomainName` **parameters remain** for `Get-ServiceAccountExpiration`, which genuinely uses them. Tests rewritten to assert against the **shipping switch-case source** (a behavioural test cannot catch a reinstated fallback, since it only fires on inputs a passing test never supplies) and to assert the parameters survive. Register, script comment and workflow spec all corrected. |

