# Validation & Testing Plan — Windows Server Disk Cleans

Run the phases in order. Phases A–B need no targets; C–F need a **lab group** whose
direct members are test servers seeded with `lab\New-DiskCleanTestData.ps1`. Never run
Phase D's delete cases against production data.

Record for each case: date, tester, result (Pass/Fail), and the workflow run ID.

---

## Already verified in development (2026-09-29)

These were run on Windows PowerShell 5.1 against real SMB admin shares
(`\\localhost\c$`), and against the vRO scriptable-task code with stubbed plug-in objects.
They do not replace Phases C–F in the customer lab.

| Area | Checks | Result |
|---|---|---|
| Script: selection rules, preserved items, report vs delete | 29 | Pass |
| Script: folder rule (declined vs full request) on a copy of the lab `ccmcache` layout | 23 | Pass |
| Folder-target guard, same 17 paths through the script and *Create Script Parameters* | 17 × 2 | Pass (identical) |
| `stageScriptOnHost`: first copy, unchanged, same-length in-place edit, read-only host copy, multi-chunk, no leftovers | 8 + 13 | Pass |
| `selectPowerShellHost`: least busy, tie-break, unreachable host, list of one, duplicates, real probe | 12 | Pass |
| Scriptable tasks: parameters, folder-rule warning, results parsing, report, closing summary | 19 + 11 + 7 | Pass |
| Admin-share reachability: accessible share, missing host (reason reported) | 2 | Pass |

---

## Phase A — Environment pre-checks

| ID | Check | Expected |
|---|---|---|
| A1 | `curl -vk https://<pshost>:5986/wsman` and read the certificate lines | *"signed using sha256WithRSAEncryption"* |
| A2 | From Orchestrator, *Invoke a PowerShell script* on the host: `Get-ChildItem \\<testsrv>\c$\Windows -Name -ErrorAction Stop` | Returns an item (proves delegation and local admin through a **remote** session) |
| A3 | Same, against a server not in the lab group | Also works, so the account's scope is known |
| A4 | `Get-Item WSMan:\localhost\MaxTimeoutms` on the host | ≥ the longest expected run |
| A5 | `telnet <relay> <port>` from the Orchestrator network | `220 ... ESMTP`, and `250-STARTTLS` after `EHLO` if TLS is used |
| A6 | AD plug-in: `probeAdPlugin` against the lab group | Endpoint found; `computers`/`computerMembers` present |

## Phase B — Deployment checks

| ID | Check | Expected |
|---|---|---|
| B1 | Workflow attributes (Implementation Guide §5) | `psHosts`, `scriptElement` show this environment's objects; SMTP values match the relay |
| B2 | Resource Element name | Exactly `Invoke-ServerDiskClean.ps1` |
| B3 | Workflow outputs | Named `executionOutput` and `serversProcessed` (Implementation Guide §3.1) |
| B4 | Email section | One synchronous *Send notification (TLSv1.2)* element; exception routed to *Closing Summary* (§3.2) |
| B5 | Request form | Defaults and required fields per §3.4 / §6; `olderThanDays` is an integer field |

## Phase C — Script staging

| ID | Case | Expected |
|---|---|---|
| C1 | First run on a host (script absent) | Log: `... is not on <host> yet - copying`, then `staged: ... first copy`; file exists in `targetPath` |
| C2 | Second run, nothing changed | `exact match ... nothing copied`, `unchanged` |
| C3 | Edit the host copy by hand (even one character), run | Warning with both hashes, `updated`; host copy replaced |
| C4 | Re-import a changed script into the Resource Element, run | `updated`; the log shows the new version and hash |
| C5 | Delete the host copy, run | `first copy` again; directory created if missing |
| C6 | `targetPath` set to a UNC path or a relative path | Run fails at staging with *"must be an absolute local directory path"*; nothing touched |

## Phase D — Cleaning behaviour (lab data)

Seed first: `.\New-DiskCleanTestData.ps1 -ADGroup '<lab group>' -DomainName <domain>`.

| ID | Inputs | Expected |
|---|---|---|
| D1 | `c:\Windows\ccmcache`, `*.*`, 1 day, folders ☐, read-only ☐, **Report Only** | Would-delete lists the aged files, including inside sub-folders; nothing deleted; `executionSuccess = true`; email received |
| D2 | As D1, **Report and Delete** | Aged files gone; sub-folders, the read-only file, `vmware-vmsvc-SYSTEM.log`, the hidden file and today's files remain; read-only file logged as an error; status `CleanedWithErrors` |
| D3 | Re-seed. `*.*`, 1 day, folders ☑, read-only ☑, Report and Delete | Aged sub-folders removed whole; read-only file removed; newer files, `vmware-vmsvc-SYSTEM.log` (at top level), and the target folder remain; `Cleaned` |
| D4 | Re-seed. `*.tmp`, folders ☐, Report and Delete | Only `.tmp` files deleted, at any depth; everything else remains |
| D5 | Re-seed. folders ☑, `*.tmp`, read-only ☑, Report Only | **Warning** from *Create Script Parameters*; red *"Folder deletion was requested but NOT performed ... does not match every file"* in the email; only `.tmp` files listed; no folder listed |
| D6 | folders ☑, `*.*`, read-only ☐, Report Only | Declined for the read-only reason; files listed, folders not |
| D7 | 0 days, Report Only | Everything older than the moment of the run is listed |
| D8 | Profile scenario: seed `-Scenario profiles`, target `c:\users\_LabDiskCleanTest`, `*.*`, 0 days, folders ☑, read-only ☑, Report and Delete | Contents removed, including read-only; `_LabDiskCleanTest` itself remains |

## Phase E — Email

| ID | Case | Expected |
|---|---|---|
| E1 | Two recipients in `mailTo`, Report Only | One email to both; subject = stem + group + outcome |
| E2 | `smtpHost` pointed at a non-existent host (one run) | Run completes; `executionSuccess = false`; closing line *"report NOT emailed"* with the reason |
| E3 | `emailReport` unticked | No email; closing line *"email off"* |
| E4 | `mailTo` empty with `emailReport` ticked | Run fails in *Create Script Parameters* (*"no recipient"*) before anything touches a host |

## Phase F — Guards and failure paths

| ID | Case | Expected |
|---|---|---|
| F1 | `folderTarget` = `c:\` | Refused (*"root of a drive"*); nothing runs |
| F2 | `folderTarget` = `c:\Windows\System32\drivers` | Refused (*"inside the protected operating-system folder c:\Windows"*) |
| F3 | `folderTarget` = `c:\Program Files\<vendor>` | Refused |
| F4 | `folderTarget` = `c:\Windows\Temp` | Allowed |
| F5 | Group with only a nested group (no direct computers) | Run fails: *"no servers were resolved"*; warning names the nested group |
| F6 | A disabled computer account in the group | Skipped and logged; not processed |
| F7 | A powered-off member | `Unreachable` with *"The network path was not found"*; others processed; `executionSuccess = false` |
| F8 | A member where the host account is not local admin | `Unreachable` with *"Access ... denied"* and the second-hop hint |
| F9 | A folder that exists on no server (typo) | Error *"did not exist on ANY of the ... reachable server(s)"*; `executionSuccess = false` |
| F10 | Empty filter | Run fails (*"fileFilter is empty"*) |
| F11 | Fractional `olderThanDays` (if the form still allows it) | Run fails (*"must be a whole number"*) |
| F12 | `psHosts` contains a host that is down, plus one that is up | Warning for the down host; run uses the other |

## Phase G — Success criteria

- A1–A6 and B1–B5 pass.
- C1–C5, D1–D8, E1–E3 and F1–F12 pass, with no item deleted that the preserved-items
  list says must remain.
- A Report Only run against each production group completes within the WinRM timeout
  with plausible counts, and the owners of those servers have reviewed the would-delete
  list.
- The cache-template decision (read-only / folders) is recorded in the Change Register.

## Rollback

Disable the schedules. Nothing persists in Orchestrator between runs. Files already
deleted cannot be restored by the workflow.
