# Master Change Register — Ansible → VCF Orchestrator Transition

**Programme:** Ansible → VCF Orchestrator transition
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Scope of this document:** Every change made to the customer's existing automation
across **all** projects in the transition — the shared PowerShell toolbox, the build
tooling, and the automation processes themselves.

> **Two levels of change tracking**
>
> | Document | Location | Audience / purpose |
> |---|---|---|
> | **This master register** | `Completed/Master-Change-Register.md` | Programme-wide view: every change across every project, one consolidated history |
> | **Per-project register** | `<project>/Documentation/Change-Register.md` | Customer communication for a single project: what changed in *that* process and why |
>
> Each project's register is the detailed, customer-facing record for that delivery.
> This master register is the roll-up: it carries the same identifiers (`S-`, `T-`,
> `P-`) so a change can be traced from either direction. **When a project completes,
> its changes are folded into the tables below.**

---

## 1. Project index

| Project | Status | Package | Touches shared script? | Per-project register |
|---|---|---|---|---|
| **Snapshot Cleanup** | Completed | `com.broadcom.pso.vc.snapshotmanagement` | **No** — vCenter-native; no PowerShell host dependency | *(none — no changes to existing customer automation)* |
| **Move Windows Event Logs** | Completed | `com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove` | **Yes** — S-1 … S-5 | `Move Windows Event Logs/_Shared/Documentation/Change-Register.md` |
| **Server Reboots** | **In progress** | *(TBD)* | **Yes** — S-6 … S-13 | `InProgress/Server Reboots/Documentation/Change-Register.md` |

---

## 2. Shared PowerShell script — copy policy & promotion

`cvs_functions.ps1` is a shared toolbox called by both the retiring Ansible
playbooks and the new Orchestrator workflows. **At most two working copies exist:**

| Copy | Path | Role |
|---|---|---|
| **In-Progress (working)** | `InProgress/psscript/files/` | The copy edited while a project is in flight. All active development happens here. |
| **Completed (shipped)** | `Completed/_Shared References/psscript/files/` | What migrates to the customer environment. |

**Promotion:** when a project finishes, the In-Progress copy is copied over the
Completed copy, and the Completed copy is migrated to the customer environment.

**Exempt from the two-copy rule:** `Ansible Playbooks and Files - Sanitized/psscript/files/`
(`cvs_functions.ps1`, `cvs_functions-v2.ps1`, `cvs_report_script.ps1`) — this is the
**as-received source archive** (pre-S-1 originals), retained for reference. It is not
a working copy and must not be edited.

**Files in scope:** `cvs_functions.ps1`, `ownership_w2k.ps1`.

**Version control:** `AutomationProjects` is a git repository
(`https://github.com/forgusonjeremy/AutomationProjects`), so every path below is
tracked and prior states are recoverable — including across the folder
reorganisations, which git records as renames. Note that commits are made
periodically rather than per-change, so the recovery granularity is the last commit,
not the last edit (see §6).

> **Current deviation (2026-07-17):** the Completed copy carries S-6…S-12 for the
> in-flight Server Reboots project, because those edits were applied before this
> policy was set. It therefore does **not** currently represent the shipped state.
> This self-corrects at promotion, when the In-Progress copy overwrites it.
>
> The true pre-S-6 baseline (58,155 bytes, SHA256 `01B7DCAD…FB37`) **is recoverable**
> from commit `56f7cf8` and has been verified byte-identical:
> ```
> git show 56f7cf8:"Ansible to Orchestrator Transition/Completed/_Shared References/psscript/files/cvs_functions.ps1"
> ```

---

## 3. Consolidated `cvs_functions.ps1` changes (S-series)

| # | Date | Project | Function / Section | Change | Type |
|---|------|---------|--------------------|--------|------|
| S-1 | 2026-06-28 | Move Event Logs | `Remove-OldFiles-UNCPath` + `Delete-OldFiles-UNC-Share` | Interactive `Read-Host` replaced with non-interactive `-ReportOnly` mode | Defect (blocks non-interactive use) |
| S-2 | 2026-07-08 | Move Event Logs | `move-archived-logs-ByCN` case | Parameterised file filter/age; AD-module guard that throws; per-server `try/catch`; zero-result clean exit | Enhancement + resilience |
| S-3 | 2026-07-08 | Move Event Logs | `Move-files` | Fixed malformed catch message; added `-ErrorAction Stop` so unreachable sources log a visible `Error:` | Defect |
| S-4 | 2026-07-08 | Move Event Logs | `Get-ListOfServers-ByCN` | Group resolution terminates on failure; per-object isolation; disabled servers skipped **and logged** | Resilience |
| S-5 | 2026-07-08 | Move Event Logs | `$Action` ValidateSet, `$HostList`, `move-archived-logs-ByHostList` | Removed the orphaned action in full | Cleanup |
| **S-6** | 2026-07-17 | Server Reboots | `Get-ScriptDirectory` | `$global:PSScriptRoot` → `$PSScriptRoot` | **Defect (latent, pre-existing)** |
| **S-7** | 2026-07-17 | Server Reboots | New `Get-ListOfServers-Direct` | Direct (non-recursive) + computer-only + enabled resolution for the reboot path | Enhancement (targeting) |
| **S-8** | 2026-07-17 | Server Reboots | `Invoke-ServerReboot` case | Reboot only on `PendingReboot -eq 'True'` (was `!(… -eq 'False')`) | **Defect (safety)** |
| **S-9** | 2026-07-17 | Server Reboots | `Invoke-ServerReboot` function | Capture `shutdown.exe` output + test `$LASTEXITCODE`; return success/failure | **Defect (silent failure)** |
| **S-10** | 2026-07-17 | Server Reboots | New `Wait-ServersBackOnline` + verify params | Post-reboot verification via `LastBootUpTime`, single batch pass | New capability |
| **S-11** | 2026-07-17 | Server Reboots | New `GenerateReportServerReboot` | Per-server HTML report + optional mail for the reboot action | New capability |
| **S-12** | 2026-07-17 | Server Reboots | `Invoke-Module` | `-ErrorAction Stop` + missing `return $true` | **Defect (shared — affects all callers)** |
| **S-13** | 2026-07-17 | Server Reboots | New `-RebootIt_RunPreRebootScript`; `Invoke-ServerReboot` case | `ownership_w2k.ps1` pre-reboot step made **opt-in, default OFF** | **Security control** |

### Defects found in the customer's existing automation

These were discovered while migrating and **affect the automation as it runs today**,
independently of the Orchestrator work. They are the most important items in this
register for the customer.

| # | What was wrong | Real-world effect today |
|---|---|---|
| **S-6** | `$global:PSScriptRoot` is always `$null` (`$PSScriptRoot` is script-scoped and not published globally), so `Get-ScriptDirectory` returned an empty string | Every path built from it was rooted — `"/ownership_w2k.ps1"`, `"/$ActionRemoteFile"`. `Invoke-Command` failed non-terminating, so **the pre-reboot step in `Invoke-ServerReboot` has never run** and the server was rebooted anyway. `tls-fix` has the same exposure. |
| **S-8** | Reboot test was `!([string]$r.PendingReboot -eq "False")`, which is also true for `'Error Accessing Server'` | A server whose pending state **could not be read** (WMI/RPC failure) was treated as pending and **force-rebooted** (`shutdown /f`) regardless. |
| **S-9** | `shutdown.exe` is a native executable; a failure raises no PowerShell exception, so the surrounding `try/catch` never fired | **Failed reboots were indistinguishable from successful ones.** No error was logged and no report reflected it. |
| **S-12** | On the branch where the module isn't already listed: `-ErrorAction SilentlyContinue` swallowed import failures, **and** the success path had no `return` | `Invoke-Module` returned `$null` (falsy) on **both** success and failure, so a module that imported fine was reported as unavailable. |
| **S-1** | Interactive `Read-Host` confirmation in a non-interactive context | The `whatIf='yes'` "safe preview" either blocked or silently cancelled — the preview mode did not work. |

### S-13 — security note (requires customer decision)

`ownership_w2k.ps1` (supplied 2026-07-17) does the following on each target:

```powershell
& takeown /A /F c:\windows\inf\usbstor.inf
& takeown /A /F c:\windows\system32\termsrv.dll
& icacls c:\windows\inf\usbstor.inf /grant Users:RX
& icacls c:\windows\inf\usbstor.inf /grant Administrators:F
& icacls c:\windows\system32\termsrv.dll /grant :r administrator:F
```

- `usbstor.inf` is the **USB mass-storage driver INF**; restrictive ACLs on it are a
  standard control for blocking USB storage. Granting `Users:RX` can re-enable it.
- `termsrv.dll` is the **Terminal Services** DLL; granting full control is the
  precursor to modifying RDP behaviour.

Because of **S-6**, this step has **never actually executed**. Fixing S-6 alone would
have *silently started* applying these permission changes to every rebooted member of
the `Security-Reboot-Servers` group — a security-posture change arriving as a side
effect of a bug fix. S-13 therefore gates the step behind
`-RebootIt_RunPreRebootScript` (**default `'no'`**), so **default behaviour matches
today exactly**.

> **Recommendation:** security review before enabling. The `w2k` (Windows 2000)
> naming and the fact that it has been dormant with no apparent ill effect suggest
> it may simply be obsolete and safe to retire permanently.

---

## 4. Build tooling & setup guides (T-series)

| # | Date | Project | File(s) | Change |
|---|------|---------|---------|--------|
| T-1 | 2026-06-30 | Move Event Logs | `Configure-vROPSHost.ps1`, PS-Host build guide | PS host certificate exported as **Base-64 (PEM)** instead of DER — vRO's trusted-certificate import rejects DER |
| T-2 | 2026-07-09 | Move Event Logs | `Configure-vROPSHost.ps1` (Step 4) | WinRM **HTTPS listener** created via the WSMan provider instead of `Invoke-Expression "winrm create … @{…}"`, which PowerShell mangled so the 5986 listener was never created (and printed a false `[OK]`) |
| T-3 | 2026-07-10 | Move Event Logs | Implementation Guide, PS-Host build guide | Kerberos guidance corrected after live bring-up: multi-line `krb5.conf` `[realms]` block; `salt must be at least 128 bits` root cause = service-account name length (`REALM + sAMAccountName ≥ 16 chars`); pre-auth error 24; UPN username form; `dns_lookup_kdc = false` |

---

## 5. Automation process changes (P-series)

| # | Date | Project | Area | Change |
|---|------|---------|------|--------|
| P-1 | 2026-06-28 | Move Event Logs | Execution engine | Ansible `win_shell`/`win_copy` over WinRM → Orchestrator OOTB *Invoke a PowerShell script* against a **pre-staged** script on one PS host |
| P-2 | 2026-06-28 | Move Event Logs | Workflow count | 6 move playbooks → **1** workflow (`Move-ArchivedLogs-ByADGroup`) |
| P-3 | 2026-06-28 | Move Event Logs | LocalHost case | Removed — execution hosts are AD-group members and covered by the group workflow |
| P-4 | 2026-06-28 | Move Event Logs | AD targeting | Three near-duplicate variants → one **recursive + Enabled-only** method |
| P-5 | 2026-06-28 | Move Event Logs | Cleanup workflow | `remove-OldFiles-UNCPath` playbook → `Remove-OldFiles-UNCShare` workflow (report-only now functional) |
| P-6 | 2026-06-28 | Move Event Logs | Server iteration | Script iterates internally; one workflow run = one script invocation. **No vRO-side loop** |
| P-7 | 2026-06-28 | Move Event Logs | Variables / secrets | `vars`/`group_vars`/vault → workflow inputs; credentials via the PS host plug-in service account |
| P-8 | 2026-07-09 | Move Event Logs | Input model | Move workflow uses plain inputs with defaults set on each input (no Configuration Element) |
| **P-9** | 2026-07-17 | Server Reboots | Execution engine | `servers_reboot.yml` (stage + run over WinRM) → Orchestrator calls the pre-staged script on the PS host |
| **P-10** | 2026-07-17 | Server Reboots | Iteration & timing | **Unchanged** — script keeps AD resolution, iteration, delay and verification. Orchestrator passes inputs and classifies the transcript. Consistent with P-6 |
| **P-11** | 2026-07-17 | Server Reboots | Targeting | Resolution now direct + computer-only + enabled (S-7); operator input named `groupDN` to steer toward the DN form |
| **P-12** | 2026-07-17 | Server Reboots | Reporting | No report/mail → per-server HTML report emailed to a recipient **array** (S-11); outcome also surfaced via workflow end state |
| **P-13** | 2026-07-17 | Server Reboots | Report header label | `HeaderNotesSubstr` dropped as an input — it is only a report-header label, so it is **derived from `groupDN`** in the build action. No script change | 

**Programme net result so far:** 7 log playbooks → 2 workflows; 1 reboot playbook →
1 workflow; snapshot cleanup delivered as a vCenter-native package.

---

## 6. Cross-cutting risks & watch items

| Item | Affects | Status |
|---|---|---|
| **S-12 is a shared-code change** | Move Event Logs (delivered) + Server Reboots | `Invoke-Module` is called by `move-archived-logs-ByCN` and others. All callers are improved, but the **delivered Event Log package should be re-tested** before the updated script is migrated. |
| **`ownership_w2k.ps1` security review** | Server Reboots | Open — see §3. Default is OFF, so no action is forced. |
| **Commit granularity** | Whole repository | `AutomationProjects` **is** git-tracked (`forgusonjeremy/AutomationProjects`), and prior states — including the pre-S-6 baseline and the deleted `Completed/_shared/` folder — are recoverable; git follows the folder reorganisations as renames. However, commits are made **periodically rather than per-change**, so recovery granularity is the last commit, not the last edit. During shared-script surgery a whole editing session can sit between checkpoints. **Recommendation: commit immediately before and after a batch of `cvs_functions.ps1` changes**, so each `S-` change has a restore point. (Note: `E:\GitHub-LocalRepos` is *not* itself a repo — it is a container holding several independent repos, of which `AutomationProjects` is one.) |
| **WinRM operation timeout** | Server Reboots | The reboot run is one synchronous invocation lasting `(N × delay) + up to VerifyTimeoutSec`. The PS host's WinRM `MaxTimeoutms` / plug-in timeout must exceed the worst case. |
| **Second hop (delegation)** | Move Event Logs, Server Reboots | PS host → AD and PS host → each target. Requires Kerberos constrained delegation. See *How to Build a PowerShell Host* §6. |
| **Old `!(PendingReboot -eq 'False')` test retained** | `Get-ServerRebootReportStatus-ByCN`, `Get-ServerPendingRebootStatus` | Intentional. In those **report-only** actions the test only increments a counter for the mail subject and never triggers a reboot. Only the reboot path was corrected (S-8). |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-07-17 | Automation transition | Master register created. Consolidated the shared-script history (S-1…S-13), tooling changes (T-1…T-3) and process changes (P-1…P-12) across Snapshot Cleanup, Move Windows Event Logs and Server Reboots. Recorded the two-copy script policy and promotion workflow, the sanitized-archive exemption, the five pre-existing defects found in the customer's current automation (S-1, S-6, S-8, S-9, S-12), and the `ownership_w2k.ps1` security decision (S-13). |
| 2026-07-17 | Automation transition | **Corrected the version-control entry.** An earlier revision wrongly stated the tree had no git history — the check had been run against `E:\GitHub-LocalRepos`, which is a *container* of repos, not a repo. `AutomationProjects` is git-tracked and prior states are recoverable; the pre-S-6 baseline was retrieved from commit `56f7cf8` and verified byte-identical (58,155 bytes, SHA256 `01B7DCAD…FB37`). Risk restated as **commit granularity** (commits are periodic, not per-change) with a checkpoint recommendation for shared-script edits. |
