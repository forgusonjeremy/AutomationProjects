# Implementation Guide — Service Account Expiration Reporting

Target: VCF Operations Orchestrator 9. Assumes familiarity with vRO actions, workflows
and the PowerShell plug-in.

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
| 6 | `cvs_functions.ps1` staged, carrying **S-16 … S-24** | See §2 |

> This is **not** the PowerShell host the Ansible template uses. The two estates are
> separate in development and production; nothing here affects Ansible.

> **Shared script.** If the Admin Accounts Report is already deployed, this workflow uses
> the **same** `cvs_functions.ps1` on the **same** host. Do not stage a second copy.

### vRO content

| # | Requirement |
|---|---|
| 7 | Event Log package installed — provides the shared `parseScriptOutput` action |
| 8 | OOTB *Invoke a PowerShell script* workflow present in the library |

---

## 2. Deploy the PowerShell script

Copy the updated `cvs_functions.ps1` to the PS host script folder (e.g. `C:\PSO\Scripts\`),
replacing the existing copy.

**Verify the required changes are present** — without them the report will be wrong rather
than absent:

```powershell
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch -Pattern `
    'ConvertFrom-ADFileTime',                  `  # S-22 FILETIME sentinels
    'Get-AccountExpiryState',                  `  # S-22 expiry classification
    'ExpiringWithinDays',                      `  # S-22 look-ahead window
    'Format-ServiceAccountTable',              `  # S-23 report tables
    'Sort-ServiceAccountRows',                 `  # S-23 worst-first ordering
    'GenerateReportServiceAccountExpiration'      # S-23 rebuilt report
```

All six must match.

**Then confirm the two silent defects are gone.** These are the checks that matter most —
both failure modes produce a plausible-looking report:

```powershell
# 1. The sweep must call the MULTI-DOMAIN function with NO -SC argument.
#    A match on '-SC' here means the old single-OU, smartcard-filtered query is back,
#    and the report will silently omit accounts requiring a smart card.
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' `
    -Pattern 'Get-ListOfUsers-MultiDomain.*-SC'

# 2. The phantom $Result2 append must be gone (it produced a blank row every run).
Select-String -Path 'C:\PSO\Scripts\cvs_functions.ps1' -SimpleMatch -Pattern '$Result += $Result2'
```

Both must return **nothing**.

Syntax check the deployed file:

```powershell
$e=$null; $t=$null
[System.Management.Automation.Language.Parser]::ParseFile(
    'C:\PSO\Scripts\cvs_functions.ps1', [ref]$t, [ref]$e) | Out-Null
if ($e.Count) { $e } else { 'parse OK' }
```

---

## 3. Deploy the vRO action

**Action:** `buildServiceAccountExpirationInvocation`
**Module:** `com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry`
**Return type:** `string`

Input parameters, **in this order** (the workflow calls positionally):

| # | Name | Type |
|---|---|---|
| 1 | `scriptPath` | string |
| 2 | `domainOUs` | Array/string |
| 3 | `expiringWithinDays` | number |
| 4 | `emailReport` | boolean |
| 5 | `smtpServer` | string |
| 6 | `mailTo` | Array/string |
| 7 | `mailCc` | Array/string |
| 8 | `mailSubject` | string |

Paste the body from `Code/buildServiceAccountExpirationInvocation.js`.

> **Order matters.** `expiringWithinDays` sits at position 3, not at the end. Adding it
> after `mailSubject` would bind the window to the subject and vice versa.

---

## 4. Build the workflow

**Name:** `Get-ServiceAccountExpirationReport`
**Folder:** `Production > Identity > Active Directory > Reporting`
(lab/dev: `Workflows > Customer > <Customer Name> > …`)

### 4.1 Inputs

| Name | Type | Form control | Default |
|---|---|---|---|
| `scriptPath` | string | textField | `C:\PSO\Scripts\cvs_functions.ps1` |
| `domainOUs` | Array/string | array | the production OU list |
| `expiringWithinDays` | number | textField | `30` |
| `emailReport` | boolean | checkbox | `true` |
| `smtpServer` | string | textField | site relay |
| `mailTo` | Array/string | array | operations DL |
| `mailCc` | Array/string | array | *(empty)* |
| `mailSubject` | string | textField | `Service Account Expiration Report` |

Set defaults **directly on each input** — no Configuration Element. These values are static
per environment; self-contained inputs match the other workflows in this transition.

> `mailTo` / `mailCc` are **Array/string**. Enter **one address per element**. Binding a
> scalar string to an Array input makes vRO split it into characters; the action throws on
> any recipient without an `@` to catch exactly that.

> `domainOUs` takes a **full OU distinguishedName per row** —
> `OU=Service Accounts,DC=corp,DC=local`, not a bare OU name. The domain is derived from
> the DN's own `DC=` components, so there is no domain input. A row with no `DC=` fails
> the run.

> `expiringWithinDays` must be a **whole, non-negative number**. The action rejects
> `30.9`, `"30 days"` and negatives rather than quietly reinterpreting them.

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

There is **no** `psHost` input — the host is an attribute, re-pointed per environment in
the workflow rather than at run time.

### 4.3 Schema

```
Start
 └─ (item10) Scriptable : Set Log Marker          [root element]
     └─ (item1)  Action  : buildServiceAccountExpirationInvocation
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

Identical in shape to `Get-AdminAccountsReport`. If that workflow is already deployed, copy
it and replace the action plus inputs.

### 4.4 Scriptable task code

Take each block verbatim from `Code/Get-ServiceAccountExpirationReport_spec.js`.

- **item10 — Set Log Marker** · IN: *(none)* · OUT: *(none)*
- **item6 — Set Execution Context** · IN: `domainOUs`, `expiringWithinDays` · OUT: `executionContext`
- **item3 — Throw Error** · IN: `err_0` → `throw err_0;`
- **item8 — Decision** · body: `return parsedResult.success;`
- **item11 — Log Success** · IN: `parsedResult`, `executionContext` · OUT: `executionSuccess`, `executionOutput`
- **item9 — Log Failures** · IN: `parsedResult`, `executionContext` · OUT: `executionSuccess`, `executionOutput`

> **item6 takes two inputs here**, not one. The window is included in the execution context
> so the transcript records which window a run used — two scheduled runs over the same OUs
> with different windows produce different counts.

> vRO runs Rhino/ES5. Do **not** modernise this code — no `let`, `const` or arrow
> functions. The regression suite enforces this.

### 4.5 Record the workflow ID

After the first save, copy the workflow ID into the header of
`Get-ServiceAccountExpirationReport_spec.js`, replacing `(TBD …)`.

---

## 5. Version-specific considerations

- **vRO 9 / Rhino:** ES5 only in actions and scriptable tasks.
- **PowerShell plug-in:** `getRootObject()` returns only the **success** stream. The action
  appends `*>&1 | Out-String -Width 4096` so `Write-Host` output is returned at all;
  `-Width 4096` prevents long `Error:` lines being wrapped and truncated. Do not remove
  either.
- **CLIXML escapes:** the plug-in serialises CR/LF as `_x000D__x000A_`. `parseScriptOutput`
  decodes these; without it the transcript is one long line and individual error lines
  cannot be isolated.
- **Kerberos double-hop:** the PS host authenticates onward to domain controllers. If
  constrained delegation is not configured, LDAP queries fail with access or authentication
  errors — visible in the report as *Access denied* / *Authentication*.
- **PowerShell 5.1 and 7** are both supported by the script; the parse check in §2 runs on
  either.

---

## 6. Validation

Run the offline suite before deploying — no infrastructure required:

```powershell
cd '<repo>\InProgress\Service Account Expiration Reporting\lab'
.\Run-AllTests.ps1        # 256 checks
```

To review the report format before anyone receives it:

```powershell
.\New-SampleReport.ps1    # writes four rendered samples; open in a browser
```

Then seed a lab directory and run the workflow end to end:

```powershell
.\New-ServiceAccountTestData.ps1 -Domain <lab domain> -WhatIf   # preview
.\New-ServiceAccountTestData.ps1 -Domain <lab domain>           # create
```

The seeder prints the `domainOUs` rows to paste into the workflow **and the figures the
report should produce**. Full plan → `05_Validation_and_Testing_Plan.md`.

---

## 7. Rollback

| Scenario | Action |
|---|---|
| Workflow misbehaves | Disable the schedule. The Ansible template is unaffected (separate hosts) and continues running. |
| Script issue | Restore the previous `cvs_functions.ps1` from the Completed reference copy. **Note:** other transitioned workflows share this script — restoring an older copy reverts their fixes too, and reverting this one restores a report that silently omits accounts. Prefer fixing forward. |
| Action/workflow issue | Re-import the previous package version. |
| Report format rejected | Report rendering is confined to `GenerateReportServiceAccountExpiration` and its three helpers; adjust without touching orchestration. |
| Window set wrongly | Change the `expiringWithinDays` input and re-run. Nothing is filtered by it, so no data is lost — only the sectioning and the subject counts change. |

Because the estates are separate, rollback here has **no effect on Ansible** and requires
no coordination with that team.

---

## 8. Post-deployment

1. Record the workflow ID in the spec file.
2. Export the package (`com.broadcom.pso.vcf.identity.ad.accounts.serviceAccountExpiry`).
3. Promote `cvs_functions.ps1` from `InProgress/` to
   `Completed/_Shared References/psscript/files/`.
4. Update the lab suite's script path to the promoted location.
5. Create the schedule, and **check the window is at least as long as the schedule
   interval**.
6. **Brief recipients before the first scheduled send.** Two items specifically:
   - **The account count will rise**, possibly substantially. Accounts requiring a smart
     card were silently excluded from every previous report. This is previously-invisible
     scope becoming visible, not a directory change.
   - **The subject line has changed.** It now carries ` ( N expired - M expiring within D
     days )` and an `[INCOMPLETE] ` prefix on degraded runs. Any inbox rule matching the
     old subject exactly will stop matching.
