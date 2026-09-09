# User Guide — Remove Old Archived Logs

Deletes files from the archive share once they are past their retention period. This is
the housekeeping partner to **Move Archived Logs**, which is what fills the share up.

**Workflow:** Production → Servers → Windows → Event Log Management → **Remove Old Archived Logs**

---

## Running it

1. Open the workflow and click **Run**.
2. Check the **Share path** and **Older than days** are what you expect.
3. Click **Submit**.

The first run is a **report only** run. It lists every file it would delete and deletes
nothing. Read that list. If it is right, run it again with **Report only** unticked.

> Report only is on by default and it stays on until you turn it off, every time. There is
> no undo on a deletion, so the list comes first.

---

## The fields

| Field | Default | |
|---|---|---|
| Share path | your archive share | The folder to clean up, including everything beneath it. |
| File filter | `Archive-*.evtx` | Which files to consider. |
| Older than days | `370` | Delete files last written more than this many days ago. Must be at least 1. |
| Report only | **on** | Lists what would be deleted, deletes nothing. |
| PowerShell host *(advanced)* | | Filled in automatically when only one is set up. |

**Older than days cannot be 0.** Zero would mean "everything", which is never what anyone
intends to type. The workflow refuses and deletes nothing.

Folders are left alone. Only files are deleted, so an empty folder may remain — that is
deliberate, so a server's folder does not disappear from the share between archive runs.

---

## Reading the result

| Output | |
|---|---|
| `success` | True when nothing errored. |
| `filesDeleted` | How many files. In a report-only run, how many *would* be deleted. |
| `spaceFreedMB` | How much space. In a report-only run, how much *would* be freed. |
| `transcript` | The full log, listing every file. |

**`success` is false but files were deleted.** Normal. A file that was open or protected
could not be deleted and is listed at the end of the log; everything else was. It will
usually go on the next run.

---

## If something looks wrong

| What you see | What it usually is |
|---|---|
| "Path is not reachable" | The share is down, or the account running this cannot get to it. Nothing was deleted. |
| "OlderThanDays must be at least 1" | Retention was set to 0. Nothing was deleted. |
| More files listed than you expected | Check **Older than days** and the **File filter** before you untick Report only. |
| "could not delete" on a few files | They were open or protected. The rest were deleted. |

---

## One thing that changed from Ansible

The old script asked **"Are you sure you want to delete these files? (Y/N)"** at the
console. On an automated run there is nobody to answer it, so it either hung the job or
read a blank answer and cancelled — which meant the safe preview never actually worked.

**Report only** replaces it. It does what the prompt was meant to do, and it works
unattended.
