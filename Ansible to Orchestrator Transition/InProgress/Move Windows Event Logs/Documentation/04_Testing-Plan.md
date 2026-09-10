# Testing Plan — Move Archived Logs

Work down the list. Each test builds on the one before it, so a failure tells you where
the problem is rather than just that there is one.

`Reference/New-ArchiveLogTestData.ps1` creates aged `Archive-*.evtx` files for testing.

> **Scope.** This plan tests **Move Archived Logs** only. Its partner, *Remove Old
> Archived Logs*, has its own plan in its own package. Part 1 tests prerequisites that are
> **shared** between the two — if you have already run the other package's Part 1 against
> the same PowerShell host, tests 1.1 and 1.3 are already proven.

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
| 1.2a | Same session: `Get-ChildItem \\<server>\C$\Windows\System32\winevt\Logs -File` | Lists files. **`Test-Path` can pass while this fails** — listing needs the credential, a path check does not |
| 1.2b | Same session: `klist` | A `krbtgt` ticket whose flags include **`forwarded`** — that word means the credential was actually delegated. `forwardable` on its own, or only a `HOST/<pshost>` ticket, means it was not, and 1.2a will fail |
| 1.3 | Same session: `Test-Path \\<fileserver>\<share>` | `True` |

> 1.2–1.3 must be run in a session **Orchestrator opened** — not RDP, and not the console.
> Both hold primary credentials and can authenticate onward, so both pass while the real
> thing fails. Test it with a one-line scriptable task calling `runPowerShellScript`, or
> the plug-in's own *Invoke a PowerShell script* workflow.
>
> Setting the PowerShell host to **Kerberos is not sufficient by itself** — see *The double
> hop* in the Implementation Guide. 1.2a is the test that actually catches this; 1.2 alone
> passes on a host that cannot do the work.

---

## Part 2 — Working out the servers

| # | Test | Pass |
|---|---|---|
| 2.1 | Run `getGroupComputers` against the test group | Returns full names (`srv01.connect.lab`), not short names |
| 2.2 | Check the log for the disabled account | `Skipping <name> - its computer account is disabled.` |
| 2.3 | Check the nested group's server is in the list | It is there |
| 2.4 | If you have a second domain, check that server's name | Ends in **its own** domain, not the group's |
| 2.5 | Run it against an empty group | Returns nothing, and warns |
| 2.6 | Run `resolveAdGroup` with the group's DN and `adHost` bound from `findAdHostForDn` | Returns the same group as picking it from the tree |
| 2.6a | Run `resolveAdGroup` with the DN but `adHost` left empty | Fails, and says to bind `adHost` to `findAdHostForDn` |
| 2.7 | Run `findAdHostForDn` with a DN from each domain | Each returns that domain's endpoint |
| 2.7a | Read the log line from 2.7 | Says `matched on ldapBase`. **`matched on name`, or a warning about the name, means `hostConfiguration.ldapBase` is empty** — set the endpoint's `Root` field |
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

## Part 5 — Failures behave

| # | Test | Pass |
|---|---|---|
| 5.1 | Turn off the PowerShell host, run | Fails outright with a plug-in error. Not "0 files moved" |
| 5.2 | Clear the script workflow attribute, run | Fails with `no script was supplied`, naming the binding to set |
| 5.3 | Point `fileServerPath` at a share that does not exist | Every server errors, the workflow finishes and reports it |
| 5.4 | Run with neither `adGroup` nor `adGroupDn` | Stops immediately with a message saying to supply one |
| 5.5 | Run against an empty group | Stops, rather than reporting a successful run that did nothing |

5.1 and 5.5 are the ones that matter most. A workflow that reports success having silently
done nothing is worse than one that fails, because nobody investigates it.

---

## Part 6 — Unattended

| # | Test | Pass |
|---|---|---|
| 6.1 | Schedule the move workflow with `adGroupDn` set as text and `adGroup` empty | Runs on schedule with no input |
| 6.2 | Check its log | Endpoint chosen automatically from the DN's `DC=` parts |

---


---

## Part 7 — The destination, tested on its own

These exist because a clean Part 3 says nothing about the destination, and because when
the destination does fail it reports against the **source** servers. Every one of these
was a real failure that took real time to diagnose.

| # | Test | Pass |
|---|---|---|
| 7.1 | Set `fileServerPath` to the share's **IP** address, run live | Fails. Read the error: it names the *source* servers, not the share. This is the trap — the source paths are FQDNs built from AD names and authenticate fine, so only the typed path is broken |
| 7.2 | Set `fileServerPath` back to the **FQDN**, run live | Works. Nothing else changed |
| 7.3 | From an Orchestrator-opened session on the PowerShell host: `New-Item -ItemType File \\<fileserver>\<share>\writetest.tmp` | Succeeds. This is the permission a report-only run never exercises |
| 7.4 | Read any `Access is denied` error from a failed run | It names the **operation** as well as the path — `while listing files in ...`, `while creating ...`, `while moving files to ...`. If it does not, the script is out of date; re-import it |

> **When an error names a path, check the code actually failed on that path.** An earlier
> version of the script advanced its stage tracking too late, so a *destination* failure
> was reported against the *source* path. The message named a server that was working
> perfectly, and the investigation went to the wrong machine for most of a day. Test 7.4
> is what proves that fix is in the copy you imported.

---

## Sign-off

- [ ] Parts 1 and 2 pass — the plumbing and the AD lookup work
- [ ] Part 3 passes and **nothing moved during it**
- [ ] Part 4 passes, including 4.4 (same-name files in different folders) and 4.5 (`overwriteExisting` off)
- [ ] Part 5 passes — failures fail, and are visible
- [ ] Part 6 passes — scheduled runs work without a person
- [ ] Part 7 passes — the destination has been proven writable by a real write, not by a report
- [ ] `fileServerPath` is an FQDN, and has been checked rather than assumed
- [ ] Anyone with a saved `days_old: -1` from the Ansible era has been told to change it to `0`
