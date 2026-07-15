# Remove Old Files (UNC Share) — User Guide

## Purpose

**Remove-OldFiles-UNCShare** deletes files on a UNC archive share that are older
than a chosen retention age. It is share **housekeeping only** — it does not touch
source servers or Active Directory. It defaults to a safe **report-only** run.

---

## Before you run

- The PowerShell host must be registered in Orchestrator (one-time shared setup).
- Know the **UNC share path** to clean and the **retention age** in days.
- `scriptPath` and `olderThanDays` are pre-filled from the Configuration Element;
  override per run if needed. `uncSharePath` has no default — supply it each run.
- Confirm the updated `cvs_functions.ps1` (`-ReportOnly`) is deployed, otherwise
  `whatIf='yes'` may block (see Troubleshooting).

---

## How to run

1. Open the workflow → **Run**.
2. Complete the form:

   | Input | Meaning | Example |
   |---|---|---|
   | `psHost` | The registered PowerShell host | `pshost.vcf.lab` |
   | `scriptPath` | Full path to `cvs_functions.ps1` on the host | `C:\PSO\Scripts\cvs_functions.ps1` |
   | `uncSharePath` | Share / path to clean (per run, no default) | `\\fileserver.vcf.lab\mdcarchivelog$\Windows` |
   | `olderThanDays` | Delete files older than N days (minimum 1) | `370` |
   | `whatIf` | `yes` = report only (no deletion); `no` = delete for real | `yes` |

3. **Run.**

---

## The whatIf safety workflow

**Deletions are permanent and are not automatically recoverable.** Always preview
first.

1. Run with **`whatIf='yes'`** (the default). Nothing is deleted.
2. Review the run log `[ReportOnly] WouldDelete: <file>` lines and confirm the list
   is correct.
3. Only when the list is acceptable, run again with **`whatIf='no'`** to delete.

> `whatIf` is the **sole** safety control. There is no interactive prompt under
> Orchestrator — `no` deletes immediately.

---

## Outputs

- `executionSuccess` (boolean) — `true` if no `Error:` lines were detected.
- `executionOutput` (string) — summary text (report or deletion summary), or an
  error description.

---

## Common scenarios

- **Preview a cleanup:** run with `whatIf='yes'` and read the `WouldDelete` list.
- **Perform a cleanup:** after a verified preview, run with `whatIf='no'`.
- **Different retention age:** override `olderThanDays` at run time (min 1).
- **Different share:** set `uncSharePath` per run.
- **Scheduled housekeeping:** schedule with `whatIf='no'` **only** after a verified
  report-only run for that share and age.

---

## Known limitations

- **No per-file structured report object** — the run log carries the aggregate
  `[ReportOnly] WouldDelete:` / Deletion Summary text (structured/email reporting
  is Phase 2).
- **Single UNC target per run** — no AD resolution and no multi-share loop.
- **Second-hop dependency** — reaching the share requires the host's authentication
  to carry the credential (Kerberos + delegation or Basic-over-HTTPS) and
  write/delete access for the service account.
- **Report-only requires the patched script** — `whatIf='yes'` needs the S-1
  `-ReportOnly` change deployed.

---

## Reading results

| End state | Meaning |
|---|---|
| **Completed Successfully** | No `Error:` lines detected; the report ran (whatIf=yes) or the deletion ran (whatIf=no) |
| **Completed with Errors** | One or more `Error:` lines were logged (e.g. share access issue, or an invalid `whatIf` value). Review the run log |
| **Failed: Bad Inputs** | An input failed validation (empty path, `olderThanDays < 1`, or `whatIf` not `yes`/`no`) |
| **Failed: PS Execution** | A terminating/total failure (e.g. host unreachable, plug-in error) |

---

## Troubleshooting basics

| Symptom | Likely cause / action |
|---|---|
| Cleanup deleted nothing but you expected deletions | `whatIf` was `yes` (report-only). Re-run with `whatIf='no'` after reviewing the `WouldDelete` list |
| `whatIf='yes'` run blocks / hangs / cancels | The deployed `cvs_functions.ps1` lacks `-ReportOnly` (older version) — deploy the updated script (change S-1), or use `whatIf='no'` only |
| **Completed with Errors**, `Error:` lines about the share path | Access-denied or path unreachable — check the second-hop auth (Kerberos delegation / Basic-over-HTTPS) and the service account's write/delete access on the share |
| **Failed: Bad Inputs** | Empty `uncSharePath`/`scriptPath`, `olderThanDays < 1`, or `whatIf` not `yes`/`no` |
| **Failed: PS Execution**, auth error | See the shared PS-Host guide (Basic vs Kerberos, Kerberos error mapping) |

For deeper diagnostics, open the workflow run → **Logs** and review the
`Info:`/`Warn:`/`Error:` lines emitted by the script.
