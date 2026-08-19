# `PSO/Identity/RunAsAccounts` — Configuration Element definition

**Purpose:** maps a **service account selector** to the `PowerShell:PowerShellHost` object
registered with that account. It is the vRO equivalent of the credential attached to an AAP
job template — the same decision, in the same place, from a list of the same length.

**Consumed by:** `resolvePowerShellHostForAccount`, `getRunAsAccountSelectors`
**Change IDs:** **P-52**, **P-65**

---

## 1. Shape

One Configuration Element per run-as account. **The element name is the selector** — the
value an operator picks from the dropdown — so name it for the account:

```
PSO/Identity/RunAsAccounts/
  svc-vro-subdom6@subdom6.company.net
  svc-vro-subdom8@subdomain8.net
  svc-vro-rootdomain@rootdomain.net
```

| Attribute | Type | Required | Value |
|---|---|---|---|
| `psHostName` | string | **yes** | Name of the `PowerShell:PowerShellHost` object — the `name` given at registration, **not** the server FQDN |
| `domain` | string | no | The account's AD domain. Informational here; workflows that also need it as a script parameter read it |
| `description` | string | no | Free text shown to operators — what this account is for, and what it must not be used for |

### Why not `PSO/Identity/ServiceAccounts`

That path is the password-rotation store, whose elements hold `SecureString` passwords under
a completely different schema. Two schemas in one category is a configuration mistake waiting
to be made at 2am — and the one that would be made is putting a `psHostName` on an element
that holds a password.

### Why keyed on the account rather than the domain

This supersedes the domain-keyed `resolvePowerShellHostForDomain`:

- The **Admin PKI report sweeps eight domains in one invocation**. There is no single domain
  to key on; there is exactly one account it runs as.
- A domain can legitimately have **more than one** service account — a read-only one for
  reports and a privileged one for password resets. The rotation design already requires that
  the host's own account is never one of the accounts being rotated, which domain→host cannot
  express.
- It matches what an operator already knows: *which credential does this run use?*

---

## 2. Registering the host objects

`Library > PowerShell > Configuration > Add a PowerShell host`, once per account, **all
pointing at the same pool FQDN**:

| Field | Account A | Account B |
|---|---|---|
| `name` | `pshost-subdom6` | `pshost-subdom8` |
| `host` | `pool01.subdom6.company.net` | `pool01.subdom6.company.net` *(same server)* |
| port / protocol | 5986 / HTTPS / Kerberos | 5986 / HTTPS / Kerberos |
| session mode | **Shared Session** | **Shared Session** |
| `username` | `svc-vro-subdom6@SUBDOM6.COMPANY.NET` | `svc-vro-subdom8@SUBDOMAIN8.NET` |

Three things are load-bearing:

1. **Name them for the identity, not the server.** Two host objects sharing one FQDN are
   indistinguishable in the inventory if both are named after the server, and picking the
   wrong one produces authentication failures against the target domain that look nothing
   like a naming problem. `resolvePowerShellHostForAccount` fails hard on duplicate names
   rather than guessing.
2. **Shared Session mode.** Per-user mode authenticates as the vRO user, which defeats the
   entire mechanism.
3. **Kerberos delegation (P-65).** Every `Get-ADUser -Server <domain>` is a second hop from a
   network logon. AAP configures this with `ansible_winrm_kerberos_delegation: yes`
   (`admins/inventory/on_winrm_servers`); the host object must request the equivalent, or it
   will connect happily and fail on the first AD call. `Script-Staging-Design.md` §6.3.

---

## 3. Wiring it into a workflow

| Element | Binding |
|---|---|
| Input `runAsAccount` (string) | Value list ← `getRunAsAccountSelectors(accountCategoryPath)` |
| `resolvePowerShellHostForAccount` | `(accountCategoryPath, runAsAccount)` → `psHost` |
| `stageScriptOnHost` | `(psHost, resourcePath, scriptPath)` |
| *Invoke a PowerShell script* | host ← `psHost` |

`accountCategoryPath` is a workflow attribute defaulting to `PSO/Identity/RunAsAccounts`, not
an input — operators choose accounts, not category paths.

**Use the dropdown, not a text field.** A typo that fails resolution is harmless; a typo that
happens to match a *different* mapped account runs the report as the wrong identity and
returns a plausible, wrong answer.

For workflows whose identity is **per scope** rather than per run — the Service Account
Expiration report — the selector belongs on the scope row (`account=`) and
`parseServiceAccountScopes` carries it through; the resolver is called once per scope inside
the loop.

---

## 4. Populating it for the current estate

| Element | `psHostName` | `domain` | Used by |
|---|---|---|---|
| `svc-vro-subdom6@subdom6.company.net` | `pshost-subdom6` | `subdom6.company.net` | Admin PKI report (the whole sweep); Service Account report (`subdom6` scope) |
| `svc-vro-subdom8@subdomain8.net` | `pshost-subdom8` | `subdomain8.net` | Service Account report (`subdomain8` scope) |

The Admin report additionally reaches `rootdomain.net` **inside** one invocation, which no
host object can do — that is the `AD_CRED_ROOTDOMAIN_*` case, staged on the host
(`Script-Staging-Design.md` §6.2). It does **not** need a `RunAsAccounts` element, because
nothing ever runs *as* it.

Take the account names from the AAP job templates rather than inventing them: the v3 admin
template's SSH credential and each service-account template's credential are the accounts
already proven to hold the necessary rights.

---

## 5. Validation

| # | Check | Expected |
|---|---|---|
| **RA-1** | `getRunAsAccountSelectors` on the populated category | Returns every element name, sorted; no exception when the category is missing |
| **RA-2** | Element with no `psHostName` | Listed in the dropdown, warned in the log, **fails at resolution** with a message naming the element |
| **RA-3** | Selector with no element | Hard failure listing the mapped accounts — never a fallback to a default host |
| **RA-4** | Two host objects with the same name | Hard failure; the action does not guess |
| **RA-5** | Resolved host identity | `whoami` through *Invoke a PowerShell script* returns the mapped account, not the vRO service account (proves Shared Session) |
| **RA-6** | **Delegation** | `Get-ADUser -Server <a domain the pool is NOT joined to> -Filter * -ResultSetSize 1` succeeds. **Run this first** — P-65 |
