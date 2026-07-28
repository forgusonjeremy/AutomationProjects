# User Guide — Windows Server Clean Disks

## 1. What this workflow does

It frees disk space on the Windows servers in a chosen Active Directory security group
by deleting **aged files (and optionally folders)** from one or more target
directories — by default the SCCM download cache `c:\Windows\ccmcache`.

It runs in one of two modes:

- **Report Only** (`whatIf = yes`) — the **default and safe** mode. Lists everything
  that *would* be deleted and deletes nothing.
- **Delete** (`whatIf = no`) — actually deletes.

> **This automation deletes files and there is no undo.** Always do a Report Only run
> first and check the list before running in Delete mode.

---

## 2. What gets deleted

On a **Delete** run, an item is removed only when **all** of the following are true:

1. **Its server is in the target group, directly.** The computer account is a **direct
   member** of the group you specify. Servers only in a **nested sub-group are not
   included**.
2. **Its account is enabled and is a computer.** Disabled accounts and non-computer
   objects (users, groups) are ignored and logged.
3. **It is older than your age threshold** — its last-modified time is older than
   `olderThanDays` days ago.
4. **It is not on the preserved list** (see §3).

Each target path `c:\...` is reached over the server's admin share as
`\\<server>\c$\...`.

---

## 3. What is NOT deleted (important)

The clean deliberately preserves the following. If you expect something to be removed
and it survives, check this list first.

| Not deleted | Why | Can you change it? |
|---|---|---|
| **`vmware-vmsvc-SYSTEM.log`** | Built into the script as a protected file name. **Case-sensitive** — only this exact spelling is protected. | **No** — hardcoded |
| **Anything newer than your threshold** | Only items older than `olderThanDays` are removed. | Yes — `olderThanDays` |
| **Hidden and system files** | The clean does not list hidden files at all, so they are never removed — even with *Delete read-only files* on. (A hidden file *inside a folder that gets deleted* still goes.) | **No** — matches the original automation |
| **The target folder itself** | The workflow **empties** the target (e.g. `c:\Windows\ccmcache`); it never deletes the target folder. | **No** — by design |
| **Read-only files** (when *Delete read-only files* is off) | A read-only file cannot be removed without force. | Yes — `forceEnable` |
| **All folders** (when *Delete folders* is off) | Only files are considered. | Yes — `folderIncluded` |
| **Everything** (in Report Only mode) | Nothing is deleted in a preview run. | Yes — `whatIf` |

**Note on "Delete read-only files" (`forceEnable`):** it controls **read-only files
only**. It does **not** make the clean delete hidden or system files.

---

## 4. Running the workflow

1. In the **Orchestrator Client**, open **`Clean-ServerDisks-ByADGroup`** and click
   **Run**.
2. Fill in the form (fields below).
3. Leave **Report Only?** set to **Yes** for a safe preview.
4. Click **Run** and watch the **Logs** tab.
5. Review the `[ReportOnly] WouldDelete:` lines. When satisfied, re-run with **Report
   Only? = No** to delete.

### Form fields

| Field | What to enter |
|---|---|
| **psHost** | The PowerShell host that runs the clean (usually leave default) |
| **scriptPath** | Path to `cvs_functions.ps1` on the PowerShell host (usually leave default) |
| **groupDN** | The target AD group. A full distinguished name is best, e.g. `CN=Security-Servers,OU=Servers,DC=vcf,DC=lab`. A plain group name also works |
| **domainName** | Your AD domain (e.g. `vcf.lab`) |
| **folderTarget** | Folder(s) to clean, e.g. `c:\Windows\ccmcache`. Separate multiple paths with commas |
| **olderThanDays** | Delete items **older than this many days**. `4` = 4 days old or older; `1` = older than a day; `0` = everything up to now. Must be 0 or greater |
| **folderIncluded** | Tick to delete **folders** as well as files |
| **forceEnable** | Tick to delete **read-only** files (has no effect on hidden files) |
| **whatIf (Report Only?)** | **Yes** = preview only (default). **No** = actually delete |

### Understanding `olderThanDays`

Read it as **"delete items older than N days."**

| Value | Deletes | Today's files? |
|---|---|---|
| `4` | items 4 days old or older | kept |
| `1` | items older than a day | kept |
| `0` | everything up to right now | **deleted** |

---

## 5. Common scenarios

**Cache cleanup (the six standard templates)**
```
folderTarget: c:\Windows\ccmcache   olderThanDays: 1
folderIncluded: yes   forceEnable: no   whatIf: yes → then no
```

**User-profile cleanup (the two profile templates)**
```
folderTarget: c:\users   olderThanDays: 0
folderIncluded: yes   forceEnable: yes   whatIf: yes → then no
```
> The profile templates are far more aggressive: `olderThanDays = 0` removes everything
> up to now, and `forceEnable = yes` also removes read-only files. **Always** preview
> first.

---

## 6. Reading the results

Key transcript lines:

| Line | Meaning |
|---|---|
| `Info: skipping disabled computer object <name>` | A disabled account was excluded |
| `Info: group '<dn>' resolved to N enabled, direct computer member(s).` | How many servers will be processed |
| `Info: clean-ServerDisk - N server(s), … ReportOnly=True/False …` | Run summary; confirms preview vs live |
| `Info: [ReportOnly] WouldDelete: <path>` | Preview — this item *would* be deleted |
| `Info: [<server>] deleted N item(s); M failure(s)` | Live run per-server result |
| `Error: [<server>] failed to delete '<path>': …` | An item could not be removed |
| `Error: [<server>] failed cleaning …` | The server or path was unreachable |

Overall run outcome:

- **Completed Successfully** — no errors; all eligible servers were processed.
- **Completed with Errors** — at least one server or item had a problem (unreachable
  server, undeletable item). Other servers were still processed. Open the logs to see
  which and why.
- **Failed** — the run could not proceed at all (bad inputs, or the AD module/group
  could not be resolved so *every* server would have failed).

---

## 7. Known limitations

- **No undo.** Deleted files are not recoverable by this automation; restore from
  backup/VSS if needed.
- **No per-server structured report or email.** The record of a run is the Orchestrator
  transcript and run history.
- **Hidden/system files are never removed** when loose in a target folder (§3).
- **The `vmware-vmsvc-SYSTEM.log` exclusion cannot be disabled** and is case-sensitive.
- **The target folder itself is never deleted** — only emptied.
- **Servers are processed one after another**, not in parallel.

---

## 8. Testing with lab data

To exercise the workflow safely, seed test data on non-production servers with
`lab/New-DiskCleanTestData.ps1`:

```powershell
# Seed the default ccmcache target on the direct members of a test group
.\New-DiskCleanTestData.ps1 -ADGroup 'Security-Servers' -DomainName vcf.lab

# Or explicit servers; add today-dated files to test the age boundary
.\New-DiskCleanTestData.ps1 -ComputerName winsrv01,winsrv02 -CurrentFiles 3

# If the clean runs as a NON-admin domain account, grant it delete rights
.\New-DiskCleanTestData.ps1 -ADGroup 'Security-Servers' -GrantModifyTo 'VCF\svc_diskclean'
```

It creates aged files in the target root and subfolders, today-dated `_current_*.txt`
files (to demonstrate the age boundary), and three artifacts that **should survive**:
`vmware-vmsvc-SYSTEM.log` (name exclusion), `_readonly_aged.txt` (survives unless
`forceEnable` is on), and `_hidden_aged.txt` (always survives).

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| **Report Only still deleted files** | The PS host is running an **old `cvs_functions.ps1`** without the `whatIf` gate (S-14/S-15). The old script accepts `-WhatIf` but ignores it. Re-stage the current script — see Implementation Guide §1 |
| **Folders were not deleted** | The file filter must match folder names. `fileFilter` is fixed at `*.*` for this reason; if it was changed to something like `*.txt`, no folders will match. Also confirm `folderIncluded` is ticked |
| **Today's files were not deleted** | Expected with `olderThanDays = 1` (keeps anything less than a day old). Use `olderThanDays = 0` to include today |
| **A read-only file was not deleted** | Expected when `forceEnable` is off. Tick *Delete read-only files* |
| **A hidden file was not deleted** | Expected — hidden files are never listed by the clean (§3). Not configurable |
| **`vmware-vmsvc-SYSTEM.log` was not deleted** | Expected — protected file name (§3) |
| **`Error: … failed to delete …: You do not have sufficient access rights`** | Either the file is read-only and `forceEnable` is off, or the service account lacks delete rights on the target. It must be local admin on the server |
| **`ActiveDirectory module not available`** / group won't resolve | RSAT AD module missing on the PS host, or the group DN/domain is wrong |
| **Run ends *Completed with Errors*** | One or more servers/items failed; the rest still processed. Check the `Error:` lines |
| **Nothing was found to delete** | The group resolved to zero enabled direct members, the folder is empty, or nothing is older than `olderThanDays`. Check the `resolved to N …` line |
