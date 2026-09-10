# Shared Components

**Package:** Move Archived Logs

This package is standalone. Everything it needs is inside it, and it can be installed on
its own into an Orchestrator that has never seen the other automation in this family.

Some of what it contains, though, is **not specific to it**. Those files are shared with
**Remove Old Archived Logs**, and if both automations are installed in the same
Orchestrator you should create each shared action **once** and let both workflows call it.

Every shared file carries a banner comment at the top saying so.

---

## The register

| Component | Kind | Shared with | Notes |
|---|---|---|---|
| `runPowerShellScript.js` | Action | **Remove Old Archived Logs** | The only place that knows anything about the PowerShell plug-in. Both automations run their script through it |
| `selectPowerShellHost.js` | Action | **Remove Old Archived Logs** | Returns the only registered host, or stops with the list of choices. Not needed when `psHost` is a bound attribute |
| `probeAdPlugin.js` | Action | **Remove Old Archived Logs** *(partly)* | Diagnostic. The other automation uses only its PowerShell-host and script-import sections; the Active Directory half does not apply there |
| `Probe-ServerAccess.ps1` | Script | **Remove Old Archived Logs** | Diagnostic. Reports identity, Kerberos ticket flags, and what each share can actually be read |
| `findAdHostForDn.js` | Action | — | **This package only.** The other automation works on a share and needs no Active Directory at all |
| `resolveAdGroup.js` | Action | — | **This package only**, same reason |
| `getGroupComputers.js` | Action | — | **This package only**, same reason |
| `Move-ArchivedLogs.ps1` | Script | — | **This package only** |
| `workflow_Move-ArchivedLogs.js` | Reference | — | **This package only.** Reference material, not the deployed shape — see the note at the end |

Three of the four shared items are the PowerShell plumbing, and that is the whole pattern:
**anything that runs a script on a Windows host is shared; anything that decides *which
servers* is not.** The other automation has no servers — it has a share.

---

## Installing both automations in the same Orchestrator

Create the shared actions once, from whichever package you install first. When you install
the second, skip the actions it lists as shared — they are already there.

| If you install... | Create these actions | Then, for the other package |
|---|---|---|
| This one first | All five | Only its own tasks are new; `runPowerShellScript` and `selectPowerShellHost` already exist |
| The other one first | `findAdHostForDn`, `resolveAdGroup`, `getGroupComputers` | `runPowerShellScript` and `selectPowerShellHost` already exist |

> **Do not create a second copy under a different name.** A fix made to one copy does not
> reach the other, and nothing reports that they have diverged. `runPowerShellScript` in
> particular has absorbed several hard-won fixes — BOM stripping, `invokeScript()` over
> `openSession()`, transcript recovery when the script throws — and a stale second copy
> would silently reintroduce all of them.

---

## Which module?

The file headers name `com.broadcom.pso.windows.logs`. The reference deployment actually
uses two modules:

| Module | Actions |
|---|---|
| `com.broadcom.pso.vcf.activedirectory` | `findAdHostForDn`, `resolveAdGroup`, `getGroupComputers` |
| `com.broadcom.pso.vcfa.vm.guestScripting` | `runPowerShellScript` |

Either arrangement works — nothing in this package looks an action up by module name at
run time, because nothing calls `System.getModule()`. Pick one and be consistent. If you
are installing both automations, put the shared PowerShell actions wherever the shared
things live in your library, not inside a module named after this automation.

---

## A note on `workflow_Move-ArchivedLogs.js`

This file is **reference only**. It is the single-scriptable-task form the workflow was
originally designed as, and it calls `System.getModule()`, which the deployed shape
deliberately does not.

The workflow that was actually built is a multi-element schema whose elements pass values
to each other through bindings, so the schema itself records where each value came from.
Build it that way — the Implementation Guide describes it. Keep this file for the
commentary in it, not as something to paste.
