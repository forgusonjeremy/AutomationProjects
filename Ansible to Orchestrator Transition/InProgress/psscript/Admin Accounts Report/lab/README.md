# Admin Accounts Report — regression tests

Offline regression tests for the S-16 script changes and the
`buildAdminAccountsReportInvocation` vRO action. **No Active Directory, SMTP,
PowerShell host or vRO appliance is required** — every external dependency is
stubbed, so these run on a laptop.

## Running

One command, from this folder:

```powershell
.\Run-AllTests.ps1
```

That runs all four suites in the required order and prints a single summary
(**191 checks** at time of writing). Add `-KeepArtifacts` to keep the generated
files — including a rendered `Debug\PKI_result.html` — when you want to see what a
failing test actually produced.

## Seeding a lab AD to run the workflow for real

`New-AdminAccountTestData.ps1` creates the OU structure and accounts needed to
exercise **every** report behaviour, then prints the `domainOUs` list to paste into
the workflow **and the figures the report should produce**, so a lab run can be
verified rather than eyeballed.

```powershell
.\New-AdminAccountTestData.ps1 -Domain vcf.lab -WhatIf     # preview first
.\New-AdminAccountTestData.ps1 -Domain vcf.lab             # create
.\New-AdminAccountTestData.ps1 -Domain vcf.lab -IncludeNestedOU   # + de-dup demo
.\New-AdminAccountTestData.ps1 -Domain vcf.lab -Remove     # clean up
```

**This writes to Active Directory — lab domains only.** Every object it creates is
tagged in its Description; `-Remove` deletes only tagged objects, and refuses to drop
the OUs if anything it did not create is still inside them.

What the seeded set covers: compliant and non-compliant accounts, a **disabled**
non-compliant account (Account state column), a service account in an admin OU (the
exemption question), accounts across **two** OUs (per-OU sub-sections), and
optionally a **nested** OU (de-duplication notice). The script also documents how to
provoke the `[INCOMPLETE]` path by adding a bogus OU DN.

`test-action.js` **T9** asserts the seeder's output still feeds the vRO action
correctly, so the two cannot drift apart.

## Seeing the report without a lab

To see the report itself rather than test output:

```powershell
.\New-SampleReport.ps1
```

which writes three rendered samples next to this file — open any in a browser:

| File | Shows |
|---|---|
| `Sample-Report-Clean.html` | Every OU read successfully. Domains with 2+ OUs are sub-sectioned; a single-OU domain is not. |
| `Sample-Report-Incomplete.html` | Two OUs unreadable — the `[INCOMPLETE]` path, flagged at both domain and OU level. |
| `Sample-Report-Duplicates.html` | An overlapping OU list (a parent and its sub-OU) — each account collapsed to one entry under the most specific OU, plus the explanatory notice. |

<details>
<summary>Running the suites individually</summary>

```powershell
node .\test-action.js        # 51 checks — the vRO action
.\Test-S16.ps1               # 110 checks — the PowerShell functions
node .\gen-awkward.js        # generates a fixture used by Test-Boundary
.\Test-Boundary.ps1          # 16 checks — the JS -> PowerShell boundary
node .\test-workflow-tasks.js # 14 checks — the workflow's scriptable tasks
```

Order matters: `test-action.js` and `gen-awkward.js` write the invocation strings
that `Test-Boundary.ps1` executes. All generated files (`invocation*.txt`,
`stub_cvs.ps1`, `domain_ous.json`, `Debug/`) are disposable.
</details>

**Requires** PowerShell 5.1+ (or 7) and Node.js — both already present on the
current workstation. Node is used only to execute the vRO action's JavaScript *as
written*, so the file under test is the file that ships rather than a translation
of it.

## What each file covers

| File | Target | Covers |
|---|---|---|
| `Test-S16.ps1` | `Resolve-DomainOUsMap`, `Get-ListOfUsers-MultiDomain`, `GenerateReportPKI-v2`, `Format-HtmlTable`, `Format-PKIAccountTable`, `Remove-DuplicateAccounts`, `Get-ADFailureCategory` in `cvs_functions.ps1` | Inline-JSON and file map sources; file-over-inline precedence; the three v2 defects (inline JSON never parsed, unhandled malformed JSON, hashtable footnote); **S-21** (the legacy `-DomainName`/`-OUPath` fallback is absent, asserted against the shipping source; the parameters themselves survive for `Get-ServiceAccountExpiration`); null-map guards; report structure (exec summary, per-domain sections, **per-OU sub-sections**, in-scope-but-empty domains and OUs); column projection and colouring; failure surfacing (banner, per-domain and per-OU warnings, NOT READ scope flags, duplicate collapsing); **de-duplication** (deepest-OU retention, idempotency, counts taken after dedup); overwrite-not-append; **failure classification** (every category, message-over-type precedence, unknown-degrades-to-Unclassified, legacy records without the new fields); **and a guard that no non-terminating error was silently swallowed** |
| `test-action.js` | `buildAdminAccountsReportInvocation.js` | **Domain derivation from `DC=` components**; grouping, first-seen ordering, case-insensitive domain matching; duplicate-OU suppression; single-domain **and** multi-domain lists through the same path; every validation failure path; advisory warnings (nested OUs, domain-root scope, server override); exact round-trip of awkward DNs (apostrophe, quotes, backslash, escaped comma, `$`); Array **and** CSV/newline string input forms; the vRO character-split artifact guard |
| `test-workflow-tasks.js` | `Get-AdminAccountsReport_spec.js` scriptable tasks | Extracts and **executes** the (item6) Set Execution Context code from the spec, so the JavaScript pasted into vRO is the JavaScript under test. Covers domain derivation from DNs, the server-override form, bounded output, empty/null/string-form inputs, and an ES5/Rhino compatibility guard (vRO has no `let`/`const`/arrow functions). |
| `Test-Boundary.ps1` | Both, together | Takes the invocation string the action actually emits, executes it against a stub carrying the real `Resolve-DomainOUsMap`, and asserts the reconstructed map is byte-identical. **This is the test that validates the JS-JSON → PowerShell-single-quote → `ConvertFrom-Json` escaping chain**, the one place a quoting bug would silently corrupt the report scope. |

The tests load the functions under test **out of the live
`cvs_functions.ps1` and the live action file by AST/parse** rather than holding
copies, so they cannot drift from the shipping code — if a function is renamed or
removed, the tests fail loudly instead of silently testing a stale copy.

`Test-S16.ps1` and `Test-Boundary.ps1` both reference the working copy at
`InProgress/psscript/files/cvs_functions.ps1`. Update that path when the script is
promoted to `Completed/_Shared References/psscript/files/`.

## Scope

These cover the parsing, encoding, escaping and report-rendering logic. They do
**not** cover the `Get-ADUser` calls themselves — those need a real directory and
belong in the lab validation pass (`05_Validation_and_Testing_Plan`), together with
the per-OU failure isolation that requires an actual unreachable domain controller
to exercise.






