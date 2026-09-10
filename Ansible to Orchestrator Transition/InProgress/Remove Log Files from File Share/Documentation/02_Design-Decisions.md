# Design Decisions — Remove Old Archived Logs

Why this automation looks the way it does. Read this first if you knew the Ansible
toolbox it replaces.

> **Scope.** This document covers **Remove Old Archived Logs** only. Its partner, *Move
> Archived Logs*, is what fills the share this one cleans up; it is a separate package
> with its own design document. Where a decision here was made jointly with that one, it
> says so.

---

## 1. What this replaces

One function out of the Ansible toolbox: **`Remove-OldFiles-UNCPath`**, run from
`remove-OldFiles-UNCPath.yml`.

Unlike the four move playbooks, there was only ever one of these, and its core logic was
sound. The retention arithmetic was correct, the path was validated, and per-file errors
were counted rather than allowed to stop the run. Most of what follows is therefore not a
correction — it is the same job made to work **unattended**, which is the one thing it
could not do.

The toolbox also carried a second, more dangerous function, `Remove-files`, which piped
matches straight into `Remove-Item -Force -Recurse`. That one is not carried forward. It
could remove directories as well as files, and `-Recurse` on a delete is not something an
unattended job should be able to reach for.

---

## 2. The interactive prompt had to go

This is the change that mattered.

```powershell
if (-not $Force -and -not $WhatIfPreference) {
    $Confirmation = Read-Host "Are you sure you want to delete these files? (Y/N)"
    if ($Confirmation -ne 'Y') {
        write-log "Info: Operation cancelled by user" $true
        return
    }
}
```

On an automated run there is nobody at a console. `Read-Host` either blocked the job or
read empty input, which is not `Y`, so the function returned having deleted nothing and
logged it as a *user cancellation*.

So the safety feature never worked as a safety feature. It worked as an obstacle: to make
the job run at all you passed `-Force`, and `-Force` skipped the confirmation entirely.
The only two available modes were **"hangs"** and **"no preview at all"**.

**Now:** `ReportOnly` defaults to `yes`. A run that is not explicitly told to delete will
only ever list what it would have deleted. It does the job the prompt was meant to do, it
works with nobody watching, and — unlike the prompt — the preview is a real run whose
output you can read afterwards in the workflow's transcript.

*This decision is shared with Move Archived Logs, which defaults to report-only for the
same reason.*

### Report only proves less than it looks

Worth stating in the same breath, because it is the natural next assumption and it is
wrong.

A report-only run **reads** the share. It never writes to it. Listing a folder and
deleting from it are different permissions, so a clean report-only run says nothing about
whether the account is allowed to delete anything. Only a live run establishes that.

The script says so in its own log rather than leaving it to be discovered.

---

## 3. No Active Directory, and no servers

This automation works on **a share**. It does not have a list of servers, does not query
Active Directory, and does not touch any machine's administrative share.

That is worth stating explicitly because its partner does all three, the two are usually
installed together, and the shared diagnostic action reports on AD endpoints that this
automation will never use.

The practical consequences:

| | |
|---|---|
| No AD endpoint needs registering for this package | It asks Active Directory nothing |
| No `C$` access is needed anywhere | It touches one share |
| The workflow has three elements, not six | There is nothing to look up before the work starts |
| It can run in an Orchestrator with no AD plug-in at all | Nothing in it references the plug-in |

The share is a parameter. Whatever put files there — this family's move workflow, an
older job, a person — this one only reads timestamps and deletes.

---

## 4. The PowerShell is a script, not a here-doc

*Shared decision. `runPowerShellScript` is the shared action that implements it, and
**Move Archived Logs** uses the same one.*

The script is stored in Orchestrator as a **Resource Element**. At run time
`runPowerShellScript` writes it to the PowerShell host as a real `.ps1`, runs it by path,
and deletes it.

Written to disk and invoked by path, rather than piped in as a string, so that **what you
test at a console is what the workflow runs**. An administrator can copy the same script
to a server, run it by hand with the same parameters, and get the same behaviour. Deleting
it afterwards means no stale copy is left to drift out of step with the version held in
Orchestrator.

### How the script talks back

The script prints readable log lines for people, and exactly one line for Orchestrator:

```
PSO_RESULT={"matched":412,"deleted":412,"freedMB":1180.44,"errorCount":0,"errors":[]}
```

One line, always printed, even when the script does nothing and even when it refuses to
run. Everything else in the output can be reworded freely without breaking anything.

Because it is always printed, its absence means something real: the script did not finish.
Orchestrator treats a missing result line as a failure rather than as "zero files", so a
broken run cannot be mistaken for a clean one.

**This is why the enumeration is guarded** — see section 6. A script that dies before
printing that line reports `did not report a result`, which reads as *"the script never
ran"* when in fact it ran and was refused. That is a worse failure than the one it
describes.

---

## 5. The retention guard, kept and tightened

The original had `[ValidateRange(1, 36500)]` on `$OlderThanDays`, and that judgement was
right: **0 must not be accepted.** Zero means "delete everything on the share", which is
never what anyone intends to type, and is exactly what a mistyped or unset parameter
produces.

That guard is kept, and now exists in two places:

| Where | What it does |
|---|---|
| `task_CreateScriptParameters.js` | Refuses before a PowerShell session is even opened |
| `Remove-OldArchivedLogs.ps1` | Refuses again, and reports it through `PSO_RESULT` |

The script's guard is the one that actually protects the share — it is what would stop an
administrator running the file by hand with the wrong argument. The workflow's guard is
there so the refusal is immediate and legible in the run record.

The retention arithmetic itself is unchanged, because it was already correct:
`(Get-Date).AddDays(-$OlderThanDays)`. A larger number keeps more files.

> **The move playbooks got this wrong and this one did not.** They used
> `AddDays([int]$Days)` — no minus — which put the cutoff in the *future*, so a larger
> number matched *more* files. Their working convention was `days_old: -1`. Two functions
> in the same toolbox, disagreeing about the sign of the same parameter. If you are
> carrying settings across from the Ansible era, this automation's numbers transfer
> directly; the move workflow's do not.

---

## 6. One unreadable folder must not abandon the share

The original set `ErrorAction = 'Stop'` on its enumeration:

```powershell
$GetChildItemParams = @{
    Path = $Path
    File = $true
    ErrorAction = 'Stop'
}
```

On a share of any size, some folder eventually cannot be read — a per-folder ACL, a
protected subdirectory, something a different job created. With `Stop`, the **first** one
ends the enumeration and the rest of the share goes uncleaned.

There is a worse consequence in the Orchestrator setting. The error is terminating, so the
script exits *before* printing `PSO_RESULT`, and the workflow reports:

```
runPowerShellScript: Remove-OldArchivedLogs.ps1 did not report a result.
It always writes a PSO_RESULT line, so it did not run to completion.
```

which states that the script never ran. It did run. It was denied on one folder. The
message sends the reader to look for a broken session, a missing Resource Element, or a
dead host — none of which is the problem.

**Now:** the enumeration uses `-ErrorAction SilentlyContinue` with `-ErrorVariable`, so
the walk continues past a folder it cannot read, and **every** such folder is logged
individually as an error naming it. A `try`/`catch` remains as a backstop for a failure
that terminates anyway, and that too reports through `PSO_RESULT`.

The outcome: the rest of the share is still cleaned, the denials are named, `errorCount`
is non-zero so the workflow does not claim success, and the run is never mistaken for one
that failed to start.

### Errors say which operation failed

`Test-Path` proves less than it appears to. Reaching a path needs only traverse rights;
listing its contents needs more. A share can pass the reachability check and then refuse
to be listed.

So the script tracks what it is doing, and a failure names the operation as well as the
path — being unable to **list** the share and being unable to **delete** from it are
different permissions with different fixes, and `Access is denied` alone cannot tell them
apart.

---

## 7. Deleting one file at a time

The original piped the whole set into `Remove-Item`. This one loops.

Individually, one locked or protected file is reported and skipped, and the cleanup
continues. Piped, the same file's error behaviour depends on the preference in force —
and under `Stop`, one open log file ends the run.

A file that is open is the ordinary case here, not the exception: these are event log
archives on a share that another job writes to.

Folders are left alone. Only files are deleted, so a server's folder stays on the share
between archive runs rather than vanishing and reappearing.

---

## 8. Paths are names, never IP addresses

*Shared decision. It applies to both automations, and it bites both in the same way.*

The share path must be a hostname or FQDN. `\\fileserver.vcf.lab\archive$` works;
`\\10.113.1.2\archive$` does not.

Kerberos authenticates to a service principal name, which is built from a host name. There
is no SPN for an IP literal, so a UNC path written with one cannot use Kerberos at all: it
falls back to NTLM, the delegated credential is of no use to it, and the share answers
`Access is denied`.

It presents as a share-permissions problem on a share whose permissions are fine, and no
amount of delegation work will fix it. The only fix is to change the path.

Both this script and the workflow's first task **warn** when they are given one, rather
than refusing — a local path or a mapped drive is legitimate, and the caller may know
something the check does not. The script emits its warning *before* the reachability test,
which on an unreachable IP takes about twenty seconds to fail, so the cause appears in the
log ahead of the symptom.

> **Why Ansible never hit this.** The playbooks used `become_method: runas` with an
> explicit password, which performs a fresh logon holding real credentials, and that logon
> can authenticate onward by itself. A script that worked under Ansible can fail here
> unchanged, in an environment where nothing else has changed.

---

## 9. Asking for as little as possible

| Input | How it is avoided |
|---|---|
| PowerShell host | A bound attribute when only one is registered; `selectPowerShellHost` handles the multi-host case |
| File filter | An attribute, not an input. It is a property of the estate, not of the run |
| Share path, retention | Defaults set on the inputs. Static per environment |

**A normal run is: check the two values, click submit.**

Defaults are set directly on each input rather than in a Configuration Element. These
values change roughly never, and a self-contained workflow is one fewer object to find
when something needs checking.

---

## 10. What was left out

| Not done | Why |
|---|---|
| Deleting empty folders | A server's folder disappearing between archive runs looks like the server was removed. Files only |
| A file-exclusion parameter | The original had `$FileExclude`, matching a single name, case-sensitively. `fileFilter` already scopes what is considered, and one hard-coded exclusion is a worse tool than a filter |
| Recursing into the delete | The original `Remove-files` used `Remove-Item -Recurse`, which can remove directories. An unattended job should not have that reach |
| Moving to a recycle location first | There is no recycle bin on a UNC path. Report only, read the list, then run it live — that is the control |
| Reporting per-folder totals | The script logs every file and reports the totals. Per-folder breakdown would be more schema for the same information |
| Email on completion | Not asked for. Orchestrator's own notification workflows can be attached later without touching this package |
