# Design Decisions

Why this package looks the way it does. Read this first if you knew the Ansible playbooks.

---

## 1. Five playbooks became one workflow

The source was five playbooks that all did the same job:

| Playbook | How it picked servers | How it reached the files |
|---|---|---|
| `file-move_with-LocalPath_Inventory.yml` | a static list in an inventory file | ran on each server, moved its own files |
| `file-move_with-LocalPath_AD-Group.yml` | AD group | ran on each server, moved its own files |
| `file-move_with-UNCPath_AD-Group.yml` | AD group | ran on one host, reached the others over UNC |
| `file-move_with-UNCPath_AD-Group-TEST(1).yml` | AD group, with a named domain | ran on one host, reached the others over UNC |
| `remove-OldFiles-UNCPath.yml` | n/a — a share | ran on one host |

The move logic inside all four move playbooks is the **same `Move-files` function**,
copied four times. What actually differed was two choices, made independently.

### Choice one: how servers are picked → **Active Directory group**

A static inventory file is a second list of servers to keep up to date, and it goes stale
the moment somebody builds a server and forgets it. The AD group is already maintained,
already audited, and already the thing that decides what a server *is*. Adding a server to
the group is how it gets included; that is the whole interface.

### Choice two: how files are reached → **UNC from one host**

Running locally on each server would mean registering every one of them as a PowerShell
host in Orchestrator. That is a plug-in object per server, kept in step with the estate by
hand — unworkable past a handful of machines, and pointless when one host can reach them all
over `\\server\C$`.

So: **one AD group in, one PowerShell host doing the work, files pulled over UNC.**
That is the `file-move_with-UNCPath_AD-Group` shape, and the other three collapse into it.

---

## 2. The Active Directory lookup left PowerShell

This is the biggest change, and it is what the rest of the design hangs off.

**Before.** Ansible connected to a Windows host over WinRM, carrying a username and
password, and ran `Get-ADGroupMember` there. The credentials were playbook variables:

```yaml
ansible_user: "{{ WinRM_username }}"
ansible_password: "{{ WinRM_password }}"
```

**Now.** Orchestrator's Active Directory plug-in is asked directly. No PowerShell runs, no
host is involved, and no credential goes anywhere — the plug-in uses the account stored
against the domain endpoint, inside Orchestrator.

That removes an entire hop, and with it every place a password used to appear.

### Which domain? Nobody is asked

Every AD object carries its domain in its own name:

```
CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab
                                 ^^^^^^^^^^^^^^^^^
                                 this can only be connect.lab
```

So the domain is never a question put to an operator. There are two paths and neither one
asks:

- **A person running it** picks the group from a tree in the request form. Orchestrator
  hands over the group already attached to the right endpoint. Nothing is typed.
- **A schedule or an API call** passes the group's `distinguishedName` as text, because
  there is nobody to click a tree. `findAdHostForDn` reads the `DC=` parts off the end and
  matches them to a registered endpoint.

In both cases the endpoint follows from the object, so the two cannot disagree. Compare
`file-move_with-UNCPath_AD-Group-TEST(1).yml`, which asked for `DomainName` *and* a group
DN as separate variables — two facts that had to be kept in step by whoever filled in the
form, and nothing checked that they were.

Adding a domain to the estate means registering one more AD endpoint. No code changes.

### Nested groups

The AD plug-in is walked down through nested groups, as deep as they go, and a group that
has already been seen is not visited twice. Of the two playbook generations, one recursed
and one did not — `-TEST(1)` read direct members only and silently missed anything in a
nested group. Both behaviours existed at once, in files a few lines apart.

---

## 3. The PowerShell is a script, not a here-doc

The playbooks embedded PowerShell inline as `win_shell` heredocs — the same function
pasted into four YAML files. Change it in one and the others drift.

Now there is one script per job, stored in Orchestrator as a **Resource Element**. At run
time `runPowerShellScript` writes it to the PowerShell host as a real `.ps1`, runs it by
path, and deletes it.

Written to disk and invoked by path, rather than piped in as a string, so that **what you
test at a console is what the workflow runs**. An administrator can copy the same script
to a server, run it by hand with the same parameters, and get the same behaviour. Deleting
it afterwards means no stale copy is left to drift out of step with the version in
Orchestrator — which is exactly what went wrong with the pre-staged toolbox script this
replaces.

### How the script talks back

The script prints readable log lines for people, and exactly one line for Orchestrator:

```
PSO_RESULT={"serversProcessed":4,"moved":118,"errorCount":0,"errors":[]}
```

One line, always printed, even when the script does nothing. Everything else in the output
can be reworded freely without breaking anything. And because it is always printed, its
absence means something real: the script did not finish. Orchestrator treats a missing
result line as a failure rather than as "zero files", so a broken run cannot be mistaken
for a clean one.

---

## 4. Four things the playbooks got wrong

These are deliberate corrections. Each one changes what you will see in the output, so
they are listed here rather than buried in the script.

### 4.1 File counts were double

```powershell
$movedFiles = Get-ChildItem ... | ForEach-Object {
    Move-Item -Path $_.FullName -Destination "$serverTargetPath" -Force -PassThru
    $_.Name
}
$fileCount = ($movedFiles | Measure-Object).Count
```

`-PassThru` emits the moved file **and** `$_.Name` emits its name, so every single move put
two items in the collection. Every "Moved N files" message ever produced reported exactly
twice the real number.

Now: a counter, incremented once per confirmed move.

### 4.2 "Older than N days" meant "newer than N days"

```powershell
$dateTime = (Get-Date).AddDays([int]$Days)
... | Where-Object { $_.LastWriteTime -lt $dateTime }
```

`AddDays` with a positive number moves the cutoff **into the future**, so a larger value
matched *more* files, not fewer. `30` meant "everything". The working convention was
`days_old: -1`, a negative number, which is the giveaway — it had to be negative to make
the sign come out right.

Now: `(Get-Date).AddDays(-$OlderThanDays)`, so the parameter does what its name says, and
`0` means every age. **Negative values are rejected** — carrying the old `-1` convention
forward would put the cutoff in the future and move everything in scope.

> If you have a saved schedule or a runbook that passes `-1`, change it to `0`.

### 4.3 Files in different folders overwrote each other

The playbooks gathered with `-Recurse` and dropped everything into one flat folder with
`-Force`. Two files with the same name in different subfolders — and the second silently
replaced the first.

Now the destination mirrors the source structure beneath the per-server folder, and an
existing file is **not** overwritten unless `overwriteExisting` is ticked. A collision is
reported as an error and the source file is left where it is, so nothing is destroyed by a
run that did not expect it.

### 4.4 There was no dry run

Both workflows now start with **report only** switched on. A run that is not explicitly
told to make changes will only ever list what it would have done.

For the cleanup workflow this replaces an interactive prompt:

```powershell
$Confirmation = Read-Host "Are you sure you want to delete these files? (Y/N)"
```

There is nobody at a console during an automated run. That prompt either hung the job or
read empty input and cancelled, so the "safe preview" mode never actually worked.

---

## 5. Asking for as little as possible

Every input either comes from something the operator already picked, or has a default that
is right nearly always.

| Input | How it is avoided |
|---|---|
| Domain | Read from the group's own name. Never asked. |
| AD endpoint | Follows from the domain. Never asked. |
| PowerShell host | Auto-selected when only one is registered. Only asked when there is a genuine choice. |
| Source path, target share, file filter, retention | Defaults set on the inputs. Static per environment. |
| Which servers | The AD group's membership. |

**A normal run is: pick a group, click submit.** Everything else is already filled in.

Defaults are set directly on each input rather than in a Configuration Element. These
values change roughly never, and a self-contained workflow is one fewer object to find
when something needs checking.

---

## 6. What was left out

| Not done | Why |
|---|---|
| Per-server status as separate workflow outputs | The script logs per-server results and reports the totals. Splitting them into Orchestrator objects would mean a loop and a lot more schema for the same information. |
| Running servers in parallel | The script works through them one at a time. At this volume it is quick enough, and serial output is far easier to read when something has gone wrong. |
| Email on completion | Not asked for. Orchestrator's own notification workflows can be attached later without touching this package. |
| vCenter plug-in | Considered and not needed. Moving files through VMware Tools would need guest credentials for every server — the opposite of the point. |
| Rollback | A move is not undone automatically. Report only, then check the destination, is the control. |
