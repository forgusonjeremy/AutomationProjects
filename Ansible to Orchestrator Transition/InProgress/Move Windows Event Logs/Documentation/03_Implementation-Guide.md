# Implementation Guide — Move Archived Logs

Building this automation in Orchestrator. Everything is copy-and-paste from the `Code`
folder — there is no package to import.

**Roughly an hour**, most of it spent on step 1 if the plug-ins are not already set up.

> **Scope.** This guide builds **Move Archived Logs** only, and is complete on its own.
>
> Steps 0, 1 and 3 install things that are **shared** with *Remove Old Archived Logs*. If
> that automation is already built in this Orchestrator, its prerequisites and two of its
> actions are already in place — see [06_Shared-Components.md](06_Shared-Components.md)
> for exactly which, so you do not create a second copy.

---
## Step 0 — Run the probe first

Do this before anything else. It changes nothing and it will tell you in one run whether
the rest of this guide will work.

1. Create an action `probeAdPlugin` in module `com.broadcom.pso.windows.logs`
   (create the module as you go — Orchestrator makes it when you type the name). This
   action is **shared** with the other automation; if it exists already, skip to step 5.
2. Input: `adGroup`, type `AD:UserGroup`.
3. Return type: `string`.
4. Paste `Code/probeAdPlugin.js`.
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

### Use names, never IP addresses

**Every path must use a hostname or FQDN.** `\\fileserver.vcf.lab\archive$` works;
`\\10.113.1.2\archive$` does not — and it fails in a way that looks like a permissions
problem rather than a naming one.

Kerberos authenticates to a *service principal name*, which is built from a host name.
There is no SPN for an IP address, so a UNC path written with one cannot use Kerberos at
all: the connection silently falls back to NTLM, the delegated credential is of no use to
it, and the share answers `Access is denied`.

This bites the destination hardest, because `targetPath` is the value most likely to have
been written as an IP while testing. The symptom is confusing: the *source* paths work
perfectly — they are built from AD computer names and so are always FQDNs — while the
destination is refused. It reads as "the file share has wrong permissions", and the file
share is fine.

If a path must be an IP, the delegation work above cannot help it. Change the path.

> **Why Ansible never hit this.** The playbooks did not rely on delegation at all — they
> used `become_method: runas` with an explicit password, which performs a fresh logon on
> the host holding real credentials, and that logon can authenticate onward by itself. So
> a script that worked under Ansible can fail here **unchanged**, in an environment where
> nothing else has changed. `cvs_functions.ps1` does the identical `\\<server>\C$` access
> and contains no credential handling of its own; the password came from the playbook.

---


## Step 2 — Import the script

**Design → Resource Elements**. Import the one `.ps1` this automation runs. The name must
match exactly:

| File | Import as |
|---|---|
| `Code/Move-ArchivedLogs.ps1` | `Move-ArchivedLogs.ps1` |

The workflow binds that element to a `ResourceElement` **workflow attribute**
(`scriptElement`) and passes it to `runPowerShellScript`. Nothing is looked up by name at
run time, so the workflow itself records which script a run used.

The name still matters: it becomes the file name written to the PowerShell host, so keep
the `.ps1` extension. It cannot contain `\`, `/` or `:` — the action refuses those rather
than write the file somewhere other than its working folder.

Re-importing a changed script is how you update it. Nothing on the PowerShell host needs
touching, because nothing is left there.

> **`Code/Probe-ServerAccess.ps1` is optional.** It is a diagnostic that reports the run
> identity, the Kerberos ticket flags, and what each server's share can actually be read.
> Import it the same way if you want to run the step 1 checks through Orchestrator rather
> than by hand. It is shared with the other automation.

---

## Step 3 — Create the actions

Five actions. **Two of them are shared** with *Remove Old Archived Logs* — if that is
already built here, they exist and you should not create them again.

> **Input order matters.** Workflows call actions positionally, so add the inputs in the
> order shown or the wrong values will arrive.

| Action | Shared? | Inputs (in order) | Return type |
|---|---|---|---|
| `runPowerShellScript` | **Shared** | `psHost` : `PowerShell:PowerShellHost`<br>`script` : `ResourceElement`<br>`parameters` : `Properties` | `Properties` |
| `selectPowerShellHost` | **Shared** | `psHost` : `PowerShell:PowerShellHost` | `PowerShell:PowerShellHost` |
| `findAdHostForDn` | This package | `distinguishedName` : `string` | `AD:AdHost` |
| `resolveAdGroup` | This package | `adGroupDn` : `string`<br>`adHost` : `AD:AdHost` | `AD:UserGroup` |
| `getGroupComputers` | This package | `adGroup` : `AD:UserGroup` | `Array/string` |

Paste each file's contents from `Code/` as the action script. The shared ones carry a
banner at the top saying what they are shared with; that banner is a comment and can stay.

`probeAdPlugin` from step 0 is a sixth action, but it is a diagnostic — the workflow never
calls it.

### Which module

Any, as long as you are consistent. Nothing here calls `System.getModule()`, so no module
name is baked into the code. The reference deployment splits them:

| Module | Actions |
|---|---|
| `com.broadcom.pso.vcf.activedirectory` | `findAdHostForDn`, `resolveAdGroup`, `getGroupComputers` |
| `com.broadcom.pso.vcfa.vm.guestScripting` | `runPowerShellScript` |

If you are building both automations, put the shared PowerShell actions somewhere shared
rather than in a module named after this one.

---

## Step 4 — Build the workflow

Suggested folder: **Production → Servers → Windows → Event Log Management**

The workflow is a schema of bound elements, not one large scriptable task. Each element's
inputs are bound to the attribute the element before it wrote, so the schema itself
records where every value came from and nothing is fetched out of sight.

```
findAdHostForDn -> resolveAdGroup -> getGroupComputers
                -> Create Script Parameters -> runPowerShellScript -> Parse Result -> end
```

### Inputs

| Name | Type | Default | Notes |
|---|---|---|---|
| `adGroupDn` | `string` | — | The group's `distinguishedName`. Mandatory in this shape |
| `olderThanDays` | `number` | `0` | 0 means every age. Negative values are rejected |
| `reportOnly` | `boolean` | `true` | Leave the default as true |
| `overwriteExisting` | `boolean` | `false` | |

> **Adding the group tree picker.** An operator running this by hand should not have to
> type or paste a DN, and the User Guide describes browsing to the group. To offer that,
> add an input `adGroup` of type `AD:UserGroup` (**not mandatory**) and put a **decision
> element** at the front of the schema testing whether it is set:
>
> - **set** → bind it straight to `getGroupComputers` and skip the two lookups. A group
>   picked from the tree arrives already resolved and already attached to its own endpoint
> - **empty** → the `findAdHostForDn` → `resolveAdGroup` path above, which is what
>   scheduled and API runs use, because there is nobody there to click a tree
>
> Leave `adGroup` not mandatory either way. Marking it mandatory blocks scheduled runs,
> which supply `adGroupDn` instead.

### Attributes

Set once when the workflow is built. The operator does not choose any of these.

| Name | Type | Value |
|---|---|---|
| `scriptElement` | `ResourceElement` | The `Move-ArchivedLogs.ps1` element from step 2 |
| `psHost` | `PowerShell:PowerShellHost` | The registered host that will do the work |
| `logsFilePath` | `string` | `C$\Windows\System32\winevt\Logs` — where on each server to look |
| `fileServerPath` | `string` | The archive share. **FQDN, never an IP** — see *Use names, never IP addresses* |
| `fileFilter` | `string` | `Archive-*.evtx` |
| `adHost` | `AD:AdHost` | Empty. Carries the endpoint from element 1 to element 2 |
| `adGroup` | `AD:UserGroup` | Empty. Carries the group from element 2 to element 3 |
| `computers` | `Array/string` | Empty. Carries the server list from element 3 to element 4 |
| `scriptParameters` | `Properties` | Empty. Carries the bag from element 4 to element 5 |
| `runResult` | `Properties` | Empty. Carries the result from element 5 to element 6 |

> `psHost` is an attribute because this site registers a single host, so there is nothing
> to choose. If yours registers more than one, make `psHost` a **not mandatory input**
> instead and put the `selectPowerShellHost` action at the front — it returns the only
> host when there is one, and otherwise stops with the list of choices rather than picking
> at random.

### Outputs

| Name | Type |
|---|---|
| `success` | `boolean` |
| `serversProcessed` | `number` |
| `filesMoved` | `number` |
| `transcript` | `string` |

Bind all four on the last element's OUT tab. An unbound OUT tab is **not** an error and
raises no warning — the values are assigned and discarded, and the workflow finishes
looking successful with nothing to show for it.

### Schema, element by element

**1. `findAdHostForDn`** — action.

| Tab | Bind |
|---|---|
| IN | `distinguishedName` → `adGroupDn` |
| OUT | `actionResult` → `adHost` |

**2. `resolveAdGroup`** — action. Takes the endpoint as its second input rather than
looking it up itself, so the schema shows that the same endpoint flowed into both steps.

| Tab | Bind |
|---|---|
| IN | `adGroupDn` → `adGroupDn`, `adHost` → `adHost` |
| OUT | `actionResult` → `adGroup` |

**3. `getGroupComputers`** — action. Expands nested groups and skips disabled accounts.

| Tab | Bind |
|---|---|
| IN | `adGroup` → `adGroup` |
| OUT | `actionResult` → `computers` |

**4. `Create Script Parameters`** — scriptable task. Paste `Code/task_CreateScriptParameters.js`.

| Tab | Bind |
|---|---|
| IN | `computers`, `logsFilePath`, `fileServerPath`, `fileFilter`, `olderThanDays`, `reportOnly`, `overwriteExisting` |
| OUT | `scriptParameters` |

**5. `runPowerShellScript`** — action. Takes its three inputs positionally.

| Tab | Bind |
|---|---|
| IN | `psHost` → `psHost`, `script` → `scriptElement`, `parameters` → `scriptParameters` |
| OUT | `actionResult` → `runResult` |

**6. `Parse Result`** — scriptable task. Paste `Code/task_ParseResult.js`.

| Tab | Bind |
|---|---|
| IN | `runResult` |
| OUT | `success`, `serversProcessed`, `filesMoved`, `transcript` |

### Presentation

Group the inputs so the common case is obvious:

- **Servers** — `adGroup` (if you added the picker), otherwise `adGroupDn`
- **What to move** — `olderThanDays`
- **Options** — `reportOnly`, `overwriteExisting`
- **Advanced** *(collapsed)* — `adGroupDn`, `psHost` if you made it an input

A normal run touches only the first field.

### Before the first live run

`reportOnly` defaults to true, so the first run lists what it would move and moves
nothing. Read that list before unticking the box.

Then read this, because it is the trap this automation is most likely to fall into:

> **A clean report-only run does not prove the destination works.** Report only never
> writes to the archive share — both the folder check and the per-file check sit behind
> the report-only test — so it can pass perfectly while the share is unwritable. When the
> live run then fails, the errors are reported against the **source** servers, because
> that is where the files are being read from. Every server appears to refuse at once.
>
> If you see that, check the destination before you check anything else, and check that
> `fileServerPath` is an FQDN rather than an IP address. Test 4.1 in the Testing Plan is
> the run that settles it.

---

## Step 5 — Test

Follow [04_Testing-Plan.md](04_Testing-Plan.md). Do not skip the report-only runs, and do
not stop after them.

---

## When something goes wrong

| Message | What it means |
|---|---|
| `no script was supplied` | The `scriptElement` attribute is not bound. Step 2 |
| `the Resource Element ... holds no content` | The element exists but the .ps1 was never imported into it. Re-import |
| `none of the registered Active Directory hosts serve the domain '...'` | No endpoint for that domain, or the endpoint does not identify itself by domain. Run the probe and compare |
| `contains no enabled computer accounts` | Wrong group, a group of users rather than computers, or the plug-in is not returning membership. Run the probe with that group |
| `did not report a result` | The script did not finish. The full output is in the message — read the end of it. Usually PowerShell could not start, or the session died |
| **Every** server says `Access is denied` | Two candidates, in this order: the **destination** share is not writable, or `fileServerPath` is an IP address. Only then suspect the double hop. Each error names the operation as well as the path — read which one it was |
| **One** server says `not reachable` | That server is off, firewalled, or the account is not an admin on it. The rest still processed |
| `N PowerShell hosts are registered` | Pick one in the form, under Advanced, or bind the `psHost` attribute |
| `Negative values are rejected` | `olderThanDays` was set to the old Ansible `-1`. Use `0` |

> **When an error names a path, check the code actually failed on that path.** The script
> reports the operation alongside the path for exactly this reason. An earlier version
> advanced that tracking too late and reported a *destination* failure against the
> *source* path — the message named a server that was working perfectly, and the
> investigation went to the wrong machine for most of a day.
