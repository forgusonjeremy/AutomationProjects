# Admin Accounts Report — Consolidation onto v3

**Status:** Design complete — supersedes `02_Design_Document.md` §Script action and the
`buildAdminAccountsReportInvocation` action
**Date:** 2026-08-17
**Closes:** open question §7.1 of `Summary.md`, §4 of `Multi-Domain-Remediation-Plan.md`
**Change IDs:** **P-55** (closed), **P-57**, **P-59**, **P-60**

---

## 1. Decision

**One workflow — `Get-AdminPkiReport` — baselined on `cvs_admin.ps1` (v3). Both job
templates retire.**

| Retires | Script | Scope |
|---|---|---|
| `admin_accounts_report-v2.yml` | `cvs_functions-v2.ps1` `-Action Get-AllAdmin-Accounts` | subdom1–7, 2 OUs each, no credentials |
| `cvs_admin.yml` | `cvs_admin.ps1` `-Action Get-AllAdmin-Accounts` | subdom1–7 + `rootdomain.net`, department filter, per-domain credential |

### Why v3, and why this is not really a choice

The programme recorded this as an open question — v2 or v3. Consolidating answers it:

- The two templates already run **the same scope for subdom1–7**, with the **same
  recipients**, the **same CC list** and the **same subject** (`Ansible-Report: Admin PKI
  Card Status`). The distribution list currently receives two near-duplicate reports.
- v3 additionally covers **`rootdomain.net`**, and that is the one domain carrying
  `credential: rootdomain`. **v2 has no credential handling of any kind** — every query
  runs as the ambient WinRM identity. A single workflow built on v2 could not reach
  `rootdomain.net` at all.
- v3 is otherwise a strict superset: department filters, `-IncludeDisabled`,
  `-FailOnQueryError`, `-ReportTitle`, per-OU error rows surfaced in the report,
  account de-duplication across overlapping search bases, and an HTML report that
  separates compliant from non-compliant with a summary line.

**P-55 is closed by re-baselining**, not by a credential fix. The delivered
`buildAdminAccountsReportInvocation` targeted `cvs_functions.ps1` carrying proposed
changes S-16…S-21 — a generation the customer had already moved past. It is replaced by
`buildAdminPkiReportInvocation`; S-16…S-21 are **withdrawn** (they specified behaviour
`cvs_admin.ps1` already implements).

### One script name to reconcile

`cvs_admin.yml:10` invokes `cvs_admin_pki_report.ps1`; the job template variables supply
`var_ps_script_file: cvs_admin.ps1`, and the repo contains `cvs_admin.ps1`. The template
variable wins at run time, so the deployed script is `cvs_admin.ps1` — but the playbook
default is stale, and worth correcting in GitLab while the two systems still run side by
side. The vRO side is unaffected: the Resource Element is named for the script it holds.

---

## 2. Workflow schema

PowerShell plug-in over WinRM, script copied from a Resource Element each run
(`_Shared/Documentation/Script-Staging-Design.md`).

```
input runAsAccount            <- dropdown, from getRunAsAccountSelectors

[ resolvePowerShellHostForAccount ]  runAsAccount -> psHost            (shared, P-52)
[ stageScriptOnHost ]                psHost, 'PSO/Scripts/cvs_admin.ps1', scriptPath
        |                            -> scriptVersion   (workflow OUTPUT)
[ buildAdminPkiReportInvocation ]    -> invocationString
[ Invoke a PowerShell script ]       (OOTB, against psHost)
[ parseScriptOutput ]                (shared, unchanged)
```

**`runAsAccount` is the AAP credential, moved onto the workflow.** In AAP the identity was
decided by the credential attached to the job template; here the operator picks it from a
list populated from `PSO/Identity/RunAsAccounts`
(`_Shared/Documentation/RunAsAccounts-Config_definition.md`). Keyed on the **account**, not
the domain — this report sweeps eight domains in one invocation, so there is no single
domain to key on, but there is exactly one account it runs as.

**No new PowerShell.** Every parameter the invocation passes already exists in
`cvs_admin.ps1` as the customer runs it today; the script is copied and invoked unmodified.

One workflow run = one script invocation. All AD querying, the compliant/non-compliant
split, the counts in the subject line, the HTML and the OU footnote happen **inside**
`cvs_admin.ps1`. There is no Orchestrator-side loop over domains — that is what makes this
one email rather than eight.

The script is copied to a stable path (`scriptPath`) on every run rather than compared
first. Ansible copies every run; so does this, for the reasons in the action header.
`cvs_admin.ps1` is ~17 KB — the playbooks currently copy the entire ~600 KB `ps_scripts`
folder to run one script.

**Second hop:** every `Get-ADUser -Server <domain>` in this report needs Kerberos
delegation on the WinRM session. AAP already runs with
`ansible_winrm_kerberos_delegation: yes` — see `Script-Staging-Design.md` §6.3, and test it
before building anything else.

---

## 3. Inputs

| Input | Type | Default (from the customer's v3 template) |
|---|---|---|
| `runAsAccount` | string (dropdown) | `svc-vro-subdom6@subdom6.company.net` — the v3 template's SSH credential |
| `scriptPath` | string | `C:\PSO\Scripts\cvs_admin.ps1` |
| `domains` | Array/string | the 8 rows in §4 |
| `ouTemplates` | Array/string | the 2 rows in §4 |
| `defaultCredentialKey` | string | *(empty)* |
| `includeDisabled` | boolean | `true` (`var_IncludeDisabled: 'yes'`) |
| `failOnQueryError` | boolean | **`true`** — changed, see P-59 |
| `reportTitle` | string | `Admin Account PKI Report` |
| `emailReport` | boolean | `true` |
| `smtpServer` | string | `mailrelay.company.com` |
| `mailTo` | Array/string | `security@…`, `Data-Protection-Team-FL@…`, `On-PremEngineering@…` |
| `mailCc` | Array/string | `someone@…`, `othersecurityteam@…`, `Monitoring@…` |
| `mailSubject` | string | `Ansible-Report: Admin PKI Card Status` |

Defaults are set **directly on the inputs**, not in a Configuration Element — the customer
preference already recorded as P-8 for a workflow whose values are static per environment.

---

## 4. Scope, as the operator sees it

`ouTemplates` — applied to every domain with no explicit `ou=`, `__DC__` replaced by that
domain's own `DC=` components. Same mechanism as `var_ou_templates` (`cvs_admin.yml:19-30`):

```
OU=GITM VG,OU=Admin Accounts,OU=GITM,OU=Domain Management,OU=AD Management,__DC__
OU=Admin Accounts,OU=Data Offshoring,OU=GITM-U,__DC__
```

`domains` — one row per domain; modifiers separated by `|`:

```
subdom1.company.net
subdom2.company.net
subdom3.company.net
subdom4.company.net
subdom5.company.net
subdom6.company.net | ou=OU=GITM VG,OU=Admin Accounts,OU=GITM,OU=Domain Management,OU=AD Management,DC=subdom6,DC=company,DC=net | ou=OU=Admin Accounts,OU=ESOC,OU=M,OU=IRM,DC=subdom6,DC=company,DC=net
subdom7.company.net | ou=OU=Admin Accounts,OU=Data Offshoring,OU=Enterprise Services,DC=subdom7,DC=company,DC=net
rootdomain.net      | ou=OU=Administrators,OU=T1,OU=Tier Administration,DC=rootdomain,DC=net | dept=DT/EI/IM/CVS | cred=rootdomain
```

Eight rows and two templates replace a 40-line YAML map. `ou=` and `dept=` repeat; `cred=`
does not. A DN contains `,` and `=` but never `|`, which is why `|` separates modifiers and
only the **first** `=` in a modifier is the delimiter.

### P-60 — `.com` vs `.net`: resolved, `.net` is correct

**Customer-confirmed 2026-08-17: the domain is `<sub>.company.net`.** The `.com` spelling in
the job-template variables as supplied was a transcription artefact, not the production
value. The rows above use `.net` throughout and no further action is needed on the scope.

The check it prompted is kept, because the failure mode it guards is real and silent. v2
passed an explicit DN for every domain, so a wrong `-Server` value merely had to resolve.
v3 **generates** the DN from the domain name for any domain with no explicit `ous:` — so a
`.com`/`.net` disagreement would search `subdom1`…`subdom5` at
`DC=subdom1,DC=company,DC=com`, fail every query, record eight error rows, and with
`-FailOnQueryError 'no'` mail a report that looks complete. `buildAdminPkiReportInvocation`
rejects any row whose `ou=` DN names a different domain than the row it sits on, so this
class of mistake becomes a rejected request rather than a short report.

**One thing still worth a look**, since it is a two-minute check: confirm the *live* v3 job
template's `var_domains` really does say `.net`. If production carries the `.com` spelling
the report has been mailing with seven of eight domains in its Query Errors table.

---

## 5. Credentials and the execution host

`cvs_admin.ps1` resolves a credential key from the **process environment**
(`cvs_admin.ps1:115-134`):

```powershell
$user = [Environment]::GetEnvironmentVariable("AD_CRED_${k}_USER")
$pass = [Environment]::GetEnvironmentVariable("AD_CRED_${k}_PASS")
```

with `$k` = the key upper-cased, non-alphanumerics to `_`. So `cred=rootdomain` reads
`AD_CRED_ROOTDOMAIN_USER` / `AD_CRED_ROOTDOMAIN_PASS`.

AAP injected these per job under `no_log: true`. Over WinRM they are **machine-level
environment variables staged at host build** (`Multi-Domain-Remediation-Plan.md` §5.2
option 1) — no secret crosses from Orchestrator and the invocation string stays fully
loggable. See `Script-Staging-Design.md` §6.2, **including the WinRM service restart the
change requires**, without which the variable exists in the registry but is invisible to the
script.

**Only one key is needed: `rootdomain`.** The other seven domains carry no `credential:` in
the customer's own template, so they run as the psHost identity exactly as they do today.
One key, one host-build step.

**This workflow is Tier 2.** One invocation sweeps eight domains, so the identity cannot be
chosen per domain by choosing a host object — that is the definition of Tier 2.
`resolvePowerShellHostForDomain` is still used, but to pick the **one** identity the sweep
runs as (`subdom6.company.net`, matching the v3 template's SSH credential today);
`rootdomain.net` is then reached through `AD_CRED_ROOTDOMAIN_*`.

---

## 6. P-59 — `failOnQueryError` defaults to `yes`

The v3 template runs `-FailOnQueryError 'no'`. This workflow defaults it to `yes`.

A consolidated run covers eight domains. A query error means one of them is missing from a
compliance report that will be read as complete. `cvs_admin.ps1` sends the mail **first**
and exits 1 afterwards (`cvs_admin.ps1:426-432`), so the report is still delivered — the run
is simply marked failed. That is the family's existing convention: end *Completed with
Errors* rather than silently under-report (cf. S-27).

The action warns loudly when an operator turns it off.

---

## 7. Ansible → Orchestrator mapping

| v2 / v3 job template | Orchestrator |
|---|---|
| `var_ps_folder` + `var_ps_script_file` | folded into `scriptPath`; the file itself is copied from a Resource Element by `stageScriptOnHost` every run (P-56) |
| `var_DomainOUs` (v2, `to_json` + `win_copy` + `-DomainOUsFile`) | `domains` rows → inline `-DomainOUs` JSON (the script accepts both; inline keeps the scope in the run history) |
| `var_domains` / `var_ou_templates` (v3) | `domains` rows + `ouTemplates` |
| `item.ous` | `ou=` modifier |
| `item.departments` | `dept=` modifier |
| `item.credential` | `cred=` modifier |
| `var_default_credential_key` | `defaultCredentialKey` |
| `var_domain_cred_env` (`environment:` + `no_log`) | machine-level `AD_CRED_ROOTDOMAIN_*` on the host (one key) |
| `var_IncludeDisabled` / `var_FailOnQueryError` | `includeDisabled` / `failOnQueryError` (booleans) |
| `var_eMailReport` / `var_SMTPServer` / `var_MailToString` / `var_MailCcString` / `var_MailSubjectstring` / `var_ReportTitle` | inputs of the same name |
| `var_winrm_port: 5985` (v3) / `port: 5986` (v2) | `PowerShell:PowerShellHost` object configuration |
| `ansible_winrm_kerberos_delegation: yes` (inventory) | Kerberos delegation on the plug-in host object — **§6.3 of `Script-Staging-Design.md`; test first** |
| `win_tempfile` / `win_file: absent` | *(dropped — the script goes to a stable path and is overwritten each run)* |
| `win_copy` (script) / `win_stat` | `stageScriptOnHost` — copies one script rather than all ~25, and **verifies** the byte count, which `win_stat` never did |
| `ls -Recurse …\debug` (v2) | dropped — a bare directory listing that was never read |
| `assert` block (v3) | input validation in `buildAdminPkiReportInvocation`, before the host is touched |

---

## 8. Change register additions

| ID | Type | Description |
|---|---|---|
| **P-55** | *Closed* | Built against `cvs_functions.ps1`; re-baselined onto `cvs_admin.ps1` |
| **P-57** | Consolidation | Two job templates → one workflow. `admin_accounts_report-v2.yml` retires; its scope is a subset of v3's and its recipients already receive the v3 report |
| **P-59** | Behaviour | `-FailOnQueryError` default `no` → `yes`. An eight-domain sweep that loses a domain must not report success |
| **P-60** | Defect (Ansible original) | Domain names `<sub>.company.com` against DNs `DC=…,DC=company,DC=net`. Under v3's `__DC__` generation this silently mis-targets every domain without an explicit `ous:` — **verify before first run** |
| **S-16…S-21** | *Withdrawn* | Specified for `cvs_functions.ps1`; `cvs_admin.ps1` already implements the equivalent |
| **S-29** | Script | `cvs_admin.ps1` gains `# PSO-SCRIPT-VERSION: <sha>` (see `Script-Staging-Design.md`) |

---

## 9. Validation additions

| # | Check | Expected |
|---|---|---|
| **V-1** | Both `ouTemplates` rows contain `__DC__` | Otherwise rejected with the "same literal DN for every domain" message |
| **V-2** | Row `subdom6.company.net \| ou=…DC=subdom6,DC=company,DC=net` | Accepted; templates NOT applied to that domain |
| **V-3** | Row `subdom1.company.com \| ou=…DC=subdom1,DC=company,DC=net` | **Rejected** — P-60 guard |
| **V-4** | A domain listed twice | Rejected; message names both row numbers |
| **V-5** | `rootdomain.net` row | JSON carries `"credential":"rootdomain"`; `AD_CRED_ROOTDOMAIN_USER` resolves on the host |
| **V-6** | `AD_CRED_ROOTDOMAIN_*` unset | `rootdomain.net` produces an error row; with `failOnQueryError=true` the run ends failed **after** the mail is sent |
| **V-7** | Generated JSON parses | `ConvertFrom-Json` on the host yields 8 keys, each with `ous` / `departments` / `credential` |
| **V-7b** | **Second hop** | `Get-ADUser -Server rootdomain.net -Filter * -ResultSetSize 1` succeeds through the bound psHost. **Run this before building anything else** — §6.3 |
| **V-7c** | Staging | `stageScriptOnHost` copies and verifies the byte count; a truncated copy fails the run rather than being invoked |
| **V-8** | Subject line | `Ansible-Report: Admin PKI Card Status ( N Non-Compliance - M Compliance )` |
| **V-9** | Against the retiring templates | Same account population per domain, allowing for v3's de-duplication and department filter |

**V-9 before cutover.** Run the workflow and the v3 template on the same day and compare
`PKI_result.csv`. The two should agree account-for-account; a difference is either the
department filter, the de-duplication, or P-60 — and each of those needs to be understood,
not averaged.
