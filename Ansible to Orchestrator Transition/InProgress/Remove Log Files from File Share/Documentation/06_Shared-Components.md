# Shared Components

**Package:** Remove Old Archived Logs

This package is standalone. Everything it needs is inside it, and it can be installed on
its own into an Orchestrator that has never seen the other automation in this family.

Some of what it contains, though, is **not specific to it**. Those files are shared with
**Move Archived Logs**, and if both automations are installed in the same Orchestrator you
should create each shared action **once** and let both workflows call it.

Every shared file carries a banner comment at the top saying so.

---

## The register

| Component | Kind | Shared with | Notes |
|---|---|---|---|
| `runPowerShellScript.js` | Action | **Move Archived Logs** | The only place that knows anything about the PowerShell plug-in. Both automations run their script through it |
| `selectPowerShellHost.js` | Action | **Move Archived Logs** | Returns the only registered host, or stops with the list of choices. Not needed when `psHost` is a bound attribute — see the Implementation Guide |
| `probeAdPlugin.js` | Action | **Move Archived Logs** *(partly)* | Diagnostic. **This package uses only its PowerShell-host and script-import sections.** Its Active Directory half is for the other automation and can be ignored here |
| `Probe-ServerAccess.ps1` | Script | **Move Archived Logs** | Diagnostic. Reports identity, Kerberos ticket flags, and what each share can actually be read |
| `Remove-OldArchivedLogs.ps1` | Script | — | **This package only** |
| `task_CreateScriptParameters.js` | Scriptable task | — | **This package only** |
| `task_ParseResult.js` | Scriptable task | — | **This package only** |

**What this package does *not* contain, deliberately:** `findAdHostForDn`,
`resolveAdGroup` and `getGroupComputers`. Those three are the Active Directory half of
**Move Archived Logs**, and this automation has no use for them. It works on a share, not
on a list of servers, so it never asks Active Directory anything and needs no AD endpoint
registered at all.

That is the whole pattern: **anything that runs a script on a Windows host is shared;
anything that decides *which servers* belongs to the other automation.**

---

## Installing both automations in the same Orchestrator

Create the shared actions once, from whichever package you install first. When you install
the second, skip the actions it lists as shared — they are already there.

| If you install... | Create these actions | Then, for the other package |
|---|---|---|
| This one first | `runPowerShellScript`, `selectPowerShellHost`, `probeAdPlugin` | Only its three Active Directory actions are new |
| The other one first | None — all three already exist | Only this package's two scriptable tasks are new, and those live in the workflow, not the action library |

> **Do not create a second copy under a different name.** A fix made to one copy does not
> reach the other, and nothing reports that they have diverged. `runPowerShellScript` in
> particular has absorbed several hard-won fixes — BOM stripping, `invokeScript()` over
> `openSession()`, transcript recovery when the script throws — and a stale second copy
> would silently reintroduce all of them.

---

## Which module?

The file headers name `com.broadcom.pso.windows.logs`. The reference deployment puts
`runPowerShellScript` in `com.broadcom.pso.vcfa.vm.guestScripting` instead.

Either works — nothing in this package looks an action up by module name at run time,
because nothing calls `System.getModule()`. Every value this workflow uses arrives as a
binding. Pick a module and be consistent; if you are installing both automations, put the
shared PowerShell actions wherever the shared things live in your library, not inside a
module named after one automation.

---

## Prerequisites this package does *not* need

Worth stating plainly, because the shared diagnostic action reports on all of it and it
can look like something is missing:

| Not needed | Why |
|---|---|
| An Active Directory endpoint | This automation never queries AD |
| Administrative share (`C$`) access to any server | It touches one share, not the servers |
| The `Move-ArchivedLogs.ps1` Resource Element | That belongs to the other automation. `probeAdPlugin` reports it as `NOT IMPORTED`, which is correct and harmless here |

What it *does* need is in Step 1 of the Implementation Guide: a PowerShell host, and an
account on it that can read **and delete** on the archive share.
