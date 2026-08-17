# Service Account Password Rotation — Design Notes (draft)

Transition source: `GitLab-Repos-Sanitized/admins/account_password_update.yml` + `roles/account/`
Job templates replaced: `1A_PW-Change_svcacct1`, `1A_PW-Change_svcacct2`, `1A_PW-Change_svcacct3`
Module: `com.broadcom.pso.vcf.identity.ad.accounts.passwordRotation`
Change Register: **S-25** (PowerShell), **P-45…** (platform/transition)

---

## 1. Scope decision: AAP is retired, vRO becomes the consumer

The Ansible playbook did two things: reset an AD password, then PATCH that password
into AAP credential objects so AAP could keep authenticating with it.

Post-transition, **vRO replaces AAP as the consumer of these accounts**. That removes
the entire second half of the playbook:

| Ansible component | Disposition |
|---|---|
| `roles/account/tasks/main.yml` | Replaced by the rotation workflow |
| `roles/account/tasks/adds_password_reset.yml` | Replaced by S-25 `Set-ServiceAccountPassword` |
| `roles/account/tasks/aap_password_reset.yml` | **Retired.** No AAP, no credential PATCH, no `controller_host` |
| `roles/account/tasks/aap_password_reset.bk.yml` | **Retired** (already dead) |
| `var_AAP_Credentials`, `var_AAP_organization`, `var_AAP_VCenter_Host`, `var_Credential_type`, `controller_host` | **No equivalent.** These existed only to address AAP |

Because AAP no longer holds the password, **something in vRO must**. That is the
credential object store below — and it is now load-bearing in a way the AAP
credentials never were, because there is no second copy anywhere.

### 1.1 Why `var_Credential_type` collapses to nothing

`var_Credential_type` looks like a list of accounts. It is not — it is a list of AAP
**credential types**, i.e. the storage slots one account's password occupied:

| Type | What it is | How the playbook writes it |
|---|---|---|
| `Machine` | AAP built-in. Fixed schema; AAP wires it into the connection as `ansible_user` / `ansible_password` / `ansible_become_*` | username, password, `become_method: runas`, become_username, become_password |
| `myOrg-WinRM_Cred` | Customer-defined **custom** type. Injector maps its inputs onto named extra_vars | username, password only |
| `myOrg-CenterAdmin_Cred` | Customer-defined custom type, same shape | username, password only |

The custom types' definitions live in AAP, not in git. Their injected variable names
are nonetheless visible in the repo as variables that are *used but never defined* —
`WinRM_username` / `WinRM_password` in `psscript/file-move_with-UNCPath_AD-Group.yml`,
`admins/roles/gitlab/tasks/main.yml` and others — which is the signature of a custom
credential type's injector configuration.

Both forms hold the **same account and the same password**. For `svcacct1`, `Machine`
and `myOrg-WinRM_Cred` both receive `var_LDAPUsername` and the same `acc_new_pw`. They
differ only in how AAP hands them to a playbook: implicitly, as the connection
identity (Machine, one per job template), or explicitly, as named variables a playbook
can pass to a delegated connection, a CIFS mount or a `New-Object PSCredential`
(custom, several per job template). The Kerberos/delegation connection profile in
`admins/inventory/on_winrm_servers` is why the addressable form was needed at all.

vRO has neither an injector mechanism nor a one-credential-per-template limit — the
PowerShell host carries its own credential and workflows read what they need
explicitly. So the split collapses: **one** username/password pair per account, stored
once, with no per-type fan-out and no `var_Credential_type` equivalent.

---

## 2. The credential object store

### 2.1 Composite at runtime, flat SecureString at rest

The requested model — one composite object per credential, with `username` and
`password` properties — is what the workflow consumes, and `getServiceAccountCredential`
returns exactly that.

It is **not** how the password is stored. vRO applies SecureString protection
(at-rest encryption, masking in the Configuration Element editor, redaction in the
workflow token variable view) **per attribute**. A password held as a field inside a
composite-typed or `Properties`-typed attribute is an ordinary string to vRO:

- shown in clear in the Configuration Element editor
- present in clear in run history
- printed in clear by any `System.log(JSON.stringify(cred))` added while debugging

The last one is what actually causes the incident, because it happens during
troubleshooting rather than by design.

So the password is a **dedicated top-level `SecureString` attribute**, and the
composite is assembled in memory for the life of the run. `getServiceAccountCredential`
**refuses to run** if the attribute is typed anything other than `SecureString` —
a plain-string `password` attribute works mechanically, which is precisely why it has
to be a hard failure rather than a warning.

Note that once read into JavaScript, a SecureString **is** a plain String and carries
none of its protection forward. The returned composite therefore exposes
`toSafeString()`, so the reflex to print the credential lands somewhere harmless.

### 2.2 Configuration Element schema

Category: `PSO/Identity/ServiceAccounts` (configurable — passed as `categoryPath`)
One element per service account, named for the account.

| Attribute | Type | Required | Source in the old job template |
|---|---|---|---|
| `samAccountName` | string | yes | `var_sAMAccountName` |
| `userPrincipalName` | string | yes | `var_LDAPUsername` |
| `domainServer` | string | yes | `var_domain_server` |
| `ldapBaseDN` | string | yes | `var_LDAPBaseDN` |
| `password` | **SecureString** | yes (may be empty pre-first-run) | *no equivalent — never stored* |
| `passwordLastRotated` | Date | no (warns) | *no equivalent* |

Populated from the three job templates:

| Element | samAccountName | userPrincipalName | domainServer |
|---|---|---|---|
| `svcacct1` | svcacct1 | svcacct1@dom2.dom1.com | dc.dom2.dom1.com |
| `svcacct2` | svcacct2 | svcacct2@dom2.dom1.com | dc.dom2.dom1.com |
| `svcacct3` | svcacct3 | svcacct3@dom2.dom1.com | dc.dom2.dom1.com |

All three share `ldapBaseDN = OU=Service Accounts,OU=test,OU=something,DC=dom2,DC=dom1,DC=com`.

Adding a fourth service account is a new Configuration Element — **not** a new
workflow, and not a new job template.

---

## 3. Secret flow: the password travels *upward* only

The obvious port generates the password in Orchestrator and passes it down to
PowerShell. Rejected, for two independent reasons:

**Entropy.** `ansible.builtin.password` drew on the controller's CSPRNG. vRO's
JavaScript engine offers `Math.random()` — a plain PRNG with a small clock-seeded
state. Length does not rescue this: a 34-character password from `Math.random()` has
the entropy of the seed, not of its alphabet, and the rotation time is recorded in run
history. The PS host can use `System.Security.Cryptography.RandomNumberGenerator`.

**Exposure.** A password passed *down* appears in the invocation string — the single
most-logged value in this family of actions. `buildServiceAccountExpirationInvocation.js:435`
logs it verbatim, and the OOTB invoke workflow surfaces it as a token variable. Each
exposure would have to be individually suppressed and stay suppressed as the code is
maintained. A password travelling *upward* has exactly one exposure point.

```
 vRO                          PS host
  │                              │
  ├── invocation (no secret) ───▶│  generate w/ CSPRNG
  │   …safe to log in full…      │  Set-ADAccountPassword
  │                              │
  │◀── transcript + 1 marked ────┤  ##VRO-SECRET-BEGIN##…##VRO-SECRET-END##
  │    line                      │  (success stream ONLY — never Write-Log,
  │                              │   so it never reaches the Debug file)
  │
  ├── extractRotatedPassword ──▶ password (SecureString)  ─┐
  │                            └ sanitizedOutput ──────────┼─▶ logged, parsed, reported
  │                                                        │
  └── setServiceAccountPassword ◀──────────────────────────┘
```

**Handling contract** — the design only holds if all four hold:

1. Raw script output is never logged, by any action or by the workflow.
2. Raw output is never bound to a workflow *output* parameter.
3. The extracted password is bound to a **SecureString** variable.
4. Sanitising is fail-closed — a malformed marker throws rather than passing a
   transcript through that might still contain the secret.

---

## 4. Ordering: AD first, store second

There is no transaction spanning AD and the Configuration Element. One is always
written first, and a failure between them leaves them disagreeing. The question is
only which disagreement is cheaper:

- **Store first, AD fails** → store holds a password AD never accepted. Every
  consumer fails *and* repeated attempts lock the account out. Worst case.
- **AD first, store fails** → store holds the previous password, which AD no longer
  accepts. Consumers fail, but the account is not being hammered with a password that
  was never valid.

Both are repaired by the same action: **re-run the rotation.** A rotation is
idempotent in effect — fresh password, set in AD, store it — so a half-completed run
is corrected by running it again. That is why no compensating rollback exists, and it
is worth preserving in future changes.

Every error message in `setServiceAccountPassword` after the AD call states
`THE AD PASSWORD HAS ALREADY BEEN CHANGED` explicitly, so the operator is never left
guessing which side of the boundary a failure landed on.

---

## 4.1 The rotation must never target its own identity

**Hard rule: the PowerShell host's credential must not be one of the accounts this
workflow rotates.**

The Ansible original was exposed to this. It authenticated two ways — the Machine
credential attached to the job template supplied `ansible_user` / `ansible_password`
for the AD reset, and a Red Hat AAP credential supplied `CONTROLLER_USERNAME` /
`CONTROLLER_PASSWORD` through the environment for the API calls — and then rewrote
credential objects in the very system holding both. If a run ever targeted an account
it was itself authenticating with, and the AD reset succeeded while the AAP PATCH
failed, the next run could not connect to repair the first. The recovery path
(§4: re-run the rotation) would be closed off by the failure it exists to recover from.

vRO inherits the same shape: the PS host connects as a stored identity, and the
workflow changes AD passwords. The rule above keeps the recovery path open
unconditionally — a failed rotation is always repairable by running it again, because
the credential that runs it is never one of the credentials it changes.

Enforcement is operational, not code: the PS host account is configured once, outside
this workflow, and is not among the Configuration Elements in §2.2. Worth an explicit
line in 03_Implementation_Guide and a check at cutover.

## 4.2 Multi-domain: one host object per identity

**This supersedes `Ansible-to-vRO-MappingTable.md:105` — "All workflows use a single
psHost plugin object (intended)". That assumption is wrong and affects delivered work.**

Nothing in `cvs_functions.ps1` passes `-Credential` — verified, zero occurrences. Every
`Get-ADUser -Server`, `Get-ADGroupMember -Server`, `Get-ADComputer -Server` and
`Invoke-Command` runs as the **ambient identity of the PowerShell session**. So the
account logging into the pool silently decides which domains the script can read.

In AAP that account was chosen **per job template**, via the attached Machine
credential, against the same server pool. The customer's pool is domain1-joined; some
templates log into it with a domain1 account, others with a domain2 account — not a
quirk, but the mechanism by which a template obtained rights in the domain it queried.

vRO moved that choice from the workflow to the PowerShell host object and bound one
host object everywhere, leaving the variation nowhere to go.

**Fix: multiple `PowerShell:PowerShellHost` objects against the same pool FQDN, one
per domain identity, resolved at run time** (`resolvePowerShellHostForDomain`).

```
Configuration Element category: PSO/Identity/Domains
  Element: dom2.dom1.com
    psHostName    string   REQUIRED   name of the PowerShellHost object
    domainServer  string   optional   preferred DC
```

Registration, once per identity, all pointing at the same server:

| `name` | `host` | `username` |
|---|---|---|
| `pshost-dom1` | `pool01.dom1.com` | `svc-vro-dom1@DOM1.COM` |
| `pshost-dom2` | `pool01.dom1.com` | `svc-vro-dom2@DOM2.COM` |

Three things that are load-bearing rather than cosmetic:

1. **Name host objects for the IDENTITY, not the server.** The registration workflow
   takes `name` separately from `host`. Two objects sharing one FQDN are
   indistinguishable in the inventory if both are named after the server, and picking
   the wrong one produces access-denied errors that look nothing like a naming
   problem. `resolvePowerShellHostForDomain` treats duplicate names as fatal.
2. **Shared Session is required.** Per-user session mode authenticates as the vRO
   user and defeats the mechanism entirely.
3. **A trust authenticates; it never authorises.** A domain2 account logging into a
   domain1 server proves the trust and the logon right exist. It says nothing about
   whether that account can *reset a password* in domain2 — that is a delegated right
   granted per domain, on the target OU.

### What this fixes, and what it does not

**Tier 1 — one domain per run.** Server Reboots, Clean Disks, Move Windows Event Logs,
Reboot Report ByCN, and this rotation. Fully fixed. It is a **binding change, not a
code change**: `psHost` is currently a pre-bound workflow *attribute*
(`Server Reboots/02_Design_Document.md:87`), so it becomes an input, or a domain input
resolved through this action. No PowerShell touched.

**Tier 2 — several domains in one run.** Admin Accounts Report and Service Account
Expiry deliberately sweep every domain in a single invocation and send one email. A
single invocation carries a single identity, so host selection alone does not fix
them — they must either run once per domain (N invocations, and N emails unless the
reporting moves out of PowerShell into vRO) or gain explicit `-Credential` handling
inside the script, sourced from DPAPI-encrypted credential files staged on the PS host
so no secret crosses from Orchestrator.

Tier 2 is out of scope for this project and is recorded here so it is not lost.

### Promotion

`resolvePowerShellHostForDomain` is not specific to password rotation. When the Tier 1
workflows are re-bound it should move to a shared module and be referenced, not
copied — the domain map needs exactly one definition.

## 5. Workflow design

**Workflow:** `Rotate Service Account Password`

| Input | Type | Notes |
|---|---|---|
| `accountName` | string | Configuration Element name, e.g. `svcacct1` |
| `categoryPath` | string | default `PSO/Identity/ServiceAccounts` |
| `scriptPath` | string | full path to `cvs_functions.ps1` on the PS host |
| `domainCategoryPath` | string | default `PSO/Identity/Domains` — domain→host map (§4.2) |
| `passwordLength` | number | default 34 |
| `whatIf` | boolean | **default true** |

| # | Step | Action / workflow |
|---|---|---|
| 1 | Read + validate the credential | `getServiceAccountCredential` |
| 1b | Resolve the PS host for the account's domain | `resolvePowerShellHostForDomain` |
| 2 | Build the invocation | `buildPasswordRotationInvocation` |
| 3 | Invoke on the resolved PS host | OOTB *Invoke a PowerShell script* |
| 4 | Split secret from transcript | `extractRotatedPassword` |
| 5 | Decision: `passwordFound`? | false (whatIf) → step 7 |
| 6 | Commit to the store | `setServiceAccountPassword` |
| 7 | Classify + report | existing `parseScriptOutput` on **`sanitizedOutput`** |

All validation that can fail lives in step 1, before AD is touched — which is what
keeps the window in §4 as short as possible.

`whatIf` defaults to **true**, matching the Clean Disks transition. The Ansible
original had no dry-run mode at all: running the job template *was* the rotation.

---

## 6. S-25 — PowerShell contract

New `-Action 'Set-ServiceAccountPassword'` in `cvs_functions.ps1`.

New parameters: `-SamAccountName`, `-DomainServer`, `-PasswordLength`, `-WhatIfMode`.
Reuses the existing `-OUPath` as a search base.

Requirements:

1. Resolve **exactly one** account by `sAMAccountName` under `-OUPath` on
   `-DomainServer`. Zero or more than one → error, no write.
   *This is the fix for the original's `state: present` + `path:` behaviour, where a
   typo in `var_sAMAccountName` created a new account in the OU and reported success.*
2. Generate with `System.Security.Cryptography.RandomNumberGenerator`, guaranteeing
   complexity **by construction** (≥1 char per required class, then shuffle) — so the
   fixed `J1M!_` literal that prefixed every password in the estate is not carried over.
   Alphabet excludes `#` (marker safety) and whitespace.
3. `Set-ADAccountPassword -Reset` against the resolved DN, on `-DomainServer`.
4. Emit the password on **one line, success stream only**:
   `##VRO-SECRET-BEGIN##<password>##VRO-SECRET-END##`
   **Never** through `Write-Log` — that would write it to the Debug transcript file
   left on the PS host.
5. `-WhatIfMode 'yes'` → resolve and report only. Generate nothing, write nothing,
   emit no marker.

> **ValidateSet note.** The script header explains why `Set-L3-Admin-Accounts` is
> deliberately absent from the `-Action` ValidateSet, and warns that adding a write
> action requires a separate reviewed change. S-25 **is** that change. It is scoped to
> one explicitly-named account per invocation with no filter-based mass path — which
> is the property that made the omission of `Set-L3-Admin-Accounts` necessary and that
> this action must never acquire.

---

## 7. Defects in the Ansible original (Change Register candidates)

| ID | Finding | Consequence |
|---|---|---|
| P-45 | `microsoft.ad.user` used `state: present` with `path:`; `identity` not found → **creates** the account | A typo in `var_sAMAccountName` created an orphan account in the Service Accounts OU and reported success |
| P-46 | Nothing correlated `var_sAMAccountName` with `var_LDAPUsername` | AD reset one identity while AAP recorded another; surfaced later as lockouts. Now checked in `getServiceAccountCredential` |
| P-47 | `hosts: all`, no `run_once` on generation or the AD reset | A multi-host inventory sets a different password per host and races the AAP PATCH. Last write wins, and AD and AAP need not agree |
| P-48 | All four PATCH tasks share `register: update_result`; a **skipped** task overwrites it | The `✓ Successfully updated` message only ever fired on the last credential type. `Machine` and `myOrg-WinRM_Cred` succeeded **silently** — no success line, no warning |
| P-49 | PATCH sends a whole `inputs` object | Any input field not in the body is dropped from the credential |
| P-50 | `VMware vCenter` branch unreachable in this estate | ~25 lines of dead code; `var_AAP_VCenter_Host` empty in all three templates |

P-45 through P-48 are fixed by construction in the vRO design. P-49 and P-50 are moot
once the AAP half retires (§1), and are recorded only so the retirement is evidenced.

---

## 8. Open items

- [ ] Confirm the PS host service account holds *Reset Password* on the Service
      Accounts OU (the [PS host build guide](../../Completed/_Shared%20References/PowerShell%20Host%20Build%20Guide/How-To-Build-a-PowerShell-Host.md) covers Kerberos setup, not AD delegation).
- [ ] Identify every future vRO consumer of these three accounts — with AAP gone, the
      store is the only copy.
- [ ] Decide whether rotation is scheduled or on-demand. The Ansible version was
      operator-triggered per template.
- [ ] Docs 01–05 + Change-Register, per the established pattern.
