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
| 5 | Admin Accounts Report | 2 | **Unblocked** — consolidated onto v3; design + action written |
| 6 | Service Account Expiration Reporting | 2 | Consolidated; design + action written; S-30 outstanding |
| 7 | Service Account Password Rotation | 1 | Design + 5 actions written; S-25 outstanding. **Stays on psHost** — see §7.7 |

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

**`Script-Distribution-Architecture.md`** — options analysis for how the script reaches the
host. Superseded as a transport by guest operations; its S-28 finding stands.

**`_Shared/`** (new, programme-wide). **Reference these — do not copy them.**

| File | Purpose |
|---|---|
| `Code/stageScriptOnHost.js` | Resource Element → PS host over WinRM, **every run**, byte-count verified. Returns the version for the run record |
| `Code/resolvePowerShellHostForAccount.js` | **Service account selector → psHost object.** The AAP credential decision, moved onto the workflow. Supersedes `resolvePowerShellHostForDomain` |
| `Code/getRunAsAccountSelectors.js` | Populates the selector dropdown from the Configuration Elements, so nobody types an account name |
| `Documentation/RunAsAccounts-Config_definition.md` | `PSO/Identity/RunAsAccounts` schema, host registration, wiring, validation |
| `Documentation/Script-Staging-Design.md` | The current model: what changes, failure behaviour, host-build delta, **§6.3 Kerberos delegation**, S-28, CI sync |
| `Documentation/Execution-Model-GuestOps.md` | **Deferred alternative.** Kept for the analysis and the conditions that would justify revisiting it |

**Reporting consolidations** (each replaces **two** job templates with one workflow, with
**no PowerShell changes** — both target scripts the customer already runs)

| File | Purpose |
|---|---|
| `Admin Accounts Report/Code/buildAdminPkiReportInvocation.js` | v3 baseline; domain rows + `__DC__` templates; OUs, department filters, credential keys → one invocation |
| `Admin Accounts Report/Documentation/06_Consolidation-Design-v3.md` | Decision, scope model, credential model, P-59/P-60, validation |
| `Service Account Expiration Reporting/Code/parseServiceAccountScopes.js` | Scope rows → per-invocation entries, each carrying its own run-as account; all validation before the first host is touched |
| `Service Account Expiration Reporting/Code/buildServiceAccountScopeInvocation.js` | One invocation per scope; `ou=`/`group=` selects the script's existing `-Action` |
| `Service Account Expiration Reporting/Documentation/06_Consolidation-Design.md` | Decision, deferred **S-30** contract, P-61, validation |

---

## 7. Open questions

1. ~~**Admin Accounts Report: v2 or v3?**~~ **Resolved 2026-08-17 — v3.** Consolidating the
   two templates into one workflow decides it: v3 is the only baseline that can reach
   `rootdomain.net`, the one domain carrying a per-domain credential. v2 retires; S-16…S-21
   are withdrawn. See `Admin Accounts Report/Documentation/06_Consolidation-Design-v3.md`.
2. **Domain inventory** — the full list in scope per workflow. Partly answered for
   projects #5/#6 by the job-template variables; **P-60/P-61 (`.com` vs `.net`) must be
   confirmed before either runs.**
3. **Reset Password delegation** — confirm per domain, on the target OU, before S-25 goes
   to production.
4. ~~**Tier 2 credential staging**~~ **Resolved — option 1.** `AD_CRED_*` staged as
   machine-level environment variables at host build; nothing crosses from Orchestrator.
   Requires a WinRM restart to take effect (`_Shared/Documentation/Script-Staging-Design.md` §6).
5. **Script distribution** — **resolved.** `stageScriptOnHost` copies the script from a
   Resource Element to the PS host on every run, over the same WinRM session that invokes
   it. Who owns the GitLab→Resource Element sync is still open, but **no longer blocking**:
   dropping the S-29 marker removed the CI prerequisite, so the Resource Element can be
   updated by hand until a pipeline exists.
6. **Kerberos delegation (P-65)** — verify the plug-in host object makes the second hop
   before building anything else. AAP already does this with
   `ansible_winrm_kerberos_delegation: yes`, so the AD side is expected to be in place.
7. **Execution model** — **resolved 2026-08-18: one model, all seven projects.** A hybrid was
   considered (guest operations for the two `microsoft.ad.user` playbooks, psHost for the
   rest) and rejected. Password Rotation stays on psHost: guest operations have no output
   channel but a file, which would put the generated password on disk against a design
   built to avoid exactly that; it is Tier 1, so the host object already carries the
   identity; five actions exist; and its second hop is answerable with `-Credential` on
   S-25, as `microsoft.ad.user` already does. `Execution-Model-GuestOps.md` is retained as
   the contingency if delegation cannot be made to work.

---

## 8. Change register IDs in play

| ID | Description |
|---|---|
| P-45…P-50 | Defects in the Ansible password rotation original |
| P-51 | Single-`psHost` assumption recorded as intended; invalid for a multi-domain estate |
| P-52 | Tier 1 per-domain host resolution (4 projects) |
| P-53 | Tier 2 multi-domain sweep (2 projects) |
| P-54 | Cross-domain group members silently skipped — resolved via S-27 |
| P-55 | Admin Accounts Report built against the superseded script — **closed** by the v3 re-baseline |
| P-56 | Execution model: script staged per run from a vRO Resource Element, superseding P-1/P-9/P-20 |
| P-57 | Admin Accounts Report: two job templates → one workflow; v2 retires |
| P-58 | Service Account Expiration: two job templates → one workflow; the duplicate 58 KB script retires |
| P-59 | `-FailOnQueryError` defaults to `yes` on both reports — a multi-domain sweep that loses a domain must not report success |
| P-60 | *Resolved* — the domain is `<sub>.company.net`; the `.com` spelling was a transcription artefact. The domain/DN agreement check is retained in the scope action, since under v3's `__DC__` generation a mismatch mis-targets silently |
| P-61 | Service account templates: credential/domain spellings to confirm |
| S-25 | `Set-ServiceAccountPassword` — new write action, not yet written |
| S-26 | Port `Get-DomainCredential` + per-domain keys into `cvs_functions.ps1` — **absorbed by S-30** |
| S-27 | Foreign group member: `Warn:` → `Error:` so the run ends "Completed with Errors" |
| S-28 | Five `out-File -append` sites in `cvs_functions*.ps1` grow unboundedly against a persistent script directory; move `$DebugDir` off `$PSScriptRoot`. **Does not affect projects #5/#6** — `cvs_admin.ps1` is already clean and the service report inherits current behaviour |
| ~~S-29~~ | Version marker — **dropped 2026-08-18.** `stageScriptOnHost` copies every run, so there is nothing to compare; removing it also removes the CI-stamping prerequisite from the critical path |
| S-30 | `cvs_svcaccounts.ps1` — **deferred.** Needed only to turn the service report's two emails into one; contract written |
| ~~P-62~~ ~~P-63~~ ~~P-64~~ | Guest-operations execution model — **withdrawn 2026-08-18.** Deferred for delivery speed and handover friction; P-52 stays on. Analysis kept in `_Shared/Documentation/Execution-Model-GuestOps.md` |
| P-65 | Kerberos delegation on the plug-in host objects, matching AAP's `ansible_winrm_kerberos_delegation: yes`. **Verification, not new AD work — but the first thing to test** |
