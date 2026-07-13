# Windows Archive Log Management — User Guide

**Project:** Ansible → VCF Orchestrator transition — "Move Windows Event Logs"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Audience:** Operators running the workflows
**Status:** Draft — Phase 1

---

## Purpose

Two Orchestrator workflows manage Windows event-log archives:

- **Move-ArchivedLogs-ByADGroup** — moves archived logs (`Archive-*.evtx`) off
  every **enabled** server in an AD group to a central archive share, into a
  per-server subfolder.
- **Remove-OldFiles-UNCShare** — deletes files on the archive share that are
  older than a chosen retention age. Defaults to a safe **report-only** run.

Server selection, disabled-host filtering, and per-server iteration are handled
inside the solution — you provide the group and the parameters.

---

## Before you run

- The PowerShell host must be registered in Orchestrator (one-time setup).
- Know your **AD group DN**, **domain**, **archive share path**, and the
  **file filter/age** (defaults usually suffice).
- Most fields are pre-filled from each input's default value; override per run as
  needed. (Move-ArchivedLogs-ByADGroup defaults are set on the inputs themselves;
  Remove-OldFiles-UNCShare's script path and retention default come from a
  Configuration Element.)

---

## Move-ArchivedLogs-ByADGroup — how to run

1. Open the workflow → **Run**.
2. Complete the form:

   | Input | Meaning | Example |
   |---|---|---|
   | `psHost` | The registered PowerShell host | `pshost.vcf.lab` |
   | `scriptPath` | Full path to `cvs_functions.ps1` on the host | `C:\PSO\Scripts\cvs_functions.ps1` |
   | `groupDN` | **AD group distinguishedName** (preferred, unambiguous) | `CN=WinLogServers,OU=Groups,DC=vcf,DC=local` |
   | `domainName` | AD domain to resolve against | `vcf.lab` |
   | `fileShareTarget` | Archive destination root (UNC) | `\\fileserver.vcf.lab\mdcarchivelog$\Windows` |
   | `fileFilter` | File-name filter to move | `Archive-*.evtx` |
   | `fileAgeDays` | Move files older than *(today + value)* days; use `0` or negative | `-1` |

3. **Run.** Watch the run log for per-server `Info: <server> - moving archived files …` lines.

**Outputs**
- `executionSuccess` (boolean) — `true` if no errors were detected.
- `executionOutput` (string) — summary text, or an error description.

**Result files:** moved to `<fileShareTarget>\<server-short-name>\`.

> `groupDN` also accepts CN / sAMAccountName / GUID / SID, but a full DN is
> recommended. A non-DN value logs a warning and still runs.

---

## Remove-OldFiles-UNCShare — how to run

1. Open the workflow → **Run**.
2. Complete the form:

   | Input | Meaning | Example |
   |---|---|---|
   | `psHost` | The registered PowerShell host | `pshost.vcf.lab` |
   | `scriptPath` | Full path to `cvs_functions.ps1` | `C:\PSO\Scripts\cvs_functions.ps1` |
   | `uncSharePath` | Share/path to clean | `\\fileserver.vcf.lab\mdcarchivelog$\Windows` |
   | `olderThanDays` | Delete files older than N days (min 1) | `370` |
   | `whatIf` | `yes` = report only (no deletion); `no` = delete for real | `yes` |

3. **Run with `whatIf='yes'` first.** Review the `[ReportOnly] WouldDelete:` lines.
4. Only when the list is acceptable, run again with `whatIf='no'`.

> **`whatIf` is the safety control.** It defaults to `yes`. There is no
> interactive prompt — `no` deletes immediately.

---

## Common scenarios

- **Scheduled housekeeping:** schedule Move-ArchivedLogs-ByADGroup (e.g. daily)
  and Remove-OldFiles-UNCShare (e.g. monthly, `whatIf='no'` after a verified
  report run) in Orchestrator.
- **Add/remove servers:** change **AD group membership** — no workflow or code
  change. The PS host itself can be a group member.
- **One-off different file type/age:** override `fileFilter` / `fileAgeDays` at run time.
- **Preview a cleanup:** run Remove with `whatIf='yes'`.

---

## Known limitations

- **No per-server status object in Orchestrator** — the run log shows aggregate
  stdout; per-server structured reporting is Phase 2.
- **No email report** on completion (Phase 2).
- **Partial per-server failure granularity** — if one server errors mid-move,
  that server's remaining files in that pass may be skipped (logged); other
  servers are unaffected.
- **Second-hop dependency** — moving to/from remote shares requires the host's
  authentication to carry the credential (Kerberos+delegation or Basic-over-HTTPS).

---

## Reading results

| End state | Meaning |
|---|---|
| **Completed Successfully** | No `Error:` lines detected; all targeted moves/deletes ran |
| **Completed with Errors** | One or more per-server failures were logged; the rest still processed. Review the run log |
| **Failed: Bad Inputs** | An input failed validation (e.g. empty `groupDN`, non-numeric `fileAgeDays`) |
| **Failed: PS Execution** | A terminating/total failure (e.g. host unreachable, AD module missing, group unresolvable) |

---

## Troubleshooting basics

| Symptom | Likely cause / action |
|---|---|
| **Completed with Errors**, `Error: [<server>] failed moving …` | That server was unreachable or its `C$` share was inaccessible. Confirm it is up and the account has admin-share access. Other servers were still processed |
| No servers processed, `Warn: … zero enabled computer objects` | Group is empty, all members disabled, or `groupDN`/`domainName` wrong |
| **Failed: PS Execution**, access-denied on `\\server\C$` or `\\fileshare` | Second-hop auth not carrying the credential — check Kerberos constrained delegation, or use Basic-over-HTTPS |
| **Failed: PS Execution**, "ActiveDirectory module … not available" | RSAT AD tools missing on the PS host |
| Host add / run fails with an auth error | See the Implementation Guide, Phase 4 (Basic vs Kerberos) and the Kerberos error mapping |
| Cleanup deleted nothing but you expected deletions | `whatIf` was `yes` (report-only). Re-run with `whatIf='no'` after reviewing |
| Files not where expected | Check `fileShareTarget`; results are under `<share>\<server-short-name>\` |

For deeper diagnostics, open the workflow run → **Logs**, and review the
per-server `Info:`/`Warn:`/`Error:` lines emitted by the script.
