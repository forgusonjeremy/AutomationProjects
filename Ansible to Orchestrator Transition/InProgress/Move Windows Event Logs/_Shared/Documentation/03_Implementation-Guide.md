# Implementation Guide

Building this package in Orchestrator. Everything is copy-and-paste from the `Code`
folders — there is no package to import.

**Roughly an hour**, most of it spent on step 1 if the plug-ins are not already set up.

---

## Step 0 — Run the probe first

Do this before anything else. It changes nothing and it will tell you in one run whether
the rest of this guide will work.

1. Create an action `probeAdPlugin` in module `com.broadcom.pso.windows.logs`
   (create the module as you go — Orchestrator makes it when you type the name).
2. Input: `adGroup`, type `AD:UserGroup`.
3. Return type: `string`.
4. Paste `_Shared/Code/probeAdPlugin.js`.
5. Run it, and pick a real group that contains servers.

Read the output. You are checking three things:

| Section | What you need to see |
|---|---|
| **Active Directory endpoints** | One per domain, each with **`hostConfiguration.ldapBase` populated** (the `Root` field when adding it) — see below. |
| **PowerShell hosts** | At least one. If exactly one, operators will never be asked to choose. |
| **Group membership** | At least one of `computers` / `computerMembers` / `groups` / `groupMembers` / `members` says **present**. |

> **`hostConfiguration.ldapBase` must be present.** An `AD:AdHost` holds only three things
> of its own — `name`, `Url` and `hostConfiguration`. Every connection setting lives on
> that nested `AD_ServerConfiguration`, so this is what a healthy endpoint looks like:
>
> ```
> [1] vcf.lab
>       name : present -> vcf.lab
>       Url  : present -> ldaps://10.113.1.2:636
>       hostConfiguration : present
>           ldapBase : present -> DC=vcf,DC=lab
>           port     : present -> 636
> ```
>
> `ldapBase` is labelled **`Root`** on the *Add an Active Directory server* workflow, and
> it is what `findAdHostForDn` matches a group's `DC=` parts against.
>
> `hostConfiguration.defaultDomain` (`vcf.lab`) works as an alternative. If neither is set
> the endpoint falls back to being matched by its **name**, and the run warns that it did —
> worth fixing, because a name is not a statement of which domain an endpoint serves.
>
> Empty `host` and `defaultDomain`, and a bare IP in the `Url`, are all normal here and
> harmless: an IP identifies no domain, so it is simply skipped.

> **If every membership property says "missing"**, stop. This version of the AD plug-in
> reports membership some other way, and `getGroupComputers.js` needs adjusting to match
> before anything else will work. The probe output tells you what it does offer.

> **Check the nested-group list points downwards.** Whichever of `groups` or
> `groupMembers` is present must hold the groups *inside* the one being expanded, not the
> ones it is a member of. A list of parents would make `getGroupComputers` walk up the
> tree and collect servers that are not in scope. The probe prints `memberOf` alongside
> them for comparison — that one is the upward list and is never read.

**What a healthy probe looks like on the plug-in this was built against**, for comparison:

| Reported | Meaning |
|---|---|
| `computerMembers : present` / `groupMembers : present` | The typed lists. `computers` / `groups` are absent on this version, and `getGroupComputers` falls back to them only if the typed pair is missing. |
| `Sample member ... (type AD:ComputerAD)` | The computer type is `AD:ComputerAD`, not `AD:Computer`. Both are matched. |
| `disabled : missing`, `userAccountControl : present -> 4128` | Disabled accounts are detected from bit 2 of `userAccountControl`. `4128` is enabled; `4098` is disabled. |
| `searchExactMatch()` / `search()` **missing** on the endpoint, **present** on `ActiveDirectory` | The endpoint object carries no query methods, so `resolveAdGroup` scopes its search by passing the endpoint to `ActiveDirectory.searchExactMatch(...)`. This is expected, not a fault. |

> **If `disabled` and `userAccountControl` are both missing** on the sample computer,
> disabled computer accounts cannot be filtered out. They will be attempted and reported
> as unreachable, which is noisy but harmless. Note it and move on.

---

## Step 1 — Prerequisites

### Active Directory plug-in

One endpoint per domain, added with **Library → Microsoft → Active Directory → Add an
Active Directory server**. The service account is stored there and is what every AD query
in this package runs as. It needs read access to the groups and computer objects.

**Set the `Root` field when you add the endpoint.** It is the one value `findAdHostForDn`
depends on:

| Add-endpoint field | Where it ends up | Example |
|---|---|---|
| **`Root`** | `adHost.hostConfiguration.ldapBase` | `DC=vcf,DC=lab` |

`findAdHostForDn` reads the `DC=` parts off a group's distinguishedName and compares them
against that base, so `CN=Monitoring-Servers,OU=Servers,DC=vcf,DC=lab` resolves to the
endpoint whose `ldapBase` is `DC=vcf,DC=lab`. The comparison ignores case and spacing, so
`DC=VCF, DC=LAB` matches just as well.

> **It is a nested property.** An `AD:AdHost` has only `name`, `Url` and
> `hostConfiguration`; the rest — `ldapBase`, `defaultDomain`, `host`, `port`,
> `alternativeHosts` — belongs to the `AD_ServerConfiguration` underneath it. Code that
> reads `adHost.ldapBase` gets nothing back and cannot tell that apart from an endpoint
> registered without one.

`hostConfiguration.defaultDomain` (`vcf.lab`) is accepted as an alternative; either one is
enough.

If neither is set, the endpoint is matched on its **name** instead, and the run logs a
warning saying so. That still works, but a name is free text an operator typed rather than
a statement of which domain the endpoint serves — which matters in a multi-domain estate,
where the wrong endpoint returns the wrong servers rather than failing.

### PowerShell plug-in

One host, added with **Library → PowerShell → Add a PowerShell host**.

The account configured on that host does the file work, so it needs:

- **Administrative share access** (`\\server\C$`) on every server in the group
- **Write access** to the archive share

### The double hop

Orchestrator connects to the PowerShell host, and the host then reaches out to the servers
and the share. That second hop is a separate authentication, and by default Windows will
not forward the credential to it.

**Set the PowerShell host to Kerberos.** Basic and NTLM cannot carry a credential to a
second machine at all, so with either of those this workflow cannot work whatever else is
configured. Kerberos can — provided the connection actually delegates, which is a separate
condition and the one worth checking rather than assuming. `klist` below says which.

The symptom when the credential does not reach the second hop is specific and easy to
misread:

```
monsrv01.vcf.lab : Access is denied - while listing files in \\monsrv01.vcf.lab\C$\...
```

`Test-Path` on the same path succeeds, so it does not look like a connectivity problem,
and the account really does have the rights — logging on to the host at the console and
browsing there works. **That console test proves nothing**, and is the trap this section
exists for: a console logon holds primary credentials and can authenticate onward; a WinRM
session cannot. Same account, same rights, different logon type.

### Confirming it

From a session on the PowerShell host opened *by Orchestrator* — not RDP, not the console:

```powershell
whoami                                 # which identity the script actually runs as
klist                                  # read the Ticket Flags -- see below
Test-Path \\<a-target-server>\C$\Windows\System32\winevt\Logs
Get-ChildItem \\<a-target-server>\C$\Windows\System32\winevt\Logs -File | Select-Object -First 3
```

**The `klist` flags are the answer.** Look for a `krbtgt/<DOMAIN>` ticket and read them:

| Flags | Meaning |
|---|---|
| `forwardable forwarded` | The credential **was delegated** to this host. The second hop will work — this is what a healthy host looks like |
| `forwardable` alone | The ticket *could* be delegated, but was not. The connection is not requesting delegation |
| No `krbtgt` ticket, only `HOST/<pshost>` | No delegation at all. The session can act only on this host |

A healthy result reads like this, and needs nothing further doing:

```
Client: administrator @ VCF.LAB
Server: krbtgt/VCF.LAB @ VCF.LAB
Ticket Flags 0x60210000 -> forwardable forwarded pre_authent name_canonicalize
```

Both the `Test-Path` and the `Get-ChildItem` must succeed before the workflow can work.
`Test-Path` passing on its own means little — a path check needs no credential, while
listing the directory does, which is why they are tested separately.

### Fixing it

Any one of these:

| Option | What to do | Trade-off |
|---|---|---|
| **Resource-based constrained delegation** | On each target and the file server:<br>`Set-ADComputer <target> -PrincipalsAllowedToDelegateToAccount (Get-ADComputer <pshost>)` | Least invasive, set per resource, instantly reversible. Needs rights on the target objects only |
| **Constrained delegation** | On the PS host's computer account: *Trust this computer for delegation to specified services only* → `CIFS` on each target and the file server | Central, but edits the PS host object and usually needs Domain Admin |
| **CredSSP** | Enable on the WinRM connection and the host | Works regardless of delegation, but sends the credential to the target. Fallback, not first choice |

After changing delegation, purge the cached tickets (`klist purge`, or restart the host)
or the old non-forwardable ticket will keep being used and nothing will appear to change.

> **Why Ansible never hit this.** The playbooks did not rely on delegation at all — they
> used `become_method: runas` with an explicit password, which performs a fresh logon on
> the host holding real credentials, and that logon can authenticate onward by itself. So
> a script that worked under Ansible can fail here **unchanged**, in an environment where
> nothing else has changed. `cvs_functions.ps1` does the identical `\\<server>\C$` access
> and contains no credential handling of its own; the password came from the playbook.

---

## Step 2 — Import the two scripts

**Design → Resource Elements**. Import each `.ps1` file. The names must match exactly:

| File | Import as |
|---|---|
| `Move-ArchivedLogs/Code/Move-ArchivedLogs.ps1` | `Move-ArchivedLogs.ps1` |
| `Remove-OldArchivedLogs/Code/Remove-OldArchivedLogs.ps1` | `Remove-OldArchivedLogs.ps1` |

Each workflow binds its element to a `ResourceElement` **workflow attribute**
(`moveScript`, `removeScript`) and passes that to `runPowerShellScript`. Nothing is
looked up by name at run time, so the workflow itself records which script a run used.

The name still matters: it becomes the file name written to the PowerShell host, so keep
the `.ps1` extension. It cannot contain `\`, `/` or `:` — the action refuses those rather
than write the file somewhere other than its working folder.

Re-importing a changed script is how you update it. Nothing on the PowerShell host needs
touching, because nothing is left there.

---

## Step 3 — Create the actions

All five in module **`com.broadcom.pso.windows.logs`**.

> **Input order matters.** Workflows call actions positionally, so add the inputs in the
> order shown or the wrong values will arrive.

| Action | Inputs (in order) | Return type |
|---|---|---|
| `runPowerShellScript` | `psHost` : `PowerShell:PowerShellHost`<br>`script` : `ResourceElement`<br>`parameters` : `Properties` | `Properties` |
| `resolveAdGroup` | `adGroupDn` : `string`<br>`adHost` : `AD:AdHost` | `AD:UserGroup` |
| `findAdHostForDn` | `distinguishedName` : `string` | `AD:AdHost` |
| `selectPowerShellHost` | `psHost` : `PowerShell:PowerShellHost` | `PowerShell:PowerShellHost` |
| `getGroupComputers` | `adGroup` : `AD:UserGroup` | `Array/string` |

Paste each file's contents as the action script. `getGroupComputers.js` is in
`Move-ArchivedLogs/Code/`; the rest are in `_Shared/Code/`.

---

## Step 4 — Build the *Move Archived Logs* workflow

Suggested folder: **Production → Servers → Windows → Event Log Management**

### Inputs

| Name | Type | Default | Notes |
|---|---|---|---|
| `adGroup` | `AD:UserGroup` | — | Not mandatory. Renders as a tree the operator browses. |
| `adGroupDn` | `string` | — | Not mandatory. For scheduled runs only. |
| `psHost` | `PowerShell:PowerShellHost` | — | Not mandatory. |
| `sourcePath` | `string` | `C$\Windows\System32\winevt\Logs` | |
| `targetPath` | `string` | `\\fileserver.vcf.lab\mdcarchivelog$\Windows` | Set to your share. |
| `fileFilter` | `string` | `Archive-*.evtx` | |
| `olderThanDays` | `number` | `0` | 0 means every age. |
| `reportOnly` | `boolean` | `true` | Leave the default as true. |
| `overwriteExisting` | `boolean` | `false` | |

> Leave `adGroup` **not mandatory** even though it is the normal way in. Marking it
> mandatory would block scheduled runs, which supply `adGroupDn` instead. The workflow
> stops with a clear message if neither is given.

### Attributes

| Name | Type | Value |
|---|---|---|
| `moveScript` | `ResourceElement` | The `Move-ArchivedLogs.ps1` element from step 2 |

Set once when the workflow is built. It is an attribute rather than an input because the
operator does not choose which script runs — but binding it here rather than looking it up
by name means the run record shows which one did.

### Outputs

| Name | Type |
|---|---|
| `success` | `boolean` |
| `serversProcessed` | `number` |
| `filesMoved` | `number` |
| `transcript` | `string` |

### Schema

One scriptable task. Paste `Move-ArchivedLogs/Code/workflow_Move-ArchivedLogs.js`.

- **IN tab** — bind all nine inputs, plus the `moveScript` attribute
- **OUT tab** — bind all four outputs

That is the whole schema. The workflow is deliberately one element: the decisions live in
the actions, where they can be read and tested on their own, and a schema of boxes and
arrows would only restate what the script already says in order.

### Presentation

Group the inputs so the common case is obvious:

- **Servers** — `adGroup`
- **What to move** — `fileFilter`, `olderThanDays`, `sourcePath`
- **Where to** — `targetPath`
- **Options** — `reportOnly`, `overwriteExisting`
- **Advanced** *(collapsed)* — `psHost`, `adGroupDn`

A normal run touches only the first field.

---

## Step 5 — Build the *Remove Old Archived Logs* workflow

Same folder.

### Inputs

| Name | Type | Default |
|---|---|---|
| `sharePath` | `string` | `\\fileserver.vcf.lab\mdcarchivelog$\Windows` |
| `psHost` | `PowerShell:PowerShellHost` | — (not mandatory) |
| `fileFilter` | `string` | `Archive-*.evtx` |
| `olderThanDays` | `number` | `370` |
| `reportOnly` | `boolean` | `true` |

### Attributes

| Name | Type | Value |
|---|---|---|
| `removeScript` | `ResourceElement` | The `Remove-OldArchivedLogs.ps1` element from step 2 |

### Outputs

| Name | Type |
|---|---|
| `success` | `boolean` |
| `filesDeleted` | `number` |
| `spaceFreedMB` | `number` |
| `transcript` | `string` |

### Schema

One scriptable task. Paste
`Remove-OldArchivedLogs/Code/workflow_Remove-OldArchivedLogs.js`, and bind the five inputs
and four outputs.

---

## Step 6 — Test

Follow [04_Testing-Plan.md](04_Testing-Plan.md). Do not skip the report-only runs.

---

## When something goes wrong

| Message | What it means |
|---|---|
| `no script was supplied` | The workflow attribute holding the Resource Element is not bound. Step 2. |
| `the Resource Element .* holds no content` | The element exists but the .ps1 was never imported into it. Re-import. |
| `none of the registered Active Directory hosts serve the domain '...'` | No endpoint for that domain, or the endpoint does not identify itself by domain name. Run the probe and compare. |
| `contains no enabled computer accounts` | Wrong group, a group of users rather than computers, or the plug-in is not returning membership. Run the probe with that group. |
| `did not report a result` | The script did not finish. The full output is in the message — read the end of it. Usually PowerShell could not start, or the session died. |
| Every server says `Source path is not reachable` | The double hop. Step 1. |
| One server says `Source path is not reachable` | That one server is off, firewalled, or the account is not an admin on it. |
| `N PowerShell hosts are registered` | Pick one in the form, under Advanced. |
