# Validation & Testing Plan — Service Account Expiration Reporting

**Workflow:** `Get-ServiceAccountExpirationReport`
**Script action:** `Get-ServiceAccountExpiration` (S-22 / S-23)

Phases A–C need no infrastructure. D–H need a lab directory. I–J are readiness and
cleanup. Record pass/fail and the observed value for every check — several of these exist
to capture facts that were previously guessed at.

---

## Phase A — Environment pre-checks (before deploying vRO content)

| # | Check | Command / method | Expected |
|---|---|---|---|
| A1 | PS host reachable from vRO | vRO **Inventory → PowerShell** | Host listed, no error |
| A2 | ActiveDirectory module present | `Get-Module -ListAvailable ActiveDirectory` | Module returned |
| A3 | Each domain in scope answers | `Get-ADDomain -Server <domain>` | Succeeds for every domain |
| A4 | Read rights on every OU | `Get-ADUser -Server <d> -SearchBase '<OU DN>' -Filter * -ResultSetSize 1` | Succeeds for every OU |
| A5 | SMTP relay reachable | `Test-NetConnection <smtp> -Port 25` | `TcpTestSucceeded : True` |
| A6 | Script staged and parses | Parse check from Implementation Guide §2 | `parse OK` |
| A7 | Required functions present | `Select-String` block, Implementation Guide §2 | All six match |
| A8 | **Silent-defect guards** | The two `Select-String` checks, Implementation Guide §2 | **Both return nothing** |
| A9 | Debug folder writable | `New-Item -ItemType Directory -Path 'C:\PSO\Scripts\Debug' -Force` | Created or already exists |

> **A8 is the one to not skip.** Both defects it guards against produce a plausible,
> well-formed report. A run cannot tell you they are back.

---

## Phase B — vRO content deployment checks

| # | Check | Expected |
|---|---|---|
| B1 | `parseScriptOutput` action present | Found in `…guestOps.files.windows.logs` |
| B2 | OOTB *Invoke a PowerShell script* present | Found in the library |
| B3 | Build action created with **8 inputs in the documented order** | `expiringWithinDays` is **position 3**, not last |
| B4 | Action return type is `string` | Confirmed |
| B5 | Workflow schema matches the spec | 8 elements + 3 end states |
| B6 | `host` attribute bound to the correct PS host | Correct host, correct environment |
| B7 | `mailTo` / `mailCc` are Array/string | Confirmed |
| B8 | Scriptable task code pasted verbatim | No `let`, `const` or arrow functions |
| B9 | item6 wired to **both** `domainOUs` and `expiringWithinDays` | Both bound |
| B10 | Workflow ID recorded in the spec file | `(TBD…)` replaced |

---

## Phase C — Offline regression suite (no infrastructure)

```powershell
cd '<repo>\InProgress\Service Account Expiration Reporting\lab'
.\Run-AllTests.ps1
```

| # | Check | Expected |
|---|---|---|
| C1 | All suites pass | `ALL 256 CHECKS PASSED` |
| C2 | Suite runs against the **deployed** script | Re-run with `-ScriptPath '<staged copy>'` — still passes |
| C3 | Sample reports render | `.\New-SampleReport.ps1` writes four HTML files |
| C4 | Format reviewed and accepted | Stakeholder sign-off on `Sample-Report-Clean.html` before any recipient sees it |

> C2 matters: the suite defaults to the repo working copy. Pointing it at the staged file
> proves what is *deployed* is what was tested.

---

## Phase D — Lab data seeding

```powershell
.\New-ServiceAccountTestData.ps1 -Domain <lab domain> -WhatIf          # preview first
.\New-ServiceAccountTestData.ps1 -Domain <lab domain> -IncludeNestedOU
```

| # | Check | Expected |
|---|---|---|
| D1 | `-WhatIf` previews without changing anything | Full plan printed, no objects created |
| D2 | Seeding completes | OUs and 11 accounts created |
| D3 | Script prints the `domainOUs` rows | Full DNs, ready to paste |
| D4 | Script prints the expected figures | Recorded for use in Phase E |
| D5 | A bad `-OUPath` is reported clearly | Re-run with a nonexistent parent → `FATAL: the -OUPath parent does not exist` |

**Additionally, by hand:** set `SmartcardLogonRequired = $true` on **one** seeded account.
This is the account that proves defect 1 is fixed, and it is used in Phase E and Phase H.

```powershell
Set-ADUser -Server <lab domain> -Identity lab-svc-far -SmartcardLogonRequired $true
```

---

## Phase E — Functional tests (lab, real AD)

Run the workflow with the seeded scope and `expiringWithinDays = 30`.

| # | Check | Expected |
|---|---|---|
| E1 | Workflow completes successfully | Green, *Log Success* branch |
| E2 | Email received | HTML, correct recipients |
| E3 | Counts match the seeder's printed figures | Exact match on in-scope / expired / expiring / no-expiry |
| E4 | Subject carries the counts | `( N expired - M expiring within 30 days )` |
| E5 | **`Expires on` column is populated** | Real dates — the defect-2 fix |
| E6 | **The smartcard-required account APPEARS** | `lab-svc-far` is listed — **the defect-1 fix** |
| E7 | `lab-svc-nopassword` shows **"Never set"** | In red, in both password columns |
| E8 | …and sorts to the **top** of its group | Not the bottom — the defect-3 fix |
| E9 | **No blank row anywhere** | The defect-4 fix |
| E10 | `lab-svc-disabled` shown as Disabled **and still counted** as expired | Both true |
| E11 | `lab-svc-outside-31` is in the inventory but **not** in *Expiring* | Correct at a 30-day window |
| E12 | Re-run with `expiringWithinDays = 31` → it moves into *Expiring* | Boundary behaves as documented |
| E13 | Re-run with `expiringWithinDays = 0` → only same-day expiries flagged | Full inventory still listed |
| E14 | Scope footnote lists exactly the OUs supplied | Match |
| E15 | Report written to the Debug folder | `ServiceAccountExpiration_result.html` present |
| E16 | Run twice — **file does not grow** | Overwritten, not appended |
| E17 | **Transcript contains no HTML** | Only a one-line summary; `Error:`/`Warn:` lines are readable |
| E18 | Renders correctly in **Outlook**, not just a browser | Tables styled, layout intact |
| E19 | Locked-out account shows **Locked out** | Provoke a lockout on `lab-svc-locked` first |

---

## Phase F — Failure-path tests (lab)

| # | Scenario | How to provoke | Expected |
|---|---|---|---|
| F1 | Bad OU DN | Add `OU=Does Not Exist,DC=<lab>,DC=<tld>` to `domainOUs` | Run ends **Completed with Errors**; report **still sent**; `[INCOMPLETE]` prefix; failure classified **Scope error**; other OUs still reported |
| F2 | Unreachable DC | Point a row at a dead server via the `server\|DN` override | Classified **Unreachable**; other OUs unaffected |
| F3 | Access denied | Deny the PS host account read on one OU | Classified **Access denied** |
| F4 | **Record the real exception type names** | Note `ExceptionType` from the transcript for F1–F3 | **Recorded** — these were previously unverified hints; feed them back into `Get-ADFailureCategory` |
| F5 | No scope | Clear `domainOUs` | Action **fails the run**; no email |
| F6 | Row with no `DC=` | Enter `Service Accounts` | Action fails with a pointed message |
| F7 | Non-integer window | Enter `30.9` | Action rejects it before PowerShell is reached |
| F8 | AD module missing | Rename the module folder on a test host | Script **throws**; workflow **Failed**; no email |
| F9 | PS host unreachable | Stop WinRM | catch → *Throw Error* → **Failed** |
| F10 | SMTP unreachable | Point at a dead relay | `Error:` logged; run completes with errors; report still on disk |
| F11 | Empty but valid OU | Point at an empty OU | **Success**; empty report sent **with** the scope footnote |
| F12 | Bad recipient | Enter an address with no `@` | Action fails the run |

> **F4 is a deliverable, not just a check.** The failure classifier matches on message
> patterns with type names as unverified hints. This is the only opportunity to observe
> the real names. Also note whether the DC returns **non-English** messages — those fall
> through to *Unclassified*, which is safe but worth knowing.

---

## Phase G — Scope-overlap and de-duplication (lab)

Seeded with `-IncludeNestedOU`, supply **both** the parent and the sub-OU.

| # | Check | Expected |
|---|---|---|
| G1 | Amber "overlapping OU list" notice appears | Present, worded as informational |
| G2 | The nested account appears **once** | Not twice |
| G3 | It is listed under the **deepest** OU | `OU=Tier1,…` |
| G4 | Counts and subject line agree with the body | No discrepancy |
| G5 | Run classified **success**, not errors | Overlap is a `Warn:`, not an `Error:` |
| G6 | Removing the redundant row clears the notice | Notice gone, counts unchanged |
| G7 | Build action warns about nesting at submit time | Warning in the vRO log |

---

## Phase H — Comparison against the current Ansible report (parallel run)

Run both against the **same directory**, on their own PowerShell hosts, on the same day.

> **The two reports WILL NOT match, and that is the expected outcome.** The purpose of
> this phase is to confirm every difference is one of the four corrected defects — not to
> reconcile the numbers.

| # | Check | Expected |
|---|---|---|
| H1 | New report lists **more** accounts | Yes — defect 1 |
| H2 | **Enumerate the difference** | Every extra account has `SmartcardLogonRequired = $true`. Verify with `Get-ADUser -Filter {SmartcardLogonRequired -eq $true} -SearchBase '<OU>'` and confirm the two sets match exactly |
| H3 | No account present in the Ansible report is **missing** from the new one | Nothing lost |
| H4 | Ansible report has no expiration column; new one does | Defect 2 |
| H5 | Accounts showing password age `0` in Ansible show **"Never set"** in the new report | Defect 3 |
| H6 | Ansible report's blank row is absent | Defect 4 |
| H7 | Any other difference is **investigated and explained** before cutover | No unexplained deltas |

**H2 is the acceptance test for this deliverable.** If the extra accounts are *not* all
smartcard-required, the difference has another cause and must be understood before
cutover.

---

## Phase I — Operational readiness

| # | Check | Expected |
|---|---|---|
| I1 | Schedule created | Correct interval |
| I2 | **Window ≥ schedule interval** | Confirmed — otherwise an account can expire unwarned between runs |
| I3 | Recipients briefed: **the count will rise** | Communicated and acknowledged |
| I4 | Recipients briefed: **subject line changed** | Communicated |
| I5 | Inbox rules matching the old subject reviewed | Updated or retired |
| I6 | Run history shows the scope in the execution context | `N domain(s), M OU(s): … \| window Dd` |
| I7 | Failure routing understood by operations | Failed vs Completed-with-Errors vs Success |
| I8 | Escalation path for `[INCOMPLETE]` runs agreed | Who fixes a scope error vs an unreachable DC |
| I9 | Open items logged with the customer | Password expiry, exemptions, OU-list completeness |

---

## Phase J — Cleanup

| # | Action |
|---|---|
| J1 | `.\New-ServiceAccountTestData.ps1 -Domain <lab domain> -Remove` |
| J2 | Confirm only tagged objects were removed, and the OUs are gone |
| J3 | Remove lab entries from `domainOUs` in the production workflow |
| J4 | Delete lab report files from the PS host Debug folder |
| J5 | Promote `cvs_functions.ps1` to `Completed/_Shared References/` and update the lab suite's default path |

---

## Exit criteria

Sign-off requires **all** of:

1. Phases A–C pass, including **A8** (the silent-defect guards) and **C2** (the suite run
   against the *deployed* script).
2. Phase E passes, with **E6 explicitly demonstrated** — the smartcard-required account
   appears. This is the deliverable's headline fix and must be shown, not assumed.
3. Phase F passes, with **F4 recorded** — the real exception type names observed and fed
   back.
4. Phase G passes.
5. Phase H complete, with **H2 enumerated**: every additional account accounted for.
6. Phase I complete, with **I3 and I5 confirmed in writing** — recipients briefed on the
   rising count, and inbox rules reviewed.
7. Open items from the Change Register §5 logged with the customer.

**Blocking vs non-blocking:** items 1–3 and 5 are blocking. A failure in Phase G or a
deferred open item is not — but it must be recorded and communicated before the first
scheduled send.
