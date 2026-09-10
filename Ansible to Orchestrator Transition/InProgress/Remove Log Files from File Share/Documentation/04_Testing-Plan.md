# Testing Plan — Remove Old Archived Logs

Work down the list. Each test builds on the one before it, so a failure tells you where
the problem is rather than just that there is one.

`Reference/New-ArchiveLogTestData.ps1` creates aged `Archive-*.evtx` files for testing.

> **Scope.** This plan tests **Remove Old Archived Logs** only. Its partner, *Move
> Archived Logs*, has its own plan in its own package. Part 1 tests prerequisites that are
> **shared** between the two — if you have already run the other package's Part 1 against
> the same PowerShell host, most of it is already proven.

---

## Set-up

A test folder on the archive share holding:

- **three or four files older than the retention period** — the ones that should go
- **two files newer than it** — which must survive
- **one file that does not match the filter** (say `notes.txt`) — which must survive
- **one subfolder** with an old file in it — proves the recursion works
- **one subfolder the run account cannot read** — proves one denial does not abandon the run

Use a **disposable folder**, not the live archive. Part 3 deletes for real.

> **Do not skip the unreadable subfolder.** It is the one test here that catches a whole
> class of failure, and it is the easiest to leave out because setting it up takes a
> minute. Deny the run account read on it with an explicit deny ACE:
>
> ```powershell
> icacls <folder> /deny "<DOMAIN>\<runaccount>:(OI)(CI)(RD,RX)"
> ```

---

## Part 1 — Environment

| # | Test | Pass |
|---|---|---|
| 1.1 | Run `probeAdPlugin` with `adGroup` left empty | A PowerShell host is listed. Ignore everything it says about Active Directory — this automation does not use it |
| 1.2 | Check the same output for Resource Elements | `Remove-OldArchivedLogs.ps1` is found. `Move-ArchivedLogs.ps1` reported `NOT IMPORTED` is correct and harmless here |
| 1.3 | From an Orchestrator-opened session on the PowerShell host: `Test-Path \\<fileserver>\<share>` | `True` — this is the double hop |
| 1.4 | Same session: `Get-ChildItem \\<fileserver>\<share> -File` | Lists files. **`Test-Path` can pass while this fails** — listing needs the credential, a path check does not |
| 1.5 | Same session: `klist` | A `krbtgt` ticket whose flags include **`forwarded`**. `forwardable` alone, or only a `HOST/<pshost>` ticket, means the credential was not delegated and 1.4 will fail |
| 1.6 | Same session: `New-Item -ItemType File \\<fileserver>\<share>\writetest.tmp`, then delete it | Both succeed. **This is the only test that proves delete permission**, and no report-only run will ever tell you |

> 1.3–1.6 must be run in a session **Orchestrator opened** — not RDP, and not the console.
> Both of those hold primary credentials and can authenticate onward, so both pass while
> the real thing fails. `Code/Probe-ServerAccess.ps1` does all of this and reports it
> through `runPowerShellScript`.

---

## Part 2 — Cleaning up, report only

**Leave `reportOnly` ticked for all of Part 2.** Confirm afterwards that nothing was
deleted.

| # | Test | Pass |
|---|---|---|
| 2.1 | Run against the test folder | Lists `would delete ...` per file. The count matches the old files you created |
| 2.2 | Check the newer files and `notes.txt` | Not listed. The filter and the cutoff both work |
| 2.3 | Check the file in the readable subfolder | Listed. Recursion works |
| 2.4 | Check the log for the unreadable subfolder | One **error**, `could not list ...`, naming that folder. The run still completed and still reported a result |
| 2.5 | Confirm on the share | **Every file still there. Nothing was deleted** |
| 2.6 | Read the log for the report-only caveat | It says a clean report proves the files can be listed, not that they can be deleted |

---

## Part 3 — Cleaning up, for real

**This part deletes files.** Use the disposable test folder.

| # | Test | Pass |
|---|---|---|
| 3.1 | Untick `reportOnly`, run | Only the old matching files are gone. Count matches what 2.1 predicted |
| 3.2 | Check the newer files and `notes.txt` | Still there |
| 3.3 | Check the MB freed against the file sizes | They match |
| 3.4 | Check the folders | Still there, including now-empty ones. **Only files are deleted** |
| 3.5 | Check the unreadable subfolder's file | Still there, and still reported as one `could not list` error. Everything else was cleaned |
| 3.6 | Lock a file open, run again | That file is one error, the rest are still deleted |
| 3.7 | Run once more with nothing left old enough | `Files matched : 0`, succeeds, no errors |
| 3.8 | Check the PowerShell host's `%TEMP%\Orchestrator` folder | Empty. The script deletes itself after every run |

---

## Part 4 — Failures behave

| # | Test | Pass |
|---|---|---|
| 4.1 | Set `olderThanDays` to `0`, run | Refuses, deletes nothing, and says why. **The guard against a mistyped retention** |
| 4.2 | Set `olderThanDays` to `-5`, run | Refuses the same way |
| 4.3 | Point `sharePath` at a path that does not exist | `Path is not reachable`, nothing deleted, workflow reports it |
| 4.4 | Set `sharePath` to the share's **IP** address, run | Warns `addressed by IP address` in the workflow log **before** it tries the share. This is the trap that looks exactly like a share-permissions problem |
| 4.5 | Turn off the PowerShell host, run | Fails outright with a plug-in error. Not "0 files deleted" |
| 4.6 | Clear the `scriptElement` attribute, run | Fails with `no script was supplied`, naming the binding to set |
| 4.7 | **Deny the run account delete (but not read) on the test folder, run live** | Every file reports `could not delete`. Nothing is silently skipped, and `success` is false |

> **4.7 is the test this automation exists to have.** It is the failure a report-only run
> can never predict, because listing and deleting are different permissions. If you run
> only one test from Part 4, run this one.

> **4.4 must warn, not just fail.** An IP path will fail eventually on its own; the point
> of the test is that the *cause* appears in the log before the symptom does. Without that
> warning the run looks like a share-permissions fault and sends people to fix an ACL that
> is already correct.

---

## Part 5 — The result-line contract

The script writes exactly one `PSO_RESULT` line, always, even when it refuses to run.
Orchestrator treats its absence as a failure rather than as "zero files", so a broken run
cannot be mistaken for a clean one. These tests prove that contract holds.

| # | Test | Pass |
|---|---|---|
| 5.1 | Re-read the logs from 2.4, 3.5, 4.1 and 4.3 | Every one of them ends with a `PSO_RESULT=` line and returns workflow outputs |
| 5.2 | Confirm **none** of them failed with `did not report a result` | If any did, the imported script is missing the enumeration guard — re-import `Remove-OldArchivedLogs.ps1` from `Code/` |

> `did not report a result` reads as *"the script never ran"*. On an unreadable folder it
> used to mean the opposite: the script ran, and was denied. That is why the enumeration is
> guarded, and why 5.2 is worth a minute of your time.

---

## Part 6 — Unattended

| # | Test | Pass |
|---|---|---|
| 6.1 | Schedule the workflow against the test folder with `reportOnly` **on** | Runs on schedule with no input, lists candidates, deletes nothing |
| 6.2 | Schedule it with `reportOnly` **off** | Runs, deletes only what is past retention |
| 6.3 | Check the run record afterwards | `success`, `filesDeleted`, `spaceFreedMB` and `transcript` are all populated. **Empty outputs mean the OUT tab was never bound** — the workflow will look successful with nothing to show |

---

## Sign-off

- [ ] Part 1 passes, **including 1.6** — delete permission proven by a real delete
- [ ] Part 2 passes and **nothing was deleted during it**
- [ ] Part 3 passes, including 3.5 (unreadable folder does not abandon the run)
- [ ] Part 4 passes, **including 4.7** — the read-but-not-delete case
- [ ] Part 5 passes — every run reported a result line
- [ ] Part 6 passes — scheduled runs work, and their outputs are bound
- [ ] `sharePath` is an FQDN, and has been checked rather than assumed
- [ ] The retention period has been agreed with whoever owns the logs, not just defaulted
