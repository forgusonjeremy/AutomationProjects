# Service Account Expiration Reporting — Consolidation

**Status:** Design complete — supersedes `02_Design_Document.md` §Script action and the
`buildServiceAccountExpirationInvocation` action
**Date:** 2026-08-17, revised 2026-08-18 (no new PowerShell)
**Change IDs:** **P-58**, **P-61**, **S-27** (applies), **S-30** (deferred), **S-26** (absorbed by S-30)

---

## 1. Decision

**One workflow — `Get-ServiceAccountExpirationReport` — running one invocation per scope,
each against the `PowerShellHost` object for that scope's domain identity. Both job
templates retire. No PowerShell changes.**

| Retires | Script | Selector |
|---|---|---|
| `service_accounts_report.yml` | `cvs_function_formatted_email_washdc.ps1` `-Action Get-ServiceAccountExpiration` | `-OUPath OU=Service Accounts,DC=subdom6,DC=company,DC=net` in `subdom6.company.net` |
| `service_accounts_reports_connect.yml` | `cvs_function_formatted_email.ps1` `-Action Get-ServiceAccountExpiration-ByGroup` | `-ADGroupMember SVC-Accounts` in `subdomain8.net` |

### Why these are one workflow

**They already run the same script.** `cvs_function_formatted_email_washdc.ps1` differs from
`cvs_function_formatted_email.ps1` in exactly three lines: the `-Action` ValidateSet (the
washdc copy omits `Get-ServiceAccountExpiration-ByGroup`) and two default mail addresses
both templates override anyway. Two 58 KB copies of one script, kept in step by hand.

**They already send the same report to the same people.** Identical `var_MailToString`,
identical `var_MailCcString`, and the identical subject `Ansible-Report: Service Account
Expiration Report`. Two mails, indistinguishable in an inbox, each covering half the estate.

What genuinely differs is only **how each names its accounts** — OU search base versus group
membership, in two different domains under two different identities. That is a per-scope
*selector*, not a separate report.

### Why no new script (revised 2026-08-18)

The first version of this design specified a new script (S-30) so the run could sweep both
domains in one invocation and send **one** email. That is still the better report — but it
is also the only remaining PowerShell development in either reporting project, and the
transition's priority is getting off Ansible quickly, with a team who maintain the Ansible
estate and are being asked to learn Orchestrator.

`cvs_function_formatted_email.ps1` already implements **both** actions:

| Action | Function | Line |
|---|---|---|
| `Get-ServiceAccountExpiration` | `Get-ListOfUsers` (`-OUPath`) | 1036 |
| `Get-ServiceAccountExpiration-ByGroup` | `Get-ListOfUsers-ByGroup` (`-ADGroupMember`) | 1054 |

So the consolidation needs no new script, no scope map and no credential injection: one
Resource Element, one `PowerShellHost` per domain identity, two invocations. **The duplicate
`_washdc` copy still retires** — the connect copy covers both scopes, and it is the only one
whose ValidateSet contains `-ByGroup`.

**What this trades:** two emails instead of one. Recipients get exactly what they get today,
so nothing regresses — but the "two indistinguishable mails" problem is only half fixed. The
subject line now carries the domain (`… (subdom6.company.net)`), which distinguishes them at
no cost. **S-30 remains specified in §2** as the way to get to one email later; nothing in
this design blocks it.

**THIS WORKFLOW IS READ-ONLY.** It queries Active Directory and emails a report. It does not
renew, extend, unlock or disable anything. Rotation is a separate deliverable (S-25).

---

## 2. S-30 — `cvs_svcaccounts.ps1` (deferred, specified)

**Not required for delivery.** Build this only when one email covering both domains is worth
a new script. It is `cvs_admin.ps1`'s proven pattern — scope map, `Get-DomainCredential`,
per-scope error rows, sectioned HTML — applied to service accounts, and it absorbs **S-26**
(which was "port `Get-DomainCredential` into the `cvs_functions.ps1` service-account path";
that path is replaced rather than amended).

### Parameter contract

| Parameter | Type | Notes |
|---|---|---|
| `-Action` | `ValidateSet('Get-ServiceAccountExpiration')` | |
| `-ScopeMap` / `-ScopeMapFile` | string (JSON) / path | `{"<domain>":{"ous":[…],"groups":[…],"credential":"<key>"}}` |
| `-DefaultCredentialKey` | string | Fallback when a domain has no `credential` |
| `-ExpiringWithinDays` | int, default `30` | Look-ahead for the *Expiring* classification |
| `-IncludeDisabled` | `yes`/`no`, default `yes` | |
| `-FailOnQueryError` | `yes`/`no`, default `no` | |
| `-eMailReport`, `-SMTPServer`, `-MailToString`, `-MailCcString`, `-MailSubjectstring` | string | As `cvs_admin.ps1` |
| `-ReportTitle` | string, default `Service Account Expiration Report` | |

### Behaviour

1. **Per domain**, resolve the credential (`credential`, else `-DefaultCredentialKey`, else
   ambient identity). A key whose `AD_CRED_<KEY>_USER` / `_PASS` are absent is a per-domain
   error row — the sweep continues, as in `cvs_admin.ps1:150-156`.
2. **For each `ous`**: `Get-ADUser -Server <domain> -SearchBase <DN> -SearchScope Subtree`.
3. **For each `groups`**: `Get-ADGroupMember -Server <domain> -Recursive`, keep
   `objectClass -eq 'user'`, then `Get-ADUser`. **S-27 applies** — targeting groups are
   confirmed single-domain (P-54, resolved), so a member that cannot be resolved against
   `-Server <domain>` is an **`Error:`** row, not a `Warn:`.
4. **Properties** — unchanged from the current report so the columns stay recognisable:
   `SamAccountName, DisplayName, Office, Enabled, Lockedout, pwdLastSet,
   AccountExpirationDate, WhenCreated, Description`, plus a `Domain` column.
5. **Computed columns**, as today: `PW Age` = days since `pwdLastSet` (`0` when it is 0);
   `PW LastSet` = `[datetime]::FromFileTime($_.pwdLastSet)`.
6. **De-duplicate** on `Domain` + `SamAccountName`.
7. **Sections**: *Expired*, *Expiring within `<N>` days*, the full inventory sorted by
   `PW Age` descending, a *Query Errors* section when any scope failed, and an **OU/group
   footnote** listing everything queried — the only thing that makes an incomplete report
   visibly incomplete.
8. **Subject**: `<MailSubjectstring> ( N expired - M expiring within D days )`.
9. **Exit**: `1` when `-FailOnQueryError yes` and any error row exists, **after** the mail is
   sent; `2` on unusable input, before anything is sent.
10. **No `-append`**, and artefacts under `C:\PSO\Logs\` rather than `$PSScriptRoot` (S-28).

---

## 3. Workflow schema

PowerShell plug-in over WinRM, script copied from a Resource Element each run
(`_Shared/Documentation/Script-Staging-Design.md`).

```
[ parseServiceAccountScopes ]                 scopes, defaultRunAsAccount -> Array/Properties

for each scope:
    [ resolvePowerShellHostForAccount ]       scope.account -> psHost       (shared, P-52)
    [ stageScriptOnHost ]                     psHost, 'PSO/Scripts/cvs_function_formatted_email.ps1'
            |                                 -> scriptVersion   (workflow OUTPUT, first pass)
    [ buildServiceAccountScopeInvocation ]    -> invocationString
    [ Invoke a PowerShell script ]            (OOTB, against psHost)
    [ parseScriptOutput ]                     (shared, unchanged)
```

**The identity is per scope, not per workflow.** The two job templates being replaced
authenticate as accounts in *different* domains — that is the mechanism by which each gets
its rights — so the run-as account sits on the scope row (`account=`) rather than being a
single workflow input. `parseServiceAccountScopes` validates every row before the first host
is touched, which is the same job the v3 playbook's `assert` block does: a malformed row
should cost a rejected request, not a half-finished run that has already emailed one of two
reports.

One workflow, one scope list, N invocations, N emails. The loop is the consolidation: the
operator maintains one scope list instead of two job templates, and adding a third domain is
a row, not a new template.

**Why the loop rather than one invocation:** `cvs_function_formatted_email.ps1` contains no
uses of `-Credential` — every AD call runs as the ambient identity of the session. AAP varied
that identity per job template, the two templates authenticating as accounts in different
domains. Binding one `PowerShellHost` object per domain identity and resolving it per scope
(P-52) reproduces that exactly, which is why no credential injection is needed here at all.

`stageScriptOnHost` runs per scope but is cheap and harmless: all host objects for the pool
share one filesystem, so passes after the first overwrite an identical file.

**Second hop:** every `Get-ADUser -Server` and `Get-ADGroupMember -Server` needs Kerberos
delegation on the WinRM session. AAP already runs with
`ansible_winrm_kerberos_delegation: yes` — `Script-Staging-Design.md` §6.3. Test first.

---

## 4. Inputs

| Input | Type | Default (from the customer's templates) |
|---|---|---|
| `scriptPath` | string | `C:\PSO\Scripts\cvs_function_formatted_email.ps1` |
| `scopes` | Array/string | the 2 rows in §5 |
| `defaultRunAsAccount` | string (dropdown) | *(empty — both rows name their own)* |
| `emailReport` | boolean | `true` |
| `smtpServer` | string | `mailrelay.company.com` |
| `mailTo` | Array/string | `security@…`, `Data-Protection-Team-FL@…`, `On-PremEngineering@…` |
| `mailCc` | Array/string | `Monitoring@…` |
| `mailSubject` | string | `Ansible-Report: Service Account Expiration Report` |

`expiringWithinDays`, `includeDisabled`, `failOnQueryError` and `reportTitle` are **not**
inputs: the current script has no equivalent parameters. They return with S-30.

---

## 5. Scope, as the operator sees it

```
subdom6.company.net | ou=OU=Service Accounts,DC=subdom6,DC=company,DC=net | account=svc-vro-subdom6@subdom6.company.net
subdomain8.net      | group=SVC-Accounts                                  | account=svc-vro-subdom8@subdomain8.net
```

Two rows replace two job templates. Each row is one domain, one selector, one identity, one
invocation — so a row must carry `ou=` **or** `group=`, not both: they select the script's
`-Action`, not a combined filter. A domain needing both is two rows.

`account=` is the run-as selector, resolved through `PSO/Identity/RunAsAccounts`. It is
optional per row and falls back to the workflow's `defaultRunAsAccount`; with neither, the
row is rejected rather than guessed at, because the run-as account is what decides which
domain the script can read.

No `cred=` modifier: the identity comes from the `PowerShellHost` object, not from an
injected credential. That is the whole reason this design needs no `AD_CRED_*` at all.

### P-61 — spellings to verify

| Where | Says | Question |
|---|---|---|
| `service_accounts_report.yml` credential | `SSH:user@subdomain6.net` | but `var_DomainName: subdom6.company.net` and the OU is `DC=subdom6,DC=company,DC=net` |
| `service_accounts_reports_connect.yml` | `subdomain8.net` throughout | consistent |
| Both | the same `-MailSubjectstring` | intentional, or an unnoticed copy? |

The first matters most: the credential's domain determines which `PowerShellHost` object
this scope must bind to. `buildServiceAccountScopeInvocation` rejects an `ouPath` whose DN
disagrees with its `domain`, which catches the scope half; the credential half can only be
confirmed from the AAP template.

---

## 6. Credentials

**None held by Orchestrator beyond the two `PowerShellHost` objects.** One host object per
domain identity, both pointing at the same pool FQDN, named for the **identity** rather than
the server (`pshost-subdom6`, `pshost-subdom8`) and registered in Shared Session mode —
`Multi-Domain-Remediation-Plan.md` §5.1.

This is the simplest credential story in the whole programme, and it is a direct consequence
of not consolidating into a single invocation. S-30 would trade it for `AD_CRED_*` staging on
the host.

---

## 7. Ansible → Orchestrator mapping

| Job template | Orchestrator |
|---|---|
| `var_ps_folder` + `var_ps_script_file` | folded into `scriptPath`; copied from a Resource Element each run (P-56) |
| `var_parameter_action` | derived from the row's selector — `ou=` → `Get-ServiceAccountExpiration`, `group=` → `…-ByGroup` |
| `var_DomainName` | the row's domain → `-DomainName`, **and** the `PowerShellHost` it resolves to |
| `var_OUPath` | `ou=` modifier |
| `var_ADGroupMember` | `group=` modifier |
| two job templates, two credentials | one workflow, two `PowerShellHost` objects (P-52) |
| `var_eMailReport` / `var_SMTPServer` / `var_MailToString` / `var_MailCcString` | inputs of the same name |
| `var_MailSubjectstring` | same input; the action appends ` (<domain>)` so the two mails are distinguishable |
| `var_cleanup_temporary_folder: true` | *(dropped — the script goes to a stable path)* |
| `var_HeaderNotesSubstr` (commented out in both) | dropped — never set |
| `port: 5986` | `PowerShellHost` object configuration |
| `ansible_winrm_kerberos_delegation: yes` | Kerberos delegation on the host object — §6.3, **test first** |
| `ls -Recurse …\debug` | dropped — a bare directory listing that was never read |

---

## 8. Change register additions

| ID | Type | Description |
|---|---|---|
| **P-58** | Consolidation | Two job templates → one workflow; two 58 KB near-identical scripts → one. Delivered with **no PowerShell changes** |
| **P-61** | Verification | Credential/domain spellings in the template data — §5 |
| **S-27** | Applies | Foreign group member `Warn:` → `Error:`. **Not delivered here** — it is a `cvs_functions.ps1` change and this workflow uses `cvs_function_formatted_email.ps1` unmodified. Carried into S-30 |
| **S-30** | *Deferred* | `cvs_svcaccounts.ps1` — required only for a single consolidated email. Contract in §2 |
| **S-26** | *Absorbed* | Delivered by S-30 if and when that is built |
| **S-22, S-23** | *Withdrawn* | Specified for a `cvs_functions.ps1` generation the customer has moved past (same re-baseline hazard as P-55) |
| **P-59** | *Withdrawn here* | `-FailOnQueryError` does not exist in this script. The current behaviour — no error model, no `rc` check — is inherited unchanged and returns with S-30 |

**Known limitation, inherited deliberately:** `cvs_function_formatted_email.ps1` has no
error-row model and the playbooks never checked `rc`, so a scope that cannot be read
produces a short report rather than a failed run. `parseScriptOutput` will surface `Error:`
lines in the transcript, which is more than AAP did — but it is not the same guarantee the
admin report gets from `-FailOnQueryError`. This is the main thing S-30 buys besides the
single email.

---

## 9. Validation additions

| # | Check | Expected |
|---|---|---|
| **V-0** | **Second hop** | `Get-ADGroupMember -Server subdomain8.net SVC-Accounts` succeeds through `pshost-subdom8`. **Before anything else** — §6.3 |
| **V-1** | Row with neither `ou=` nor `group=` | Rejected |
| **V-2** | Row with **both** | Rejected — they select `-Action`, so one would be ignored |
| **V-3** | `ou=` DN naming a different domain than its row | Rejected (P-60/P-61 guard) |
| **V-4** | `group=` scope staged against the `_washdc` copy | PowerShell rejects the `-Action`; confirm the message is recognisable |
| **V-5** | Host resolution | Each scope binds the host object for **its** domain; a missing mapping fails the run, not the scope |
| **V-6** | Subject lines | Two mails, distinguishable by the appended `(<domain>)` |
| **V-7** | Against the retiring templates | Same account population per scope, on the same day |
| **V-8** | Staging | `stageScriptOnHost` verifies the byte count; a truncated copy fails before invocation |
