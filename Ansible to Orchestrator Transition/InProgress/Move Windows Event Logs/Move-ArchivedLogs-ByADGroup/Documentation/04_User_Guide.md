# Move Archived Logs (By AD Group) — User Guide

## Purpose

**Move-ArchivedLogs-ByADGroup** moves archived event logs (`Archive-*.evtx`) off every **enabled** server in an AD group to a central archive share, into a per-server subfolder (`<fileShareTarget>\<server-short-name>\`).

Server selection, disabled-host filtering, and per-server iteration are handled inside the solution — you provide the group and the parameters. One run processes the whole group in a single script invocation.

## Before you run

- The PS host must be registered in Orchestrator (one-time setup).
- Know your **AD group DN**, **domain**, **archive share path**, and the **file filter/age** (defaults usually suffice).
- Most fields are pre-filled from each input's default value; override per run as needed. Defaults for this workflow are set on the inputs themselves (no Configuration Element).

## How to run

1. Open the workflow → **Run**.
2. Complete the form:

   | Input | Meaning | Example |
   |---|---|---|
   | `psHost` | The registered PowerShell host | `pshost.vcf.lab` |
   | `scriptPath` | Full path to `cvs_functions.ps1` on the host | `C:\PSO\Scripts\cvs_functions.ps1` |
   | `groupDN` | **AD group distinguishedName** (preferred, unambiguous) | `CN=WinLogServers,OU=Groups,DC=vcf,DC=lab` |
   | `domainName` | AD domain to resolve against (used as `-Server` target) | `vcf.lab` |
   | `fileShareTarget` | Archive destination root (UNC) | `\\fileserver.vcf.lab\mdcarchivelog$\Windows` |
   | `fileFilter` | File-name filter to move | `Archive-*.evtx` |
   | `fileAgeDays` | Move files older than *(today + value)* days; use `0` or a negative value | `-1` |

3. **Run.** Watch the run log for per-server `Info: <server> - moving archived files …` lines.

> `groupDN` also accepts CN / sAMAccountName / GUID / SID, but a full DN is recommended. A non-DN value (no `DC=`) logs a warning and still runs.

## Outputs

- `executionSuccess` (boolean) — `true` if no errors were detected.
- `executionOutput` (string) — summary text, or an error description.
- **Result files:** moved to `<fileShareTarget>\<server-short-name>\`.

## Common scenarios

- **Scheduled housekeeping:** schedule the workflow (e.g. daily) in Orchestrator.
- **Add/remove servers:** change **AD group membership** — no workflow or code change. The PS host itself can be a group member.
- **One-off different file type/age:** override `fileFilter` / `fileAgeDays` at run time.
- **Exclude a specific host:** `Disable-ADAccount` it or remove it from the group (see Known limitations).

## Known limitations

- **Enabled ≠ reachable.** An enabled AD computer object is processed even if the host is offline — a host named e.g. `disabledsrv01` whose account is still enabled **will** be contacted and will error if offline. To exclude a host, disable its AD account or remove it from the group; do not rely on the name.
- **No per-server status object in Orchestrator** — the run log shows aggregate stdout; per-server structured reporting is Phase 2.
- **No email report** on completion (Phase 2).
- **Partial per-server failure granularity** — if one server errors mid-move, its remaining files in that pass may be skipped (logged); other servers are unaffected.
- **Second-hop dependency** — moving to/from remote shares requires the host's auth to carry the credential (Kerberos + delegation or Basic-over-HTTPS).

## Reading results

| End state | Meaning |
|---|---|
| **Completed Successfully** | No `Error:` lines detected; all targeted moves ran (or the group had zero enabled members — logged `Warn:`) |
| **Completed with Errors** | One or more per-server failures were logged; the rest still processed. Review the run log |
| **Failed: Bad Inputs** | An input failed validation (e.g. empty `groupDN`, non-numeric `fileAgeDays`) |
| **Failed: PS Execution** | A terminating/total failure (e.g. host unreachable, AD module missing, group/domain unresolvable) |

## Troubleshooting basics

| Symptom | Likely cause / action |
|---|---|
| **Completed with Errors**, `Error: [<server>] failed moving …` | That server was unreachable or its `C$` share was inaccessible (possibly an enabled-but-offline host). Confirm it is up and the account has admin-share access. Other servers were still processed |
| No servers processed, `Warn: … zero enabled computer objects` | Group is empty, all members disabled, or `groupDN`/`domainName` wrong |
| **Failed: PS Execution**, access-denied on `\\server\C$` or `\\fileshare` | Second-hop auth not carrying the credential — check Kerberos constrained delegation, or use Basic-over-HTTPS |
| **Failed: PS Execution**, "ActiveDirectory module … not available" | RSAT AD tools missing on the PS host |
| Host add / run fails with an auth error | See the PS-Host guide (Basic vs Kerberos and the Kerberos error mapping) |
| Files not where expected | Check `fileShareTarget`; results are under `<share>\<server-short-name>\` |

For deeper diagnostics, open the workflow run → **Logs** and review the per-server `Info:`/`Warn:`/`Error:` lines emitted by the script.
