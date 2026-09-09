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
2. Input: `adGroup`, type `AD:Group`.
3. Return type: `string`.
4. Paste `_Shared/Code/probeAdPlugin.js`.
5. Run it, and pick a real group that contains servers.

Read the output. You are checking three things:

| Section | What you need to see |
|---|---|
| **Active Directory endpoints** | One per domain. At least one field per endpoint must contain the domain name or its `DC=` path — that is what `findAdHostForDn` matches on. |
| **PowerShell hosts** | At least one. If exactly one, operators will never be asked to choose. |
| **Group membership** | At least one of `computerMembers` / `groupMembers` / `members` says **present**. |

> **If all three membership properties say "missing"**, stop. This version of the AD
> plug-in reports membership some other way, and `getGroupComputers.js` needs adjusting to
> match before anything else will work. The probe output tells you what it does offer.

> **If `disabled` and `userAccountControl` are both missing** on the sample computer,
> disabled computer accounts cannot be filtered out. They will be attempted and reported
> as unreachable, which is noisy but harmless. Note it and move on.

---

## Step 1 — Prerequisites

### Active Directory plug-in

One endpoint per domain, added with **Library → Microsoft → Active Directory → Add an
Active Directory server**. The service account is stored there and is what every AD query
in this package runs as. It needs read access to the groups and computer objects.

### PowerShell plug-in

One host, added with **Library → PowerShell → Add a PowerShell host**.

The account configured on that host does the file work, so it needs:

- **Administrative share access** (`\\server\C$`) on every server in the group
- **Write access** to the archive share

### The double hop

Orchestrator connects to the PowerShell host, and the host then reaches out to the servers
and the share. That second hop is a separate authentication, and by default Windows will
not forward the credential to it. Symptom: everything works when you run the script
directly on the host, and every path is "not reachable" when Orchestrator runs it.

Fix it with **Kerberos constrained delegation** — delegate the PowerShell host's computer
account to the `CIFS` service on each target server and on the file server. CredSSP is the
fallback if delegation is not possible.

Ansible did not have this problem because it connected to each server directly. It is the
one genuinely new piece of infrastructure in this design, so prove it before you build
anything. From a session on the PowerShell host opened *by Orchestrator* — not an RDP
session — this must succeed:

```powershell
Test-Path \\<a-target-server>\C$\Windows\System32\winevt\Logs
Test-Path \\<fileserver>\<share>
```

---

## Step 2 — Import the two scripts

**Design → Resource Elements**. Import each `.ps1` file. The names must match exactly:

| File | Import as |
|---|---|
| `Move-ArchivedLogs/Code/Move-ArchivedLogs.ps1` | `Move-ArchivedLogs.ps1` |
| `Remove-OldArchivedLogs/Code/Remove-OldArchivedLogs.ps1` | `Remove-OldArchivedLogs.ps1` |

`runPowerShellScript` finds them by name, so a typo here is the most likely reason for a
"no Resource Element named ..." error later.

Re-importing a changed script is how you update it. Nothing on the PowerShell host needs
touching, because nothing is left there.

---

## Step 3 — Create the actions

All five in module **`com.broadcom.pso.windows.logs`**.

> **Input order matters.** Workflows call actions positionally, so add the inputs in the
> order shown or the wrong values will arrive.

| Action | Inputs (in order) | Return type |
|---|---|---|
| `runPowerShellScript` | `psHost` : `PowerShell:PowerShellHost`<br>`scriptName` : `string`<br>`parameters` : `Properties` | `Properties` |
| `resolveAdGroup` | `adGroup` : `AD:Group`<br>`adGroupDn` : `string` | `AD:Group` |
| `findAdHostForDn` | `distinguishedName` : `string` | `AD:AdHost` |
| `selectPowerShellHost` | `psHost` : `PowerShell:PowerShellHost` | `PowerShell:PowerShellHost` |
| `getGroupComputers` | `adGroup` : `AD:Group` | `Array/string` |

Paste each file's contents as the action script. `getGroupComputers.js` is in
`Move-ArchivedLogs/Code/`; the rest are in `_Shared/Code/`.

---

## Step 4 — Build the *Move Archived Logs* workflow

Suggested folder: **Production → Servers → Windows → Event Log Management**

### Inputs

| Name | Type | Default | Notes |
|---|---|---|---|
| `adGroup` | `AD:Group` | — | Not mandatory. Renders as a tree the operator browses. |
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

### Outputs

| Name | Type |
|---|---|
| `success` | `boolean` |
| `serversProcessed` | `number` |
| `filesMoved` | `number` |
| `transcript` | `string` |

### Schema

One scriptable task. Paste `Move-ArchivedLogs/Code/workflow_Move-ArchivedLogs.js`.

- **IN tab** — bind all nine inputs
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
| `no Resource Element named 'Move-ArchivedLogs.ps1'` | Step 2. The name must match exactly. |
| `none of the registered Active Directory hosts serve the domain '...'` | No endpoint for that domain, or the endpoint does not identify itself by domain name. Run the probe and compare. |
| `contains no enabled computer accounts` | Wrong group, a group of users rather than computers, or the plug-in is not returning membership. Run the probe with that group. |
| `did not report a result` | The script did not finish. The full output is in the message — read the end of it. Usually PowerShell could not start, or the session died. |
| Every server says `Source path is not reachable` | The double hop. Step 1. |
| One server says `Source path is not reachable` | That one server is off, firewalled, or the account is not an admin on it. |
| `N PowerShell hosts are registered` | Pick one in the form, under Advanced. |
