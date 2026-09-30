# User Guide — Windows Server Disk Cleans

## 1. What this workflow does

**Windows Server Disk Cleans** frees disk space on the Windows servers in an Active
Directory group. For every server that is a **direct, enabled** member of the group, it
looks in the folders you give it and finds files (and optionally folders) that are older
than the age you set. It then either **reports** what it would delete or **deletes** it,
and emails you a per-server report.

It works the same way for physical servers and VMs. All the work is done from a
PowerShell host over each server's admin share (`\\server\c$`); nothing is installed on
the servers.

**Report Only is the default.** Nothing is deleted unless you choose **Report and Delete**.

---

## 2. What gets deleted

An item is deleted (or, in Report Only, listed) when **all** of these are true:

- it is under one of the folders you listed, at any depth;
- it is a **file whose name matches your filter**, or a **folder** (see below);
- it was last written **more than N days ago** (your "older than" value);
- it is not `vmware-vmsvc-SYSTEM.log`.

Read-only files are deleted only if you tick **Delete read-only items**. Without it they
stay, and each is listed as an error in the report.

### Deleting folders as well

Ticking **Delete folders as well** removes whole sub-folders older than the cutoff,
**whatever their names**, together with everything inside them. Because that removes
everything in the folder, it only happens when you also:

- set the filter to `*.*` (or `*`), **and**
- tick **Delete read-only items**.

If either is missing, **the folders are left alone but the run still goes ahead:** files
matching your filter are cleaned as normal. The run log and the email show a red notice
saying folder deletion was declined and why.

---

## 3. What is NOT deleted (important)

| Never deleted | Why |
|---|---|
| The folders you listed themselves | They are emptied, not removed |
| `vmware-vmsvc-SYSTEM.log` | The live VMware Tools log (exact name) |
| Anything newer than the cutoff | The age rule |
| Hidden or system files sitting directly in a listed folder | Not picked up by the search |
| Read-only files, unless **Delete read-only items** | Protected unless you say otherwise |
| Folders, unless the folder rule above is met | Protected unless fully requested |
| **Everything**, in a Report Only run | Report Only changes nothing |

> **Watch out: a folder goes with everything in it.** A folder's own date changes only
> when something directly inside it is added, removed or renamed. So an old folder can
> contain newer files, and when the folder is removed, they go too, including any
> `vmware-vmsvc-SYSTEM.log` inside it. That is what the profile clean-up relies on to
> remove whole profiles.

**Folders you cannot target.** Drive roots, and anything in or under `\Windows`,
`\Program Files`, `\Program Files (x86)`, `\ProgramData`, `\Boot`, `\Recovery` or
`\System Volume Information`, are refused before anything runs. The exceptions are
`\Windows\ccmcache`, `\Windows\Temp` and `\Windows\SoftwareDistribution\Download`.
`c:\users` is allowed.

---

## 4. Running the workflow

### Form fields

| Field | What to enter |
|---|---|
| **AD Group Distinguished Name** | The group's full DN, e.g. `CN=Monitoring-Servers,OU=Servers,DC=vcf,DC=lab` |
| **Folder where files to be deleted are located** | One local path per row, as seen on each server, e.g. `c:\Windows\ccmcache` |
| **Delete files matching** | `*.*` for every file, or a pattern such as `*.tmp` or `cache_*` |
| **Report Only or Report and Delete?** | **Report Only** to preview; **Report and Delete** to delete |
| **Delete items older than N days** | Whole number. `1` = older than one day, `0` = everything up to now |
| **Delete read-only items?** | Tick to include read-only files |
| **Delete folders as well?** | Tick to remove whole old sub-folders. Needs `*.*` and read-only ticked |
| **Email report?** | Tick to receive the report |
| **Email addresses** | One address per row |
| **Email subject** | Subject stem; the outcome is added automatically |
| **Script directory on the PowerShell host** | Normally leave the default, `C:\PSO\Scripts` |

### Common scenarios

| Goal | Folder | Filter | Days | Read-only | Folders |
|---|---|---|---|---|---|
| SCCM cache, everything older than a day | `c:\Windows\ccmcache` | `*.*` | `1` | ✓ | ✓ |
| SCCM cache, files only | `c:\Windows\ccmcache` | `*.*` | `1` | | |
| Only old `.tmp` files | e.g. `c:\Windows\Temp` | `*.tmp` | `7` | | |
| User profiles, everything | `c:\users` | `*.*` | `0` | ✓ | ✓ |

**Always run Report Only first** against a new group or folder, and read the list before
switching to Report and Delete.

---

## 5. Reading the results

### The email

- **Top line:** the summary, e.g. *"REPORT ONLY -- 1,204 item(s), about 3.41 GB, would be
  deleted across 48 of 50 server(s)"*.
- **Amber line (Report Only):** nothing was deleted.
- **Red line:** folder deletion was requested but declined, and why.
- **Settings:** group, folders, cutoff date, options, and the script that ran.
- **Per-server table:** status, items matched, deleted, failed, space freed (or estimated),
  free space before and after, and detail. Servers with problems are listed first.

### Per-server status

| Status | Meaning |
|---|---|
| `Cleaned` | Everything matched was deleted |
| `CleanedWithErrors` | Some items could not be deleted, or part of a folder could not be read. See Detail |
| `ReportOnly` | Report Only run; nothing deleted |
| `Unreachable` | The server's admin share could not be opened. Detail gives the reason |
| `Failed` | Unexpected error on that server; the others were still processed |

### Overall outcome

- `executionSuccess = true`: every server processed cleanly and, if requested, the email
  was sent.
- `executionSuccess = false`, run completed: something needs attention (an unreachable
  server, undeletable items, a folder missing on every server, or the email not sent).
  The work that could be done was done.
- **Run failed:** it stopped before or during the script (bad input, empty group, no
  PowerShell host available, the script could not be staged or did not finish). Anything
  that failed before the script ran touched nothing.

---

## 6. Testing with lab data

`lab\New-DiskCleanTestData.ps1` creates aged files, nested folders and the "must survive"
items (a `vmware-vmsvc-SYSTEM.log`, a read-only file, a hidden file and files newer than
the cutoff) in the target folders of test servers:

```powershell
# Seed the default ccmcache target on every direct member of a test group
.\New-DiskCleanTestData.ps1 -ADGroup 'Monitoring-Servers' -DomainName vcf.lab

# Reproduce the profile clean-up safely, in a throwaway sub-folder of c:\users
.\New-DiskCleanTestData.ps1 -ComputerName winsrv01 -Scenario profiles
```

Run Report Only, compare the list with what was seeded, then Report and Delete and check
the survivors are still there.

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| *"no servers were resolved"* | The group has no enabled computer accounts as **direct** members. If the log names nested groups, the servers are in those; add them directly or run against each nested group |
| Server `Unreachable` — *"The network path was not found"* | Name, DNS, SMB (445) or the server is down |
| Server `Unreachable` — *"The network name cannot be found"* | The admin share (`c$`) is disabled on that server |
| Server `Unreachable` — *"Access ... denied"* | The host account is not local admin there, or delegation (second hop) is not configured. Browsing the share interactively does not prove the remote session can |
| *"is inside the protected operating-system folder"* | The folder is under `\Windows`, `\Program Files` and so on, and is not an allowed cache. Choose another folder |
| Red notice *"Folder deletion was requested but NOT performed"* | Set the filter to `*.*` **and** tick *Delete read-only items*, or untick *Delete folders as well* |
| Nothing matched although files are there | The filter does not match them (e.g. `Archive-*.evtx` in the SCCM cache), or they are newer than the cutoff |
| Many `could not delete ... read-only` errors | Tick *Delete read-only items*, or leave those files |
| Report not received; closing line says *"report NOT emailed"* | The mail relay refused or could not be reached from Orchestrator. Check with the Orchestrator administrator |
| Run never finishes at the email step | The relay port's security mode does not match STARTTLS (e.g. port set to SSL/TLS). Administrator: Implementation Guide §7 |
| `stageScriptOnHost ... does NOT match ... Overwriting it` | Expected after the script is updated in Orchestrator; unexpected otherwise (someone edited the copy on the host). The host copy is replaced either way |
