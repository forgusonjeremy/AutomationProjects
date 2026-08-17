# Ansible → Orchestrator Transition — Status Summary

**Date:** 2026-08-17
**Scope:** Service Account Password Rotation (new) + multi-domain remediation across six delivered transitions

---

## 1. What happened today

Work started on transitioning `account_password_update.yml` — the AD service account
password rotation — from AAP to Orchestrator. Analysing how that playbook obtained its
credentials surfaced a **cross-cutting defect in the delivered vRO work**: every
transition assumes a single Active Directory identity, and the customer's estate spans
multiple domains that each require their own.

The transition work is now two workstreams: the rotation project itself, and a
remediation pass over the six delivered transitions that share the assumption.

---

## 2. The password rotation transition

### What the Ansible version does

One job template per service account (three of them). Each run generates a random
password, sets it on **one** AD account, then PATCHes that password into the AAP
credential objects that store it — so AAP can keep authenticating as that account.

`var_Credential_type` is not a list of accounts. It is a list of AAP credential
**types** — the storage slots one account's password occupied. `Machine` is the AAP
built-in whose values become `ansible_user` / `ansible_password`; the `*-WinRM_Cred` and
`*-CenterAdmin_Cred` types are customer-defined, injecting named extra_vars a playbook
must reference explicitly.

### Scope decision

**vRO replaces AAP as the consumer.** The entire AAP-facing half of the playbook
(`aap_password_reset.yml`) retires — no credential PATCH, no `controller_host`, no
`var_Credential_type` equivalent. Because AAP no longer holds the password, vRO must,
and there is no second copy anywhere.

### The credential object store

Requested as a composite type per credential. Built as **composite at runtime, flat
`SecureString` at rest** — vRO applies at-rest encryption, editor masking and run-history
redaction **per attribute**, so a password nested inside a composite is an ordinary
string to vRO and prints in clear from any `JSON.stringify` added while debugging.

One Configuration Element per service account under `PSO/Identity/ServiceAccounts`,
carrying `samAccountName`, `userPrincipalName`, `domainServer`, `ldapBaseDN`, a
`SecureString` `password` and `passwordLastRotated`. Adding a fourth account is a config
change, not a new workflow.

### The password never travels downward

The generated password is created **on the PowerShell host** with a CSPRNG and returned
upward on a single marked line. Two reasons: vRO's `Math.random()` is a clock-seeded PRNG
whose entropy is bounded by its seed regardless of password length; and a password passed
*down* lands in the invocation string, which is the most-logged value in this family of
actions. Travelling upward leaves exactly one exposure point to control.

### Ordering

AD first, store second. Both orderings can leave the two disagreeing, but "store holds a
password AD never accepted" locks accounts out, while "store holds the previous password"
merely fails authentication. Both are repaired by **re-running the rotation**, which is
why no compensating rollback exists — and why the PS host's own credential must never be
one of the accounts being rotated, or that recovery path closes.

### Defects found in the Ansible original

| ID | Finding |
|---|---|
| P-45 | `state: present` + `path:` — a typo in `var_sAMAccountName` **created** an orphan account and reported success |
| P-46 | Nothing correlated `var_sAMAccountName` with `var_LDAPUsername` — AD reset one identity while AAP recorded another |
| P-47 | `hosts: all` with no `run_once` — a multi-host inventory sets a different password per host and races the PATCH |
| P-48 | All four PATCH tasks share `register: update_result`, and a **skipped** task overwrites it — so `Machine` and `*-WinRM_Cred` succeeded **silently**, which is most of why the run logs were unreadable |
| P-49 | PATCH sends a whole `inputs` object, dropping any field not in the body |
| P-50 | The `VMware vCenter` branch is unreachable in this estate — ~25 lines of dead code |

P-45 to P-48 are fixed by construction in the vRO design. P-49/P-50 are moot once the
AAP half retires.

---

## 3. The multi-domain defect

### How it surfaced

The customer's infrastructure spans subdomains. The PowerShell pool is domain1-joined,
but some AAP templates log into it with a **domain2 account** — because the AD query they
run targets domain2.

### Why it matters

`cvs_functions.ps1` contains **zero** uses of `-Credential`. Every AD and remote call runs
as the **ambient identity of the PowerShell session**, so the account logging into the
pool silently decides which domains the script can reach.

AAP varied that account **per job template**. vRO moved the choice to the
`PowerShell:PowerShellHost` object and bound one host object everywhere — documented in
`Ansible-to-vRO-MappingTable.md:105` as *"All workflows use a single psHost plugin object
(intended)"*. That assumption is now invalid.

**Transitive trust does not help.** A domain2 account logging into a domain1 server proves
authentication and logon rights exist. Reading an OU, resetting a password or running a
command in domain2 are grants made **per domain** — no trust configuration confers them.

### The fix

Multiple `PowerShellHost` objects against the **same pool FQDN**, one per domain identity,
resolved at run time from a domain→host Configuration Element map. Name them for the
**identity**, not the server, and use Shared Session mode.

Splits into two tiers:

- **Tier 1 — one domain per run.** Four projects. Binding change only; no PowerShell touched.
- **Tier 2 — several domains in one run.** Two report projects. A single invocation carries
  a single identity, so host selection alone is insufficient.

### Tier 2 is already solved — by the customer

The v3 admin report (`cvs_admin.yml` → `cvs_admin.ps1`) already implements per-domain
credentials: a `credential` key per domain in the scope map, resolved from
`AD_CRED_<KEY>_USER` / `AD_CRED_<KEY>_PASS` environment variables with a
`-DefaultCredentialKey` fallback, injected by Ansible under `no_log: true`.

Tier 2 should **port this pattern**, not invent one. An earlier DPAPI-based proposal has
been withdrawn.

---

## 4. Confirmed decisions

| Question | Answer |
|---|---|
| Service account model | **One per domain**, mirroring current AAP configuration |
| Can targeting groups span domains? | **No** — single-domain groups (closes P-54) |
| AAP after transition | **Retired** as consumer; vRO holds the credentials |
| Datastore Capacity Reporting | **Withdrawn** — handled natively by VCF Operations |
| Move Windows Event Logs | **In scope** for remediation |

---

## 5. Work order

| # | Project | Tier | Status |
|---|---|---|---|
| 1 | Move Windows Event Logs | 1 | **In progress** — establishes the Tier 1 pattern |
| 2 | Server Reboots | 1 | Pending |
| 3 | Servers Reboot Report by CN | 1 | Pending |
| 4 | Windows Server Clean Disks | 1 | Pending |
| 5 | Admin Accounts Report | 2 | **Blocked** — see §7 |
| 6 | Service Account Expiration Reporting | 2 | Pending (S-26) |
| 7 | Service Account Password Rotation | 1 | Design + 5 actions written; S-25 outstanding |

Projects 1–4 share one pattern; #1 establishes it and the rest follow mechanically.

**Re-baseline every project against `GitLab-Repos-Sanitized` before writing its Change
Register.** §7 shows the cost of not doing so.

---

## 6. What has been built

**`Service Account Password Rotation/`**

| File | Purpose |
|---|---|
| `Design-Notes.md` | CE schema, secret flow, ordering, workflow steps, S-25 contract |
| `Code/getServiceAccountCredential.js` | Read half of the store → composite; rejects a non-`SecureString` password attribute |
| `Code/setServiceAccountPassword.js` | Write half; read-back verification; explicit post-AD failure messaging |
| `Code/buildPasswordRotationInvocation.js` | Invocation builder, `whatIf` gate, carries no secret |
| `Code/extractRotatedPassword.js` | Single exposure point; fail-closed transcript sanitising |
| `Code/resolvePowerShellHostForDomain.js` | Domain → PS host object resolution (**promote to shared**) |

**`Multi-Domain-Remediation-Plan.md`** — full cross-project analysis, tier model,
per-project impact, remediation steps, change register IDs P-51…P-55, S-26, S-27.

---

## 7. Open questions

1. **Admin Accounts Report: v2 or v3?** The delivered vRO workflow targets
   `cvs_functions.ps1 -Action Get-AllAdmin-Accounts` (S-16…S-21), but the customer has
   moved to `cvs_admin.ps1`, which additionally has per-domain credentials, department
   filters, `-IncludeDisabled`, `-FailOnQueryError` and a PKI/smartcard focus. Re-baseline
   onto v3, or is v3 being retired? **Blocks project #5.**
2. **Domain inventory** — the full list in scope per workflow.
3. **Reset Password delegation** — confirm per domain, on the target OU, before S-25 goes
   to production.
4. **Tier 2 credential staging** — stage `AD_CRED_*` on the PS host at build time
   (recommended, nothing crosses from Orchestrator), or inject from Configuration Element
   SecureStrings into a never-logged invocation string?

---

## 8. Change register IDs in play

| ID | Description |
|---|---|
| P-45…P-50 | Defects in the Ansible password rotation original |
| P-51 | Single-`psHost` assumption recorded as intended; invalid for a multi-domain estate |
| P-52 | Tier 1 per-domain host resolution (4 projects) |
| P-53 | Tier 2 multi-domain sweep (2 projects) |
| P-54 | Cross-domain group members silently skipped — resolved via S-27 |
| P-55 | Admin Accounts Report built against the superseded script |
| S-25 | `Set-ServiceAccountPassword` — new write action, not yet written |
| S-26 | Port `Get-DomainCredential` + per-domain keys into `cvs_functions.ps1` |
| S-27 | Foreign group member: `Warn:` → `Error:` so the run ends "Completed with Errors" |
