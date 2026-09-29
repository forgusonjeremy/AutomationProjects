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
| **Snapshot Cleanup** | Completed | `com.broadcom.pso.vm.snapshot.cleanup` | **No** — vCenter-native; no PowerShell host dependency | *(none — no changes to existing customer automation)* |
| **Move Windows Event Logs** | Completed | `com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove` | **Yes** — S-1 … S-5 / P-1 … P-8 | `Move Windows Event Logs/_Shared/Documentation/Change-Register.md` |
| **Server Reboots** | Completed | `com.broadcom.pso.servers.windows.reboots` | **Yes** — S-6 … S-13 / P-9 … P-13 | `Server Reboots/Documentation/Change-Register.md` |
| **Windows Server Clean Disks** | Completed | `com.broadcom.pso.servers.windows.serverDiskClean` | **Yes** — S-14 … S-15 / P-14 … P-19 | `Windows Server Clean Disks/Documentation/Change-Register.md` |
| **Admin Accounts Report** | Completed | `com.broadcom.pso.identity.activedirectory.reporting` | **Yes** — S-16 … S-21 / P-20 … P-26 | `Admin Accounts Report/Documentation/Change-Register.md` |
| **Service Account Expiration Reporting** | Completed | `com.broadcom.pso.identity.activedirectory.reporting` | **Yes** — S-22 … S-24 / P-27 … P-32 | `Service Account Expiration Reporting/Documentation/Change-Register.md` |
| **Servers Reboot Report by CN** | Completed | `com.broadcom.pso.servers.windows.reboots.reporting` | **No** — the ByCN action already existed | `Servers Reboot Report by CN/Documentation/Change-Register.md` *(local `R-` numbering)* |
| **Datastore Capacity Reporting** | **In progress** | `com.broadcom.pso.vc.storage.reporting` | **No** — vCenter-native; no PowerShell host dependency | `InProgress/Get Datastores Greater than 75 Percent Used/Documentation/Change-Register.md` |

> **Two projects have now been delivered vCenter-native** — Snapshot Cleanup and
> Datastore Capacity Reporting. Neither touches `cvs_functions.ps1`, neither needs a
> PowerShell host, and neither creates re-test exposure for the Active Directory
> packages. Where a process reads or acts on vCenter rather than on Windows guests,
> this is the cheaper and lower-risk end state.

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
| *P-14 … P-32* | 2026-07 – 2026-08 | Clean Disks, Admin Accounts, Service Account Expiry | *(various)* | **Not yet folded into this table** — see the consolidation backlog note below. Recorded in full in each project's own register |
| **P-33** | 2026-08-10 | Datastore Reporting | Execution engine & targeting | `get_datastores_75_100_used.yml` (stage + run PowerCLI over WinRM) → **vCenter-plug-in-native** workflow. **No PowerShell host, no PowerCLI, no WinRM, no separate vCenter credential.** The hardcoded five-vCenter string is replaced by the vCenters registered in Orchestrator | Architecture |
| **P-34** | 2026-08-10 | Datastore Reporting | Banding | Half-open, gapless bands `[floor, ceiling)`. Replaces `-gt` / `-lt x.99` comparisons that left four exact values and two ranges reported **nowhere** | **Defect (silent omission)** |
| **P-35** | 2026-08-10 | Datastore Reporting | Resilience | Per-**vCenter** `try`/`catch`, **zero-capacity guard**, per-**datastore** `try`/`catch`. Previously either fault ended the whole run and emailed nothing | **Defect (total failure)** |
| **P-36** | 2026-08-10 | Datastore Reporting | Report scope | The `uncommitted > freeSpace` **AND removed from collection**; carried as an `Overcommitted` **column** instead. A datastore at 99% used with low uncommitted growth was previously never reported | **Defect (silent omission)** |
| **P-37** | 2026-08-10 | Datastore Reporting | De-duplication | `Sort-Object -Property Datastore -Unique` removed. Row identity is **vCenter + MoRef**, never the display name | **Defect (silent omission)** |
| **P-38** | 2026-08-10 | Datastore Reporting | Incomplete scans | vCenters that could not be scanned are rendered **into the report body**, not only the run log. Same reasoning as S-16 | Enhancement (trust) |
| **P-39** | 2026-08-10 | Datastore Reporting | Presentation | Stylesheet applied (this action had none); Datacenter / Datastore Cluster / Type / Overcommitted columns added; deterministic worst-first ordering | Enhancement |
| **P-40** | 2026-08-10 | Datastore Reporting | Mail subject | Carries **all three** band counts, not the top band alone, and appends `INCOMPLETE (n vCenter(s) unreachable)` | **Defect (misleading)** |
| **P-41** | 2026-08-10 | Datastore Reporting | Outcome & recovery | `COMPLETE` / `CLEAN_NO_FINDINGS` / `COMPLETE_WITH_GAPS` / `ERROR` instead of pass-fail. Delivery failure **fails the run**; the exception handler writes the built report into the transcript so a late failure does not discard the estate sweep | Enhancement (operability) |
| **P-42** | 2026-08-10 | Datastore Reporting | Inputs & secrets | `vars.txt` → workflow inputs; recipients as **arrays** (consistent with P-12); blank Cc entries stripped; SMTP credentials as `SecureString`, unset by default. No configuration elements | Enhancement |
| **P-43** | 2026-08-10 | Datastore Reporting | Report artefact | The unbounded **appending** `debug\result.html` on the Windows host → `reportHtml` workflow output, produced on every run | Hygiene |
| **P-44** | 2026-08-13 | Datastore Reporting | Transport security | The newer `cvs_50_100.ps1` runs `Set-PowerCLIConfiguration -InvalidCertificateAction Ignore`, so **vCenter certificate validation is disabled** on the connection carrying the service-account credential. The Orchestrator vCenter plug-in validates against its trusted-certificate store — the session is authenticated *and* verified, with no configuration needed | **Security control** |

**Programme net result so far:** 7 log playbooks → 2 workflows; 1 reboot playbook →
1 workflow; 1 reboot-report playbook set → 1 workflow; 1 disk-clean playbook →
1 workflow; 2 account-report playbooks → 2 workflows; and **two vCenter-native
packages** — snapshot cleanup and datastore capacity reporting — delivered with no
PowerShell host in the path at all.

> **Consolidation backlog.** Sections 3 and 5 carry S-1 … S-13 and P-1 … P-13 in
> full. **S-14 … S-24 and P-14 … P-32 have not yet been folded in** from the Clean
> Disks, Admin Accounts and Service Account Expiration registers, which remain the
> authoritative record for those changes. The Datastore Reporting entries above are
> complete because that project adds no `S-` changes at all. Folding in the
> outstanding middle range is a documentation task in its own right and should be
> scheduled before this register is presented as the programme-wide history.

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
| **`get_datastores_75_100_used` defects stay live until the playbook is retired** | Datastore Reporting | **Open — accepted.** That deliverable is vCenter-native and deliberately does **not** fix the shared script, because the script is being taken out of the path entirely. For as long as both run in parallel the Ansible report retains all six defects in its register §1A. Keep the overlap short, and do not treat the Ansible report as the reference during comparison. |
| **The datastore report will get materially longer at cutover** | Datastore Reporting | **Action required before go-live.** P-34, P-36 and P-37 each restore rows that were previously invisible. Recipients must be briefed, or a four-fold rise in row count reads as a sudden deterioration in the estate. |
| **Two ambiguous configuration values in the datastore script** | Datastore Reporting | Customer decision. `$high = 90` carries a comment saying it should be 95; the process is named for 75% but the floor is 70%. Both preserved as-is and exposed as workflow inputs. |
| **Register consolidation backlog** | Whole programme | S-14 … S-24 and P-14 … P-32 are recorded only in their per-project registers, not yet in §3/§5 here. See the note at the end of §5. |
| **`GitLab-Repos-Sanitized` supersedes the earlier hand-off** | Whole programme | A newer sanitized export of the customer's GitLab appeared on 2026-08-13 and is **confirmed newer** than the copies this programme has been working from. For the datastore report it contains an entirely different script (`cvs_50_100.ps1`, standalone) plus several reports this programme has never seen — `cvs_certificate_expiry`, `cvs_cluster_failover_capacity`, `cvs_daily_alarm_event_rollup`, `cvs_orphaned_vmdks`, `cvs_idle_oversized_vms`, `cvs_long_powered_off_vms`, `cvs_aged_oversized_snapshots`, `cvs_vmware_rightsizing`, `vi_healthcheck`. **Every remaining project should re-baseline against this export before its register is written** — the datastore deliverable had to withdraw two defect claims that had already been fixed. Which generation is *deployed* remains unconfirmed in each case. |
| **Build-vs-buy not yet asked on the analytics reports** | Datastore Reporting, and likely others | The datastore fill projection, cluster failover capacity, idle/oversized VM and rightsizing reports are all **native VCF Operations capabilities**. The recommendation for the datastore projection is to let Operations own it rather than rebuild it in Orchestrator (`06_Platform_Options_Advisory.md`). The same question should be asked of the others **before** they are scheduled as transition work. |

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-07-17 | Automation transition | Master register created. Consolidated the shared-script history (S-1…S-13), tooling changes (T-1…T-3) and process changes (P-1…P-12) across Snapshot Cleanup, Move Windows Event Logs and Server Reboots. Recorded the two-copy script policy and promotion workflow, the sanitized-archive exemption, the five pre-existing defects found in the customer's current automation (S-1, S-6, S-8, S-9, S-12), and the `ownership_w2k.ps1` security decision (S-13). |
| 2026-08-13 | Automation transition | **Re-baselined Datastore Capacity Reporting against the newer `GitLab-Repos-Sanitized` export.** Added **P-44** (vCenter certificate validation). Withdrew two defect claims already fixed in the newer `cvs_50_100.ps1`, and narrowed a third. Added two programme-wide watch items: every remaining project should re-baseline against the newer export before its register is written, and the build-vs-buy question should be asked of the analytics reports before they are scheduled as transition work. |
| 2026-08-10 | Automation transition | **Datastore Capacity Reporting folded in.** Added **P-33 … P-43**; the project adds **no `S-` changes** — it is the second vCenter-native delivery after Snapshot Cleanup and does not touch `cvs_functions.ps1`. Brought the §1 project index up to date, which had been stale since Server Reboots: added Clean Disks, Admin Accounts, Service Account Expiration and Reboot Report by CN with their packages and `S-`/`P-` ranges, and corrected the Snapshot Cleanup package name to `com.broadcom.pso.vm.snapshot.cleanup`. Recorded the **consolidation backlog** — S-14 … S-24 and P-14 … P-32 are still only in their per-project registers — and four new watch items. |
| 2026-07-17 | Automation transition | **Corrected the version-control entry.** An earlier revision wrongly stated the tree had no git history — the check had been run against `E:\GitHub-LocalRepos`, which is a *container* of repos, not a repo. `AutomationProjects` is git-tracked and prior states are recoverable; the pre-S-6 baseline was retrieved from commit `56f7cf8` and verified byte-identical (58,155 bytes, SHA256 `01B7DCAD…FB37`). Risk restated as **commit granularity** (commits are periodic, not per-change) with a checkpoint recommendation for shared-script edits. |
