# Implementation Guide — Remove Old Archived Logs

Building this automation in Orchestrator. Everything is copy-and-paste from the `Code`
folder — there is no package to import.

**Under an hour**, most of it spent on step 1 if the PowerShell plug-in is not already
set up. This is the smaller of the two automations in this family: three actions, three
schema elements, no Active Directory.

> **Scope.** This guide builds **Remove Old Archived Logs** only, and is complete on its
> own.
>
> Steps 0, 1 and 2 install things that are **shared** with *Move Archived Logs*. If that
> automation is already built in this Orchestrator, its PowerShell prerequisites and all
> three of the actions below are already in place — see
> [06_Shared-Components.md](06_Shared-Components.md) so you do not create a second copy.
>
> **This automation needs no Active Directory at all.** No endpoint, no plug-in
> configuration, nothing. It works on a share, not on a list of servers.

---

## Step 0 — Run the probe first

Do this before anything else. It changes nothing, and it tells you in one run whether the
rest of this guide will work.

1. Create an action `probeAdPlugin` in a module of your choosing (Orchestrator creates the
   module when you type the name).
2. Input: `adGroup`, type `AD:UserGroup`.
3. Return type: `string`.
4. Paste `Code/probeAdPlugin.js`.
5. Run it. **Leave `adGroup` empty** — this automation has no group, and the Active
   Directory half of the output does not apply to it.

Read the output. For this automation you are checking exactly two things:

| Section | What you need to see |
|---|---|
| **PowerShell hosts** | At least one. If exactly one, operators will never be asked to choose |
| **Resource Elements** | `Remove-OldArchivedLogs.ps1` reported as found, once you have done step 2 |

> **Ignore everything the probe says about Active Directory.** Missing endpoints, an
> empty `ldapBase`, absent membership properties — none of it affects this automation.
> The probe is shared with *Move Archived Logs*, which does need all of that.
>
> `Move-ArchivedLogs.ps1` being reported as `NOT IMPORTED` is likewise correct and
> harmless here. That script belongs to the other automation.

---

## Step 1 — Prerequisites

### PowerShell plug-in

One host, added with **Library → PowerShell → Add a PowerShell host**. This is the only
plug-in this automation uses.

The account configured on that host does the file work, so it needs, on the archive share:

- **Read** access — to list the files and their timestamps
- **Delete** access — to remove them

Those are two different permissions, and this automation is the one that notices. A report
only run needs the first; a live run needs the second. An account with read but not delete
produces a flawless report and then fails on every file.

It needs nothing on any server. It never touches `C$` anywhere.

### The double hop

Orchestrator connects to the PowerShell host, and the host then reaches out to the archive
share. That second hop is a separate authentication, and by default Windows will not
forward the credential to it.

**Set the PowerShell host to Kerberos.** Basic and NTLM cannot carry a credential to a
second machine at all, so with either of those this workflow cannot work whatever else is
configured. Kerberos can — provided the connection actually delegates, which is a separate
condition and the one worth checking rather than assuming. `klist` below says which.

The symptom when the credential does not reach the second hop:

```
Access to the path '\\fileserver.vcf.lab\archived-logs\srv01' is denied.
```

Logging on to the PowerShell host at the console and browsing to that share works — the
account really does have the rights. **That console test proves nothing**, and is the trap
this section exists for: a console logon holds primary credentials and can authenticate
onward; a WinRM session cannot. Same account, same rights, different logon type.

### Confirming it

From a session on the PowerShell host opened *by Orchestrator* — not RDP, not the console:

```powershell
whoami                                        # which identity the script actually runs as
klist                                         # read the Ticket Flags -- see below
Test-Path \\<fileserver>\<share>
Get-ChildItem \\<fileserver>\<share> -File | Select-Object -First 3
```

`Code/Probe-ServerAccess.ps1` does all of this for you and reports it through
`runPowerShellScript`, if you would rather not build a scriptable task by hand.


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
| **Resource-based constrained delegation** | On the file server only:<br>`Set-ADComputer <fileserver> -PrincipalsAllowedToDelegateToAccount (Get-ADComputer <pshost>)` | Least invasive, set per resource, instantly reversible. Needs rights on the file server's computer object only. **This automation needs one machine configured, not a whole estate** |
| **Constrained delegation** | On the PS host's computer account: *Trust this computer for delegation to specified services only* → `CIFS` on the file server | Central, but edits the PS host object and usually needs Domain Admin |
| **CredSSP** | Enable on the WinRM connection and the host | Works regardless of delegation, but sends the credential to the target. Fallback, not first choice |

After changing delegation, purge the cached tickets (`klist purge`, or restart the host)
or the old non-forwardable ticket will keep being used and nothing will appear to change.


### Use names, never IP addresses

**The share path must use a hostname or FQDN.** `\\fileserver.vcf.lab\archive$` works;
`\\10.113.1.2\archive$` does not — and it fails in a way that looks like a permissions
problem rather than a naming one.

Kerberos authenticates to a *service principal name*, which is built from a host name.
There is no SPN for an IP address, so a UNC path written with one cannot use Kerberos at
all: the connection silently falls back to NTLM, the delegated credential is of no use to
it, and the share answers `Access is denied`.

This automation has exactly one path, so it is entirely exposed to this. There is no
second, working path to compare against and no way to tell it apart from a share
permissions fault by looking at the error.

Both the script and the workflow's first task **warn** when given an IP, before the share
is touched. Take the warning seriously — the delegation work above cannot help an IP path.
Change the path.

> **Why Ansible never hit this.** The playbooks did not rely on delegation at all — they
> used `become_method: runas` with an explicit password, which performs a fresh logon on
> the host holding real credentials, and that logon can authenticate onward by itself. So
> a script that worked under Ansible can fail here **unchanged**, in an environment where
> nothing else has changed.

---

## Step 2 — Import the script

**Design → Resource Elements**. Import the one `.ps1` this automation runs. The name must
match exactly:

| File | Import as |
|---|---|
| `Code/Remove-OldArchivedLogs.ps1` | `Remove-OldArchivedLogs.ps1` |

The workflow binds that element to a `ResourceElement` **workflow attribute**
(`scriptElement`) and passes it to `runPowerShellScript`. Nothing is looked up by name at
run time, so the workflow itself records which script a run used.

The name still matters: it becomes the file name written to the PowerShell host, so keep
the `.ps1` extension. It cannot contain `\`, `/` or `:` — the action refuses those rather
than write the file somewhere other than its working folder.

Re-importing a changed script is how you update it. Nothing on the PowerShell host needs
touching, because nothing is left there.

> **Check the import for a byte-order mark.** A `.ps1` saved as UTF-8-with-BOM arrives
> with an invisible `U+FEFF` welded to its first token, and the failure names a token that
> does not appear anywhere in the file:
>
> ```
> ?<# : The term '?<#' is not recognized as the name of a cmdlet ...
> ```
>
> `runPowerShellScript` strips it, so this should not reach you — but if you see an error
> naming a token you cannot find, that is what it is.

> **`Code/Probe-ServerAccess.ps1` is optional.** It is a diagnostic that reports the run
> identity, the Kerberos ticket flags, and what the share can actually be read. Import it
> the same way to run the step 1 checks through Orchestrator rather than by hand. It is
> shared with the other automation.

---

## Step 3 — Create the actions

Three actions, and **all three are shared** with *Move Archived Logs*. If that automation
is already built in this Orchestrator, they exist — use them, and skip this step entirely.

> **Input order matters.** Workflows call actions positionally, so add the inputs in the
> order shown or the wrong values will arrive.

| Action | Inputs (in order) | Return type | Needed? |
|---|---|---|---|
| `runPowerShellScript` | `psHost` : `PowerShell:PowerShellHost`<br>`script` : `ResourceElement`<br>`parameters` : `Properties` | `Properties` | **Required** |
| `selectPowerShellHost` | `psHost` : `PowerShell:PowerShellHost` | `PowerShell:PowerShellHost` | Only if more than one host is registered |
| `probeAdPlugin` | `adGroup` : `AD:UserGroup` | `string` | Diagnostic only. Never called by the workflow |

Paste each file's contents from `Code/` as the action script. Each carries a banner at the
top saying what it is shared with; that banner is a comment and can stay.

The two scriptable tasks this workflow uses are **not** actions. They live inside the
workflow, and step 4 says where.

### Which module

Any, as long as you are consistent. Nothing here calls `System.getModule()`, so no module
name is baked into the code. The reference deployment puts `runPowerShellScript` in
`com.broadcom.pso.vcfa.vm.guestScripting`.

If you are building both automations, put these somewhere shared rather than in a module
named after one of them.

---

## Step 4 — Build the workflow

Suggested folder: **Production → Servers → Windows → Event Log Management**

This workflow needs no Active Directory at all. It works on a share, not on a list of
servers, so it is three elements end to end:

```
Create Script Parameters  ->  runPowerShellScript  ->  Parse Result  ->  end
```

### Inputs

| Name | Type | Default | Notes |
|---|---|---|---|
| `sharePath` | `string` | `\\iaaslabdc.vcf.lab\archived-logs` | Mandatory. **Use the FQDN, not an IP** — see *Use names, never IP addresses*. |
| `olderThanDays` | `number` | `370` | Must be 1 or more. |
| `reportOnly` | `boolean` | `true` | Leave the default as true. |

### Attributes

Set once when the workflow is built. The operator does not choose any of these.

| Name | Type | Value |
|---|---|---|
| `scriptElement` | `ResourceElement` | The `Remove-OldArchivedLogs.ps1` element from step 2 |
| `psHost` | `PowerShell:PowerShellHost` | The registered host that will run it |
| `fileFilter` | `string` | `Archive-*.evtx` |
| `scriptParameters` | `Properties` | Empty. Carries the bag between elements 1 and 2. |
| `runResult` | `Properties` | Empty. Carries the result between elements 2 and 3. |

> `psHost` is an attribute here for the same reason it is one on the move workflow: this
> site registers a single host, so there is nothing to choose. If yours registers more
> than one, make `psHost` a **not mandatory input** instead and put the
> `selectPowerShellHost` action in front of `Create Script Parameters` — it returns the
> only host when there is one, and otherwise stops with the list of choices rather than
> picking at random.

### Outputs

| Name | Type |
|---|---|
| `success` | `boolean` |
| `filesDeleted` | `number` |
| `spaceFreedMB` | `number` |
| `transcript` | `string` |

Bind all four on the last element's OUT tab. An unbound OUT tab is **not** an error and
raises no warning — the values are assigned and discarded, and the workflow finishes
looking successful with nothing to show for it.

### Schema

Three elements, each one's inputs bound to the attribute the element before it wrote.
Nothing is fetched with `System.getModule()`, so the schema itself shows where every
value came from.

**1. `Create Script Parameters`** — scriptable task. Paste
`Code/task_CreateScriptParameters.js`.

| Tab | Bind |
|---|---|
| IN | `sharePath`, `fileFilter`, `olderThanDays`, `reportOnly` |
| OUT | `scriptParameters` |

**2. `runPowerShellScript`** — the action, dragged in from
`com.broadcom.pso.vcfa.vm.guestScripting`. It takes its three inputs positionally.

| Tab | Bind |
|---|---|
| IN | `psHost` → `psHost`, `script` → `scriptElement`, `parameters` → `scriptParameters` |
| OUT | `actionResult` → `runResult` |

**3. `Parse Result`** — scriptable task. Paste
`Code/task_ParseResult.js`.

| Tab | Bind |
|---|---|
| IN | `runResult` |
| OUT | `success`, `filesDeleted`, `spaceFreedMB`, `transcript` |

### Presentation

- **What to clean up** — `sharePath`, `olderThanDays`
- **Options** — `reportOnly`

### Before the first live run

The script refuses `olderThanDays` below 1, and `reportOnly` defaults to true, so the
first run of any new path lists what it would delete and deletes nothing. Read that list
before unticking the box — this workflow removes files permanently, with no recycle bin
on a UNC path.

Note also that a clean report-only run proves the files can be **listed**, not that they
can be **deleted**. Those are different permissions. Only a live run exercises the second,
which is why test 3.1 in the Testing Plan runs one for real, and test 4.7 proves the
case a report can never catch.

---


## Step 5 — Test

Follow [04_Testing-Plan.md](04_Testing-Plan.md). Do not skip the report-only runs, and do
not stop after them — a report-only run never exercises delete permission.

---

## When something goes wrong

| Message | What it means |
|---|---|
| `no script was supplied` | The `scriptElement` attribute is not bound. Step 2 |
| `the Resource Element ... holds no content` | The element exists but the .ps1 was never imported into it. Re-import |
| `did not report a result` | **Read this row carefully.** The script always writes a `PSO_RESULT` line, so its absence means the script did not run to completion — *not* that it never started. The full output is in the message; read the end of it. If the script is current, this should no longer happen on an unreadable folder, because the enumeration is guarded. If it does, the guard is missing from the imported copy — re-import |
| `Path is not reachable` | The share is down, or the account cannot reach it at all. Nothing was deleted |
| `addressed by IP address` | A warning, not a failure. The path is an IP literal and will almost certainly be refused. Change it to the FQDN before doing anything else |
| `could not list <folder>` | The account cannot read that folder. Everything else was still cleaned — check the totals. Fix the ACL or accept it |
| `could not delete <file>` on everything | Read permission but not delete. This is the failure a report-only run cannot predict |
| `could not delete <file>` on a few files | They were open or protected. Normal — they usually go on the next run |
| `OlderThanDays must be at least 1` | Retention was 0. Nothing was deleted. The guard worked |
| `N PowerShell hosts are registered` | Pick one in the form, or bind the `psHost` attribute |

> **The two failures worth knowing apart.** `could not list` and `could not delete` are
> different permissions on the share, and a report-only run only ever exercises the first.
> If a live run fails on every file having reported cleanly, the account has read but not
> delete. No amount of re-running the report will reveal that.
