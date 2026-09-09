# Testing Plan

Work down the list. Each test builds on the one before it, so a failure tells you where
the problem is rather than just that there is one.

`Reference/New-ArchiveLogTestData.ps1` creates aged `Archive-*.evtx` files for testing.

---

## Set-up

An AD group holding:

- two or three enabled servers
- **one disabled** computer account — proves disabled machines are skipped
- **one nested group** with a server in it — proves nesting is followed
- **one server that is switched off** — proves one bad server does not stop the rest

If you have a second domain, put a server from it in the nested group. That proves the
per-computer domain handling, which nothing else here exercises.

---

## Part 1 — Environment

| # | Test | Pass |
|---|---|---|
| 1.1 | Run `probeAdPlugin` with a real group | Endpoints listed, PowerShell host listed, both scripts found, at least one membership property present |
| 1.2 | From an Orchestrator-opened session on the PowerShell host: `Test-Path \\<server>\C$` | `True` — this is the double hop |
| 1.3 | Same session: `Test-Path \\<fileserver>\<share>` | `True` |

> 1.2 and 1.3 must be run in a session **Orchestrator opened**, not an RDP session. An RDP
> session has a credential that a delegated one may not, so it will pass while the real
> thing fails. Test it with a one-line scriptable task calling `runPowerShellScript`, or
> the plug-in's own *Invoke a PowerShell script* workflow.

---

## Part 2 — Working out the servers

| # | Test | Pass |
|---|---|---|
| 2.1 | Run `getGroupComputers` against the test group | Returns full names (`srv01.connect.lab`), not short names |
| 2.2 | Check the log for the disabled account | `Skipping <name> - its computer account is disabled.` |
| 2.3 | Check the nested group's server is in the list | It is there |
| 2.4 | If you have a second domain, check that server's name | Ends in **its own** domain, not the group's |
| 2.5 | Run it against an empty group | Returns nothing, and warns |
| 2.6 | Run `resolveAdGroup` with an empty first input and the group's DN as text | Returns the same group as picking it |
| 2.7 | Run `findAdHostForDn` with a DN from each domain | Each returns that domain's endpoint |
| 2.8 | Run `findAdHostForDn` with `CN=x,DC=nosuch,DC=domain` | Fails, and lists the endpoints that are registered |

2.6 and 2.7 are what scheduled runs depend on. They are easy to skip because the form
never uses them, and then the first overnight run is the test.

---

## Part 3 — Moving files, report only

**Leave `reportOnly` ticked for all of Part 3.** Confirm afterwards that nothing moved.

| # | Test | Pass |
|---|---|---|
| 3.1 | Run against the test group | Lists `would move ...` per file, moves nothing |
| 3.2 | Compare the count against what is really on one server | They match — this is the double-counting fix (4.1) |
| 3.3 | Set `olderThanDays` to 0 | Every matching file is listed |
| 3.4 | Set `olderThanDays` to a value between your oldest and newest test files | Only the older ones are listed. **Under Ansible this behaved the opposite way** — see 4.2 |
| 3.5 | Set `olderThanDays` to `-1` | Refuses, errors clearly. The old playbooks used `-1` as their normal setting |
| 3.6 | Check the switched-off server | Reported as an error, and the other servers still processed |
| 3.7 | Check the destination share | **Unchanged. Nothing moved.** |

---

## Part 4 — Moving files, for real

| # | Test | Pass |
|---|---|---|
| 4.1 | Untick `reportOnly`, run | Files move. Count matches what 3.1 predicted |
| 4.2 | Look at the share | One folder per server, named after the server |
| 4.3 | Put a file in a subfolder under the source, run again | The subfolder is recreated at the destination, not flattened |
| 4.4 | Put two files with the same name in different subfolders, run | Both arrive, in their own subfolders. **Under Ansible one silently replaced the other** — see 4.3 |
| 4.5 | Run again with a file already at the destination and `overwriteExisting` off | Reported as an error, source file left where it is, workflow finishes |
| 4.6 | Same with `overwriteExisting` on | Overwritten, no error |
| 4.7 | Run once more with nothing left old enough | `nothing matched`, succeeds, no errors |
| 4.8 | Check the PowerShell host's `%TEMP%\Orchestrator` folder | Empty. The script deletes itself after every run |

---

## Part 5 — Cleaning up the share

| # | Test | Pass |
|---|---|---|
| 5.1 | Run with `reportOnly` on | Lists candidates. **Nothing is deleted** |
| 5.2 | Confirm on the share | Every file still there |
| 5.3 | Set `olderThanDays` to 0 | Refuses — the guard against a mistyped retention |
| 5.4 | Untick `reportOnly`, run | Only files past the retention are gone |
| 5.5 | Check the MB freed against the file sizes | They match |
| 5.6 | Lock a file open, run again | That file is an error, the rest are still deleted |

---

## Part 6 — Failures behave

| # | Test | Pass |
|---|---|---|
| 6.1 | Turn off the PowerShell host, run | Fails outright with a plug-in error. Not "0 files moved" |
| 6.2 | Rename the Resource Element, run | Fails with `no Resource Element named ...` |
| 6.3 | Point `targetPath` at a share that does not exist | Every server errors, the workflow finishes and reports it |
| 6.4 | Run with neither `adGroup` nor `adGroupDn` | Stops immediately with a message saying to supply one |
| 6.5 | Run against an empty group | Stops, rather than reporting a successful run that did nothing |

6.1 and 6.5 are the ones that matter most. A workflow that reports success having silently
done nothing is worse than one that fails, because nobody investigates it.

---

## Part 7 — Unattended

| # | Test | Pass |
|---|---|---|
| 7.1 | Schedule the move workflow with `adGroupDn` set as text and `adGroup` empty | Runs on schedule with no input |
| 7.2 | Check its log | Endpoint chosen automatically from the DN's `DC=` parts |
| 7.3 | Schedule the cleanup for a different day | Runs, deletes only what is past retention |

---

## Sign-off

- [ ] Parts 1 and 2 pass — the plumbing and the AD lookup work
- [ ] Part 3 passes and **nothing moved during it**
- [ ] Part 4 passes, including 4.4 (same-name files in different folders)
- [ ] Part 5 passes and 5.1 deleted nothing
- [ ] Part 6 passes — failures fail, and are visible
- [ ] Part 7 passes — scheduled runs work without a person
- [ ] Anyone with a saved `days_old: -1` from the Ansible era has been told to change it to `0`
