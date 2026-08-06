# Service Account Expiration Report — regression tests

Offline regression tests for the S-22 / S-23 script changes and the
`buildServiceAccountExpirationInvocation` vRO action. **No Active Directory, SMTP,
PowerShell host or vRO appliance is required** — every external dependency is
stubbed, so these run on a laptop.

## Running

One command, from this folder:

```powershell
.\Run-AllTests.ps1
```

That runs all four suites in the required order and prints a single summary
(**256 checks** at time of writing). Add `-KeepArtifacts` to keep the generated
files — including a rendered `Debug\ServiceAccountExpiration_result.html` — when you
want to see what a failing test actually produced.

Pass `-ScriptPath` if `cvs_functions.ps1` has moved (see [Paths](#paths) below).

## Seeing the report without a lab

To see the report itself rather than test output:

```powershell
.\New-SampleReport.ps1
```

which writes four rendered samples next to this file — open any in a browser:

| File | Shows |
|---|---|
| `Sample-Report-Clean.html` | Every OU read. Expired and expiring accounts lifted into their own sections above the inventory. |
| `Sample-Report-Incomplete.html` | Two OUs unreadable — the `[INCOMPLETE]` path, with each failure classified and given remediation guidance. |
| `Sample-Report-Duplicates.html` | An overlapping OU list (a parent and its sub-OU) — each account collapsed to one entry under the most specific OU, plus the explanatory notice. |
| `Sample-Report-NoFindings.html` | The quiet case — what a clean month looks like, and why it is not ambiguous with a failed run. |

These render for a **browser**. Outlook uses the Word engine, which is why every
style in the report is inline — confirming how it actually looks in Outlook is a
lab-validation step.

## Seeding a lab AD to run the workflow for real

`New-ServiceAccountTestData.ps1` creates the OU structure and accounts needed to
exercise **every** report behaviour, then prints the `domainOUs` rows to paste into
the workflow **and the figures the report should produce**, so a lab run can be
verified rather than eyeballed.

```powershell
.\New-ServiceAccountTestData.ps1 -Domain vcf.lab -WhatIf     # preview first
.\New-ServiceAccountTestData.ps1 -Domain vcf.lab             # create
.\New-ServiceAccountTestData.ps1 -Domain vcf.lab -IncludeNestedOU   # + de-dup demo
.\New-ServiceAccountTestData.ps1 -Domain vcf.lab -Remove     # clean up
```

**This writes to Active Directory — lab domains only.** Every object it creates is
tagged in its Description; `-Remove` deletes only tagged objects, and refuses to drop
the OUs if anything it did not create is still inside them.

What the seeded set covers: accounts expired long ago and expired recently; expiring
inside the window and just **outside** it (31 days, which must NOT be flagged at 30);
no expiry date at all; a **password that has never been set**; a disabled account that
is also expired; a locked-out account; and optionally a **nested OU** so the
de-duplication path can be exercised. The script also documents how to provoke the
`[INCOMPLETE]` path by adding a bogus OU DN.

One thing the seeder **cannot** do: back-date `pwdLastSet` to a chosen number of days.
That attribute is written by the directory when the password changes and has no
supported way to set it directly, so the *password age* column cannot be seeded to
specific values. The case that actually mattered — `pwdLastSet = 0` — **is** seeded,
via `-ChangePasswordAtLogon`.

`test-action.js` **T10** asserts the seeder's printed rows still feed the vRO action
correctly, so the two cannot drift apart.

<details>
<summary>Running the suites individually</summary>

```powershell
node .\test-action.js         # 72 checks  — the vRO action
.\Test-S22.ps1                # 130 checks — the PowerShell functions + the seeder guards
node .\gen-awkward.js         # generates the fixtures Test-Boundary executes
.\Test-Boundary.ps1           # 20 checks  — the JS -> PowerShell boundary
node .\test-workflow-tasks.js # 34 checks  — the workflow's scriptable tasks
```

Order matters: `test-action.js` and `gen-awkward.js` write the invocation strings that
`Test-Boundary.ps1` executes. All generated files (`invocation*.txt`, `stub_cvs.ps1`,
`Debug/`) are disposable.
</details>

**Requires** PowerShell 5.1+ (or 7) and Node.js. Node is used only to execute the vRO
action's JavaScript *as written*, so the file under test is the file that ships rather
than a translation of it.

## What each file covers

| File | Target | Covers |
|---|---|---|
| `Test-S22.ps1` | `ConvertFrom-ADFileTime`, `Get-AccountExpiryState`, `Sort-ServiceAccountRows`, `Get-ServiceAccountSectionNote`, `Format-ServiceAccountTable`, `GenerateReportServiceAccountExpiration` in `cvs_functions.ps1` | The FILETIME sentinels (`0` = never set, and the "never" maximum) and the local-vs-UTC basis; expiry classification including the window's inclusive edge and AD's 1601/9999 sentinels; worst-first ordering on numeric keys; report structure (exec summary, action sections, per-domain sections, per-OU sub-sections, in-scope-but-empty OUs); failure surfacing (banner, category breakdown, per-domain PARTIAL warnings, NOT READ scope flags, legacy records without a category); de-duplication; overwrite-not-append; that the HTML is **not** dumped into the transcript; **a guard that no non-terminating error was silently swallowed**; and **source assertions** on the shipping action case |
| `test-action.js` | `buildServiceAccountExpirationInvocation.js` | Domain derivation from `DC=` components; grouping, first-seen ordering, case-insensitive matching; duplicate-OU suppression; single-domain **and** multi-domain lists through the same path; the look-ahead window's accept/reject set; every validation failure path; advisory warnings (nested OUs, domain-root scope, server override, email off); exact round-trip of awkward DNs (apostrophe, quotes, backslash, escaped comma, `$`); Array **and** CSV/newline string forms; the vRO character-split artifact guard; the read-only guarantee; and that the lab seeder's output still parses |
| `test-workflow-tasks.js` | `Get-ServiceAccountExpirationReport_spec.js` scriptable tasks | Extracts and **executes** the (item6) Set Execution Context code from the spec, so the JavaScript pasted into vRO is the JavaScript under test. Covers domain derivation, the server-override form, the window in the context string, bounded output, empty/null/string-form inputs, an ES5/Rhino compatibility guard (vRO has no `let`/`const`/arrow functions), and that the spec still documents the contract it must |
| `Test-Boundary.ps1` | Both, together | Takes the invocation string the action actually emits, executes it against a stub carrying the real `Resolve-DomainOUsMap`, and asserts the reconstructed map is byte-identical. **This is the test that validates the JS-JSON → PowerShell-single-quote → `ConvertFrom-Json` escaping chain**, the one place a quoting bug would silently corrupt the report scope — and a corrupted DN does not throw, it just searches somewhere else. Also covers apostrophes in the subject and recipient, and the window binding |

The tests load the functions under test **out of the live `cvs_functions.ps1` and the
live action and spec files by AST/parse** rather than holding copies, so they cannot
drift from the shipping code — if a function is renamed or removed, the tests fail
loudly instead of silently testing a stale copy.

### Two kinds of test, deliberately

`Test-S22.ps1` §8 asserts against the **shipping switch-case source**, not just
behaviour. This is not belt-and-braces: the action case cannot be executed offline (it
needs a directory), and more importantly **a behavioural test cannot catch the
regression that matters most here**. Re-adding `-SC $false` to the sweep would silently
narrow the report back to non-smartcard accounts — the original S-22 defect — and every
behavioural test in this suite would still pass, because none of them supplies the
input that would expose it. So the *absence* of that argument is asserted directly.

Those assertions run against **executable tokens with comments stripped**. The case
deliberately quotes the old defective code in its comments to explain why the defect
existed; asserting against raw text would fail on the documentation, and the tempting
"fix" would be to delete the explanation.

## Paths

`Test-S22.ps1`, `Test-Boundary.ps1`, `New-SampleReport.ps1` and `Run-AllTests.ps1` all
default to the working copy at
`InProgress/psscript/files/cvs_functions.ps1`, and all accept `-ScriptPath`. Update the
defaults when the script is promoted to
`Completed/_Shared References/psscript/files/`.

The JavaScript harnesses resolve the action and spec **relative to this folder**, so
they keep working when the project moves from `InProgress` to `Completed`.

## Scope

These cover the parsing, encoding, escaping, classification and report-rendering logic.
They do **not** cover the `Get-ADUser` calls themselves — those need a real directory
and belong in the lab validation pass (`05_Validation_and_Testing_Plan`), together with
per-OU failure isolation against an actually unreachable domain controller, real
`pwdLastSet` / `AccountExpirationDate` values, SMTP delivery, and Outlook rendering.
