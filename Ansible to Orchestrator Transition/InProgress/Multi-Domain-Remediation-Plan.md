# Multi-Domain Identity — Cross-Project Remediation Plan

**Status:** Active — customer answers folded in 2026-08-17
**Affects:** 6 transitions
**Supersedes:** `Move Windows Event Logs/_Shared/Documentation/Ansible-to-vRO-MappingTable.md:105`

---

## 1. The defect

Every delivered vRO transition binds **one** `PowerShell:PowerShellHost` object carrying
**one** service account. The mapping table records this as deliberate:

> `No Ansible inventory in vRO | Cannot address multiple PS hosts | All workflows use a single psHost plugin object (intended)`

The assumption is wrong for this customer.

`cvs_functions.ps1` contains **zero** uses of `-Credential`. Every `Get-ADUser -Server`,
`Get-ADGroupMember -Server`, `Get-ADComputer -Server` and `Invoke-Command` runs as the
**ambient identity of the PowerShell session**. The account that logged into the pool
therefore decides, silently, which domains the script can read and write.

AAP varied that account **per job template** against the same server pool. The pool is
domain1-joined; some templates log into it with a domain1 account and others with a
domain2 account — the mechanism by which each template obtained rights in the domain it
queried. vRO moved the choice from the workflow to the host object and bound one host
object everywhere, leaving the variation nowhere to go.

### 1.1 Authentication is not authorisation

A domain2 account logging into a domain1 server proves the **trust** and the **logon
right** exist. It says nothing about whether that account may read an OU, reset a
password, or run a command in domain2 — those are grants made **per domain**, on the
target object. No trust configuration confers them.

### 1.2 Confirmed: one service account per domain

**Customer-confirmed 2026-08-17.** Mirrors the current AAP template configuration. One
dedicated vRO service account per domain, granted rights only in that domain; one
`PowerShell:PowerShellHost` object per account.

---

## 2. Tier model

| | Tier 1 | Tier 2 |
|---|---|---|
| **Shape** | One domain per run | Several domains in one run |
| **Fix** | Resolve the PS host object per domain at run time | Per-domain credentials inside one invocation |
| **Code change** | **None** — binding only | Yes — but **the customer has already built it**, see §5.2 |
| **Effort** | Low | Medium |

---

## 3. Per-project impact

| Project | Tier | Why | Change |
|---|---|---|---|
| **Move Windows Event Logs** | 1 | ByCN resolver, one `-Server` per run | P-52 |
| **Server Reboots** | 1 | `Get-ListOfServers-Direct`, one `-Server` per run | P-52 |
| **Servers Reboot Report by CN** | 1 | `Get-ServerPendingRebootStatus`, one domain per run | P-52 |
| **Windows Server Clean Disks** | 1 | `clean-ServerDisk`, one domain per run | P-52 |
| **Admin Accounts Report** | **2** | Multi-domain sweep — **and needs re-baselining, see §4** | P-53, **P-55** |
| **Service Account Expiration Reporting** | **2** | domain→OU map (S-22), multi-domain sweep, one email | P-53 |
| VM Snapshots Cleanup | — | vCenter-native, no PS host | None |
| ~~Datastore Capacity Reporting~~ | — | **Withdrawn** — handled natively by VCF Operations | None |

---

## 4. Admin Accounts Report is a re-baseline, not a credential fix (P-55)

The customer runs **two** admin report templates. Both were read and confirmed:

### v2 — `psscript/admin_accounts_report-v2.yml`

Single run, multiple domains. `var_DomainOUs` is serialised to JSON, staged with
`win_copy`, and passed as `-DomainOUsFile`. **No credential handling of any kind** — it
relies entirely on the ambient WinRM identity. Genuinely Tier 2 as originally assessed.

### v3 — `psscript/cvs_admin.yml` → `files/ps_scripts/cvs_admin.ps1`

Single run, multiple domains — **and it already solves the per-domain credential
problem.** It is a different script from `cvs_functions.ps1`.

Scope construction (`cvs_admin.yml:19-38`) builds a domain map from `var_domains`, each
entry carrying its own OUs, department filter and **credential key**:

```yaml
item.name: {
  'ous':         item.ous | default( var_ou_templates | map('replace','__DC__', ...) ),
  'departments': item.departments | default([]),
  'credential':  item.credential  | default('')
}
```

Multiple OUs per domain are supported two ways: explicitly via `item.ous`, or generated
from `var_ou_templates` with `__DC__` substituted by the domain's own `DC=` components.
An explicit `var_DomainOUs` overrides the whole map.

Credential resolution (`cvs_admin.ps1:115-134`, `147-151`):

```powershell
$user = [Environment]::GetEnvironmentVariable("AD_CRED_${k}_USER")
$pass = [Environment]::GetEnvironmentVariable("AD_CRED_${k}_PASS")
$cred = New-Object PSCredential($user, (ConvertTo-SecureString $pass -AsPlainText -Force))
...
$credKey = $Map[$domain].CredentialKey
if ([string]::IsNullOrWhiteSpace($credKey)) { $credKey = $DefaultCredentialKey }
```

Per domain, with a `-DefaultCredentialKey` fallback, a resolution cache, and per-domain
failures captured as error rows rather than aborting the sweep. Ansible injects the
values as **environment variables** (`environment: "{{ var_domain_cred_env }}"`) under
`no_log: true`, so they never reach the process command line or the job log.

### The problem

**The delivered vRO Admin Accounts Report targets the wrong script.** Its design
document states:

> `Script action invoked: Get-AllAdmin-Accounts in cvs_functions.ps1` … carrying changes **S-16 … S-21**
> `Credentials are held by the PowerShell plug-in host configuration`

So it was built against the v2-era `cvs_functions.ps1` path, while the customer has
moved to `cvs_admin.ps1`, which additionally has department filters, `-IncludeDisabled`,
`-FailOnQueryError`, `-ReportTitle`, a PKI/smartcard reporting focus, and the per-domain
credentials above.

This is the re-baseline hazard: **GitLab-Repos-Sanitized is the newer baseline, and
every transition must be re-checked against it before its Change Register is written.**

**Decision needed:** does the vRO Admin Accounts Report re-baseline onto v3
(`cvs_admin.ps1`), or does the customer intend to retire v3 and stay on v2? Everything
else in §5.2 depends on the answer.

---

## 5. Remediation

### 5.1 Tier 1 (P-52) — Move Event Logs, Server Reboots, Reboot Report ByCN, Clean Disks

1. Register one `PowerShell:PowerShellHost` per domain identity, **all pointing at the
   same pool FQDN**. Name them for the **identity**, not the server — `pshost-dom1`,
   `pshost-dom2`. **Shared Session mode is required.**
2. Create the domain→host Configuration Elements (`PSO/Identity/Domains`, one per
   domain, attribute `psHostName`).
3. Promote `resolvePowerShellHostForDomain` to a shared module. **Reference it — do not
   copy it.** The domain map must have exactly one definition.
4. Per workflow: replace the pre-bound `psHost` attribute with a `domainName` input
   resolved through that action.
5. Update `03_Implementation_Guide` in each project; correct
   `Ansible-to-vRO-MappingTable.md:105`.

No PowerShell changes. No change to `cvs_functions.ps1`.

### 5.2 Tier 2 (P-53) — Admin Accounts Report, Service Account Expiration

**Port the customer's v3 pattern rather than inventing one.** `AD_CRED_<KEY>_USER` /
`AD_CRED_<KEY>_PASS` environment variables, a `credential` key per domain in the scope
map, and a `-DefaultCredentialKey` fallback are already proven in this environment. The
earlier DPAPI proposal is withdrawn — it solved a problem the customer had already
solved differently, and divergence here would be gratuitous.

For **Service Account Expiration**, this means porting `Get-DomainCredential` and the
per-domain credential key into `cvs_functions.ps1`'s `Get-ServiceAccountExpiration`
path (**S-26**), matching `cvs_admin.ps1`'s implementation.

**One genuine gap in the port.** AAP set those environment variables from the job
template under `no_log: true`. vRO's OOTB *Invoke a PowerShell script* takes a script
string, so setting `$env:AD_CRED_X_PASS = '...'` inside it would put the secret in the
invocation string — the most-logged value in this family of actions.

Options, in preference order:

1. **Stage the credentials on the PS host.** Set the `AD_CRED_*` variables as
   machine-level environment variables during host build, or write DPAPI-encrypted
   files the script loads. No secret ever crosses from Orchestrator. Adds a rotation
   obligation for those values — which the Service Account Password Rotation project
   can own.
2. **Set them in the invocation string from Configuration Element SecureStrings**, with
   the invocation string never logged and never bound to a workflow output. Simpler,
   but it makes one action a permanent exception to the family's logging convention.

Recommend (1). It also keeps Orchestrator free of credentials it does not need to hold.

### 5.3 P-54 — cross-domain group members — **RESOLVED**

**Customer-confirmed: targeting groups are single-domain.** Tier 1 host selection is
therefore sufficient for the reboot, report and disk-clean paths.

Because the constraint is now documented, `Get-ListOfServers-ByCN`
(`cvs_functions.ps1:989-991`) should stop treating a foreign member as routine:

```powershell
Catch { Write-Log "Warn: could not resolve computer object '...' - skipped: ..." }
```

A member that cannot be resolved against the run's `-Server` now indicates a **violated
constraint**, not an expected condition. Promote it to an `Error:` line so the run ends
**"Completed with Errors"** rather than reporting success while silently omitting a
server an operator explicitly added to the group. Recorded as **S-27**.

---

## 6. Work order

Customer-specified, 2026-08-17:

| # | Project | Tier | Notes |
|---|---|---|---|
| 1 | Move Windows Event Logs | 1 | |
| 2 | Server Reboots | 1 | |
| 3 | Servers Reboot Report by CN | 1 | |
| 4 | Windows Server Clean Disks | 1 | |
| 5 | Admin Accounts Report | 2 | Blocked on the §4 re-baseline decision |
| 6 | Service Account Expiration Reporting | 2 | S-26 |
| 7 | Service Account Password Rotation | 1 | S-25 still to write |

Projects 1–4 share one pattern; #1 establishes it and the rest follow mechanically.

**Re-baseline every project against `GitLab-Repos-Sanitized` before writing its Change
Register** — §4 shows what happens otherwise.

---

## 7. Open questions

1. **Domain inventory** — the full list in scope per workflow.
2. **Admin Accounts Report: v2 or v3?** (§4) Blocks project #5.
3. **Reset Password delegation** — confirm per domain, on the target OU, before S-25
   goes to production.
4. **Tier 2 credential staging** — option (1) or (2) in §5.2.

---

## 8. Change register IDs

| ID | Scope | Description |
|---|---|---|
| **P-51** | Cross-project | Single-`psHost` assumption recorded as intended; invalid for a multi-domain estate |
| **P-52** | Tier 1 × 4 projects | Per-domain host object resolution; binding change only |
| **P-53** | Tier 2 × 2 projects | Multi-domain sweep cannot carry one identity |
| **P-54** | Cross-project | Cross-domain group members silently skipped — **resolved**, see S-27 |
| **P-55** | Admin Accounts Report | Built against `cvs_functions.ps1`; customer has moved to `cvs_admin.ps1` (v3) |
| **S-26** | `cvs_functions.ps1` | Port `Get-DomainCredential` + per-domain credential keys from `cvs_admin.ps1` |
| **S-27** | `cvs_functions.ps1` | Foreign group member: `Warn:` → `Error:` so the run ends "Completed with Errors" |
