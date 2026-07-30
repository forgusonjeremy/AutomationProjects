# Validation & Testing Plan — Admin Accounts Report

> Scope: `Get-AdminAccountsReport` only. Shared items (`parseScriptOutput`, the OOTB
> *Invoke a PowerShell script* workflow, PS host build) are referenced, not re-tested.
>
> **The workflow is read-only** — it cannot modify Active Directory. Testing carries
> no risk to directory objects. The only write activity is the **lab seeder**, which
> creates test accounts and must be run against a **lab domain only**.

---

## Phase A — Environment pre-checks (before deploying vRO content)

| ID | Check | Expected / action |
|---|---|---|
| **A1** | PS host registered in vRO; smoke test (`Invoke a PowerShell script` + `Write-Host`) passes | Visible in Inventory → PowerShell |
| **A2** | `PowerShellRemotePSObject.getRootObject()` callable | `parseScriptOutput` depends on it exclusively |
| **A3** | Action value `Get-AllAdmin-Accounts` present in the script `ValidateSet` | Confirmed in the deployed `cvs_functions.ps1` |
| **A4** | Script params `-DomainOUs`, `-DomainOUsFile`, `-eMailReport`, `-SMTPServer`, `-MailToString`, `-MailCcString`, `-MailSubjectstring` present | Confirmed in the deployed param block |
| **A5** | **S-16 … S-20 present on the deployed script** | `Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch -Pattern 'Resolve-DomainOUsMap','Get-ListOfUsers-MultiDomain','GenerateReportPKI-v2','Remove-DuplicateAccounts','Get-ADFailureCategory','Format-PKIAccountTable'` → **all six** match |
| **A6** | **S-21 applied — legacy fallback ABSENT** | `Select-String … -Pattern 'LEGACY single-domain mode'` → **no match**. A match means an older copy: a run with no OU map could silently produce a single-OU report |
| **A7** | Script parses cleanly on the host | `[System.Management.Automation.Language.Parser]::ParseFile(...)` → no errors |
| **A8** | RSAT ActiveDirectory module on PS host | `Get-Module -ListAvailable ActiveDirectory` lists it |
| **A9** | LDAP reachability to **every** domain in scope | `Get-ADDomain -Server <domain>` succeeds for each |
| **A10** | Service account can read **every** OU in scope | `Get-ADUser -Server <domain> -SearchBase '<OU DN>' -Filter * -ResultSetSize 1` succeeds for each |
| **A11** | Kerberos constrained delegation (double-hop) configured | Otherwise LDAP queries surface as *Access denied* / *Authentication* |
| **A12** | SMTP relay reachable and accepts mail from the host | `Test-NetConnection <smtp> -Port 25`; send a test message |
| **A13** | **Production OU list contains no overlapping (nested) entries** | Compare the 7×2 list pairwise. If any OU is an ancestor of another, expect the de-duplication notice and a **lower** count than the Ansible report |

---

## Phase B — vRO content deployment checks

| ID | Check | Expected |
|---|---|---|
| **B1** | Action `buildAdminAccountsReportInvocation` deployed | Module `com.broadcom.pso.vcf.identity.ad.accounts.adminReport`; return type **string** |
| **B2** | Action input **order** matches the workflow's positional call | `scriptPath, domainOUs, emailReport, smtpServer, mailTo, mailCc, mailSubject` |
| **B3** | Action `parseScriptOutput` present (shared, Event Log package) | Return type Properties |
| **B4** | Workflow `Get-AdminAccountsReport` deployed | Folder `Production > Identity > Active Directory > Reporting` |
| **B5** | `host` is a pre-bound **attribute**, not an input | No `psHost` on the form |
| **B6** | `mailTo` / `mailCc` typed **Array/string** | Not plain string |
| **B7** | Input defaults set **directly on each input** — no Configuration Element | All except `mailCc` have a default |
| **B8** | Scriptable tasks pasted verbatim from the spec | Especially **item6**, which derives domains from DNs |
| **B9** | Catch path bound: PS link → `err_0` → Throw Error → End | Failure routes to a **FAILED** end state |
| **B10** | Decision body is `return parsedResult.success;` | — |
| **B11** | Workflow ID recorded in the spec header | `(TBD …)` replaced |

---

## Phase C — Offline regression suite (no infrastructure)

Run before any lab work. Fails here mean the content is wrong regardless of environment.

```powershell
cd '<repo>\InProgress\psscript\Admin Accounts Report\lab'
.\Run-AllTests.ps1
```

| ID | Suite | Expected |
|---|---|---|
| **C1** | vRO action (JavaScript) | 51 checks pass |
| **C2** | PowerShell functions | 110 checks pass |
| **C3** | JS → PowerShell boundary | 16 checks pass |
| **C4** | Workflow scriptable tasks | 14 checks pass |
| **C5** | **Total** | **191 / 191, exit code 0** |

Covers: domain derivation, OU grouping and de-duplication, every validation failure
path, exact round-trip of awkward DNs through the JSON → PowerShell → `ConvertFrom-Json`
chain, report structure and colouring, failure classification, and an ES5/Rhino
compatibility guard.

**Not covered** — everything below in Phases D–G.

---

## Phase D — Lab data seeding

```powershell
.\New-AdminAccountTestData.ps1 -Domain <lab domain> -WhatIf   # preview
.\New-AdminAccountTestData.ps1 -Domain <lab domain>           # create
```

| ID | Check | Expected |
|---|---|---|
| **D1** | `-WhatIf` preview lists OUs and accounts, creates nothing | Directory unchanged |
| **D2** | Create run completes | OUs and **7** accounts created — 3 compliant, 4 non-compliant, of which 1 disabled. (**8** with `-IncludeNestedOU`, the extra one compliant, used in Phase G) |
| **D3** | Seeder prints the `domainOUs` list and expected figures | Recorded for Phase E |
| **D4** | Re-run is idempotent | No errors; states re-applied |

---

## Phase E — Functional tests (lab, real AD)

Use the seeder's printed `domainOUs` list and compare against its printed figures.

| ID | Test | Expected |
|---|---|---|
| **E1** | Run with the seeded 2-OU scope, `emailReport = true` | Report emailed; **Success** end state; counts match the seeder exactly |
| **E2** | Subject line | `Report: Admin PKI Card Status ( <N> Non-Compliance - <M> Compliance )`, no `[INCOMPLETE]` |
| **E3** | Report structure | Summary → By domain → per-domain section → **per-OU sub-sections** (2 OUs in one domain) → Scope footnote |
| **E4** | Non-compliant accounts | `lab.adm.gap`, `lab.svc.backup`, `lab.adm.leaver`, `lab.adm.petrova` shown with red **False** |
| **E5** | **Disabled account** | `lab.adm.leaver` shows **Disabled** and **is included** in the non-compliance count |
| **E6** | Compliant accounts | Shown `True`, not reddened |
| **E7** | Scope footnote | Lists both seeded OUs |
| **E8** | `emailReport = false` | No mail; report still in run log and at `<Debug>\PKI_result.html` on the host |
| **E9** | Report file overwritten, not appended | File size stable across two runs |
| **E10** | Single-OU run (one row) | Works with no special handling; **no** per-OU sub-sections |
| **E11** | Outlook rendering | Tables, colours and sections render correctly in Outlook, not just a browser |

---

## Phase F — Failure-path tests (lab)

The most important phase: these paths previously produced a clean-looking but wrong report.

| ID | Test | Expected |
|---|---|---|
| **F1** | Add a bogus OU DN (`OU=Does Not Exist,…`) | Subject prefixed **`[INCOMPLETE]`**; red banner; OU classified **Scope error**; guidance shown; run ends **Completed with Errors**; other OUs still reported |
| **F2** | Point an OU at the wrong domain via the `server\|OU` override | Referral → classified **Scope error**, not *Unreachable* |
| **F3** | Stop/block a DC for one domain, re-run | Classified **Unreachable**; other domains still reported |
| **F4** | Remove service-account read rights on one OU | Classified **Access denied** |
| **F5** | **Record the observed exception TYPE names** from F1–F4 | Compare with `Get-ADFailureCategory`'s hint table; tighten if they differ. Each failure record carries `ExceptionType` verbatim for this purpose |
| **F6** | Scope with **no** OU rows | Run **fails** with "requires a domain/OU map" — no empty report sent |
| **F7** | Rename `cvs_functions.ps1` on the host and run | Catch path → **Failed** end state |
| **F8** | Stop the AD Web Services / remove RSAT, run | Script throws → **Failed**, not a silent empty report |
| **F9** | Unreachable SMTP relay with `emailReport = true` | Report still produced and logged; mail failure logged as `Error:` |
| **F10** | **Non-English DC** (if any exist in the estate) | Failure falls through to **Unclassified** with raw text — safe degradation. If common, extend the message patterns |

---

## Phase G — De-duplication and scope-overlap tests (lab)

| ID | Test | Expected |
|---|---|---|
| **G1** | Seed with `-IncludeNestedOU`; list **parent and nested OU** | Amber **"overlapping OU list"** notice; account counted **once**; listed under the **nested** OU; totals correct |
| **G2** | Subject line for G1 | **No** `[INCOMPLETE]` prefix — the run succeeded; the OU list is redundant, not broken |
| **G3** | Remove the nested OU from the list, re-run | Notice disappears; totals unchanged |
| **G4** | Pre-run warning | The action logs a nesting warning in the workflow log before execution |
| **G5** | Verify against the directory | Distinct account count in the report matches a manual `Get-ADUser` count over the same scope |

---

## Phase H — Comparison against the current Ansible report (parallel run)

The estates use **separate PowerShell hosts**, so both can run against the same
directory simultaneously with no interference. Compare on **output**.

| ID | Test | Expected |
|---|---|---|
| **H1** | Run the Ansible template and the vRO workflow over the same production scope | Same account population |
| **H2** | Compare counts | Identical **unless** the OU list overlaps — then the vRO figure is **lower and correct** (A13). Reconcile the difference explicitly |
| **H3** | Compare account lists | Same accounts; vRO adds the **Account state** column and per-domain/per-OU sectioning |
| **H4** | Confirm no Ansible job is affected by the deployment | Ansible templates unchanged and running normally |

---

## Phase I — Operational readiness

| ID | Check | Expected |
|---|---|---|
| **I1** | Schedule created at the agreed cadence | Runs unattended |
| **I2** | Scheduled run produces the same result as a manual run | — |
| **I3** | Recipients briefed on the new format, the `[INCOMPLETE]` prefix and possible count change | Sign-off recorded |
| **I4** | Run log readable — `setLogMarker` and execution context present | Context reads e.g. `7 domain(s), 14 OU(s): …` |
| **I5** | Debug folder secured on the PS host | Report contains privileged account names |
| **I6** | Mail distribution list reviewed | The report enumerates privileged accounts lacking smart-card enforcement — restrict accordingly |

---

## Phase J — Cleanup

| ID | Action |
|---|---|
| **J1** | `.\New-AdminAccountTestData.ps1 -Domain <lab domain> -Remove` |
| **J2** | Confirm only marker-tagged objects were removed and no OU was dropped while holding foreign objects |
| **J3** | Promote `cvs_functions.ps1` to `Completed/_Shared References/psscript/files/` and update the lab suite's script path |

---

## Exit criteria

- Phases A–C pass in full.
- Phases E, F and G pass in the lab, with F5's observed exception type names recorded.
- Phase H reconciled — any count difference explained, not merely observed.
- Phase I complete, including recipient briefing.
- Open items (report wording, service-account exemptions) either resolved or formally
  accepted as outstanding.
