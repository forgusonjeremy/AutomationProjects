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
| "could not list ..." on a folder | The account cannot read that folder. Everything else was still cleaned — check the count at the end of the log. |
| "addressed by IP address" | The share path was typed as an IP. See below. |

---

## One thing that changed from Ansible

The old script asked **"Are you sure you want to delete these files? (Y/N)"** at the
console. On an automated run there is nobody to answer it, so it either hung the job or
read a blank answer and cancelled — which meant the safe preview never actually worked.

**Report only** replaces it. It does what the prompt was meant to do, and it works
unattended.

---

## Two things worth knowing before a live run

**A clean report-only run does not prove the files can be deleted.** Listing a folder and
deleting from it are different permissions. Report only exercises the first and never the
second, so it can pass perfectly on a share the workflow is not allowed to delete from.
The run log says this too. The only way to find out is a live run.

**Always use the file server's name, never its IP address.** `\\fileserver.vcf.lab\share`
works; `\\10.113.1.2\share` does not — and it fails looking exactly like a
share-permissions problem, which sends people to fix the wrong thing.

The reason is Kerberos: it authenticates to a service principal name, which is built from
a host *name*. There is no such name for an IP address, so a path written that way cannot
use Kerberos at all, quietly falls back to NTLM, and is refused.

The workflow warns you — `addressed by IP address`, in the log, before it touches the
share. Take the warning seriously; no amount of permissions work on the share will fix it.
Change the path.
