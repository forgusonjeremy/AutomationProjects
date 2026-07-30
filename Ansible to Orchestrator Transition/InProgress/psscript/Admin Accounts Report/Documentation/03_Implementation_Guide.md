# Implementation Guide — Admin Accounts Report

Target: VCF Operations Orchestrator 9. Assumes familiarity with vRO actions,
workflows and the PowerShell plug-in.

---

## 1. Prerequisites

### PowerShell host

| # | Requirement | Verify |
|---|---|---|
| 1 | PS host registered in vRO (WinRM/HTTPS, Kerberos) | Visible under **Inventory → PowerShell**. Full build → *How-To-Build-a-PowerShell-Host* |
| 2 | RSAT ActiveDirectory module installed | `Get-Module -ListAvailable ActiveDirectory` returns the module |
| 3 | LDAP reachability to **every** domain in scope | `Get-ADDomain -Server <domain>` succeeds for each |
| 4 | Service account has **read** rights on every OU in scope | `Get-ADUser -Server <domain> -SearchBase '<OU DN>' -Filter * -ResultSetSize 1` succeeds |
| 5 | SMTP relay reachable and accepting mail from the host | `Test-NetConnection <smtp> -Port 25` |
| 6 | `cvs_functions.ps1` staged, carrying **S-16 … S-21** | See §2 |

> This is **not** the PowerShell host the Ansible templates use. The two estates are
> separate in development and production; nothing here affects Ansible.

### vRO content

| # | Requirement |
|---|---|
| 7 | Event Log package installed — provides the shared `parseScriptOutput` action |
| 8 | OOTB *Invoke a PowerShell script* workflow present in the library |

---

## 2. Deploy the PowerShell script

Copy the updated `cvs_functions.ps1` to the PS host script folder
(e.g. `C:\PSO\Scripts\`), replacing the existing copy.

**Verify the required changes are present** — without them the report will be wrong
rather than absent:

```powershell
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch -Pattern `
    'Resolve-DomainOUsMap',        `  # S-16 scope parsing
    'Get-ListOfUsers-MultiDomain', `  # S-16 multi-domain sweep
    'GenerateReportPKI-v2',        `  # S-17 sectioned report
    'Remove-DuplicateAccounts',    `  # S-19 de-duplication
    'Get-ADFailureCategory',       `  # S-20 failure classification
    'Format-PKIAccountTable'          # S-19 OU sub-sections
```

All six must match. Then confirm the legacy path is **gone** (S-21):

```powershell
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch `
    -Pattern 'LEGACY single-domain mode'
```

This must return **nothing**. A match means an older copy is deployed, in which case
a run with no OU map could silently produce a single-OU report.

Syntax check the deployed file:

```powershell
$e=$null; $t=$null
[System.Management.Automation.Language.Parser]::ParseFile(
    'C:\PSO\Scripts\cvs_functions.ps1', [ref]$t, [ref]$e) | Out-Null
if ($e.Count) { $e } else { 'parse OK' }
```

---

## 3. Deploy the vRO action

**Action:** `buildAdminAccountsReportInvocation`
**Module:** `com.broadcom.pso.vcf.identity.ad.accounts.adminReport`
**Return type:** `string`

Input parameters, **in this order** (the workflow calls positionally):

| # | Name | Type |
|---|---|---|
| 1 | `scriptPath` | string |
| 2 | `domainOUs` | Array/string |
| 3 | `emailReport` | boolean |
| 4 | `smtpServer` | string |
| 5 | `mailTo` | Array/string |
| 6 | `mailCc` | Array/string |
| 7 | `mailSubject` | string |

Paste the body from `Code/buildAdminAccountsReportInvocation.js`.

---

## 4. Build the workflow

**Name:** `Get-AdminAccountsReport`
**Folder:** `Production > Identity > Active Directory > Reporting`
(lab/dev: `Workflows > Customer > <Customer Name> > …`)

### 4.1 Inputs

| Name | Type | Form control | Default |
|---|---|---|---|
| `scriptPath` | string | textField | `C:\PSO\Scripts\cvs_functions.ps1` |
| `domainOUs` | Array/string | array | the production OU list |
| `emailReport` | boolean | checkbox | `true` |
| `smtpServer` | string | textField | site relay |
| `mailTo` | Array/string | array | compliance DL |
| `mailCc` | Array/string | array | *(empty)* |
| `mailSubject` | string | textField | `Report: Admin PKI Card Status` |

Set defaults **directly on each input** — no Configuration Element. These values are
static per environment; self-contained inputs match the other workflows in this
transition.

> `mailTo` / `mailCc` are **Array/string**. Enter **one address per element**. Binding
> a scalar string to an Array input makes vRO split it into characters; the action
> throws on any recipient without an `@` to catch exactly that.

### 4.2 Attributes

| Name | Type | Value |
|---|---|---|
| `host` | `PowerShell:PowerShellHost` | **Pre-bound** to the target PS host |
| `invocationString` | string | from the action |
| `psRawOutput` | `PowerShell:PowerShellRemotePSObject` | from the PS link |
| `executionContext` | string | set by item6 |
| `parsedResult` | Properties | from `parseScriptOutput` |
| `err_0` | string | catch binding |
| `executionSuccess` | boolean | set by the log tasks |
| `executionOutput` | string | set by the log tasks |

There is **no** `psHost` input — the host is an attribute, re-pointed per environment
in the workflow rather than at run time.

### 4.3 Schema

```
Start
 └─ (item10) Scriptable : Set Log Marker          [root element]
     └─ (item1)  Action  : buildAdminAccountsReportInvocation
         │        OUT actionResult → invocationString
         └─ (item2)  Workflow : Invoke a PowerShell script
             │        IN host ← host ; script ← invocationString
             │        OUT output → psRawOutput
             ├─ catch → err_0 → (item3) Scriptable: Throw Error → (item4) End  [FAILED]
             └─ (item6)  Scriptable : Set Execution Context
                 └─ (item5)  Action : parseScriptOutput
                     │        IN psOutput ← psRawOutput ; executionContext ← executionContext
                     │        OUT actionResult → parsedResult
                     └─ (item8) Decision : return parsedResult.success
                         ├─ true  → (item11) Log Success  → (item0) End
                         └─ false → (item9)  Log Failures → (item7) End
```

Identical in shape to `Get-ServerRebootReport`. If that workflow is already deployed,
copy it and replace the action plus inputs.

### 4.4 Scriptable task code

Take each block verbatim from `Code/Get-AdminAccountsReport_spec.js`.

- **item10 — Set Log Marker** · IN: *(none)* · OUT: *(none)*
- **item6 — Set Execution Context** · IN: `domainOUs` · OUT: `executionContext`
- **item3 — Throw Error** · IN: `err_0` → `throw err_0;`
- **item8 — Decision** · body: `return parsedResult.success;`
- **item11 — Log Success** · IN: `parsedResult`, `executionContext` · OUT: `executionSuccess`, `executionOutput`
- **item9 — Log Failures** · IN: `parsedResult`, `executionContext` · OUT: `executionSuccess`, `executionOutput`

> vRO runs Rhino/ES5. Do **not** modernise this code — no `let`, `const` or arrow
> functions. The regression suite enforces this.

### 4.5 Record the workflow ID

After the first save, copy the workflow ID into the header of
`Get-AdminAccountsReport_spec.js`, replacing `(TBD …)`.

---

## 5. Version-specific considerations

- **vRO 9 / Rhino:** ES5 only in actions and scriptable tasks.
- **PowerShell plug-in:** `getRootObject()` returns only the **success** stream. The
  action appends `*>&1 | Out-String -Width 4096` so `Write-Host` output is returned at
  all; `-Width 4096` prevents long `Error:` lines being wrapped and truncated. Do not
  remove either.
- **CLIXML escapes:** the plug-in serialises CR/LF as `_x000D__x000A_`.
  `parseScriptOutput` decodes these; without it the transcript is one long line and
  individual error lines cannot be isolated.
- **Kerberos double-hop:** the PS host authenticates onward to domain controllers.
  If constrained delegation is not configured, LDAP queries fail with access or
  authentication errors — visible in the report as *Access denied* / *Authentication*.

---

## 6. Validation

Run the offline suite before deploying — no infrastructure required:

```powershell
cd '<repo>\InProgress\psscript\Admin Accounts Report\lab'
.\Run-AllTests.ps1        # 191 checks
```

Then seed a lab directory and run the workflow end to end:

```powershell
.\New-AdminAccountTestData.ps1 -Domain <lab domain> -WhatIf   # preview
.\New-AdminAccountTestData.ps1 -Domain <lab domain>           # create
```

The seeder prints the `domainOUs` list to paste into the workflow **and the figures
the report should produce**. Full plan → `05_Validation_and_Testing_Plan.md`.

---

## 7. Rollback

| Scenario | Action |
|---|---|
| Workflow misbehaves | Disable the schedule. The Ansible templates are unaffected (separate hosts) and continue running. |
| Script issue | Restore the previous `cvs_functions.ps1` from the Completed reference copy. **Note:** other transitioned workflows share this script — restoring an older copy reverts their fixes too. Prefer fixing forward. |
| Action/workflow issue | Re-import the previous package version. |
| Report format rejected | Report rendering is confined to `GenerateReportPKI-v2`; adjust without touching orchestration. |

Because the estates are separate, rollback here has **no effect on Ansible** and
requires no coordination with that team.

---

## 8. Post-deployment

1. Record the workflow ID in the spec file.
2. Export the package (`com.broadcom.pso.vcf.identity.ad.accounts.adminReport`).
3. Promote `cvs_functions.ps1` from `InProgress/` to
   `Completed/_Shared References/psscript/files/`.
4. Update the lab suite's script path to the promoted location.
5. Create the schedule.
6. **Brief recipients** — the report format has changed, the subject line may carry
   an `[INCOMPLETE]` prefix, and counts may drop on the first run if the OU list
   overlaps.
