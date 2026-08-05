# Ansible → VCF Orchestrator Transition — Project Summaries

Slide-ready summaries for the seven deliverables. Each entry gives **what the
Orchestrator capability does** and **what was improved in the existing automation**
while transitioning it.

Deliverables 1–6 are complete. **Deliverable 7 (Service Account Expiration Reporting)
is still in progress** — code, offline test suite and the full documentation set are
complete; lab validation against real Active Directory and the workflow/package build
in vRO remain outstanding.

---

## Programme roll-up (opening slide)

| | |
|---|---|
| **Platform** | VCF Automation 9 / VCF Operations Orchestrator 9 |
| **Pattern** | Orchestrator invokes the customer's **pre-staged** `cvs_functions.ps1` toolbox on a PowerShell host via the OOTB *Invoke a PowerShell script* workflow; a shared `parseScriptOutput` action classifies the transcript into structured end states |
| **Consolidation** | **22 Ansible playbooks / job templates → 7 Orchestrator workflows**, plus one net-new vCenter-native capability |
| **Script hardening** | **24 changes** to the shared PowerShell toolbox (S-1 … S-24), including **at least 15 pre-existing defects** that affect the automation as it runs today |
| **Divergence removed** | A forked second copy of the shared toolbox (`cvs_functions-v2.ps1`) merged back and retired — one shared script again |
| **Deployment risk** | Orchestrator and Ansible use **separate PowerShell hosts in dev and production** — deploying the new solution cannot disturb any running Ansible job |

**Cross-cutting improvements that apply to every deliverable:**

- No per-run script staging — the script is pre-staged and invoked centrally (Ansible copied it to a host over WinRM on every run).
- Structured end states (*Completed* / *Completed with Errors* / *Failed*) instead of a flat job log.
- Per-run log markers (`Workflow:<name>-WorkflowRunId:<id>`) so every log line is traceable to a run.
- Failure isolation as a standard: one unreachable server no longer stops or silently invalidates the run.
- Inputs replace `vars` / `group_vars` / vault; credentials come from the PS host plug-in service account.

---

## 1. Snapshot Cleanup

**Package:** `com.broadcom.pso.vc.snapshotmanagement`
**Note for the deck:** this is the one deliverable with **no Ansible predecessor** — a
net-new, vCenter-native capability with no PowerShell host dependency.

### What the Orchestrator capability does

Automatically finds and consolidates aged VM snapshots across **every vCenter**
registered to the Orchestrator appliance, while actively protecting production storage
from the I/O impact of consolidation.

- **Discovery** — traverses the vRO inventory of each vCenter and selects snapshots by
  age, a name whitelist, and a description skip-list.
- **Safe ordering** — groups candidates by VM and uses a topological (Kahn's) sort so
  the newest/leaf snapshot is always deleted before its parent; a chain is never broken.
- **Two execution lanes** — powered-off VMs go to a fast lane; powered-on and suspended
  VMs go to a throttled lane with a per-vCenter concurrency cap.
- **Adaptive I/O governor** — before each consolidation it projects the I/O impact from
  the *observed* delta of the previous task on the same datastores, and holds the next
  task if the projection would breach the ceiling. Supports **VMFS/NFS latency**, and
  **vSAN congestion + resync queue depth** as distinct metrics. Self-calibrating: the
  fast lane inherits the throttled lane's measured deltas.
- **Run mutex** — a configuration-element lock prevents two runs overlapping; the lock
  is released on every exit path, including exceptions.
- **Dry run by default** — `dryRun` must be explicitly set to false for a live run.
- **Auditability** — a per-snapshot run log and a single human-readable
  "SNAPSHOT CLEANUP COMPLETE" summary block, ingestible by Aria Operations for Logs.

### Talking points

- Snapshot consolidation is normally either manual or unthrottled; this makes it
  scheduled *and* storage-aware.
- Storage-type awareness is real, not cosmetic — vSAN is governed on congestion and
  resync depth, not on latency.
- Safety posture: dry-run default, run mutex, per-vCenter concurrency limit, chain-order
  enforcement, per-vCenter error isolation (one unreachable vCenter does not abort the run).

---

## 2. Move Windows Event Logs

**Package:** `com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove`
**Consolidation: 7 playbooks → 2 workflows**

### What the Orchestrator capability does

Two independent workflows covering the full archive lifecycle:

| Workflow | Purpose |
|---|---|
| **Move-ArchivedLogs-ByADGroup** | Moves `Archive-*.evtx` files off every enabled member of an AD security group to a central archive share, into a per-server subfolder |
| **Remove-OldFiles-UNCShare** | Archive-share housekeeping — deletes files on a UNC share older than a retention threshold, **report-only by default** |

Domain, group DN, script path, share target, file filter and file age are all workflow
inputs. The script iterates servers internally — one workflow run is one script
invocation, with no Orchestrator-side loop.

### Enhancements to the existing automation

| Area | Before (Ansible) | After |
|---|---|---|
| **Report-only mode** | An interactive `Read-Host` confirmation blocked or silently cancelled the "safe preview" — the preview mode **did not work** (S-1) | Non-interactive `-ReportOnly`; `whatIf` defaults to report-only and functions correctly |
| **Targeting** | Three near-duplicate AD-targeting variants plus a separate "local execution" case | **One** recursive, enabled-only resolver; the PS host is treated as an ordinary group member — the special case is gone (S-2, P-3, P-4) |
| **Unreachable source** | Failure raised no visible error | `-ErrorAction Stop` plus a corrected catch message — an unreachable source now logs a visible `Error:` (S-3) |
| **Disabled members** | Handed to the move loop and errored | Skipped **and logged** (S-4) |
| **Group resolution** | Continued on failure | Terminates on failure; per-object isolation so one bad object does not poison the batch (S-4) |
| **Dead code** | An orphaned `HostList` action path | Removed in full (S-5) |
| **Parameterisation** | Hardcoded file filter and age | Both are inputs (S-2) |

### Also delivered (reusable tooling)

The **How to Build a PowerShell Host** guide and `Configure-vROPSHost.ps1`, now a
cross-project shared library. Three fixes came out of live bring-up:

- PS host certificate must be exported **Base-64 (PEM)** — vRO's trust store rejects DER (T-1).
- The WinRM **HTTPS listener** is created via the WSMan provider; the previous
  `Invoke-Expression` form was mangled by PowerShell, so the 5986 listener was never
  created — while printing a false `[OK]` (T-2).
- Kerberos guidance corrected: multi-line `krb5.conf` `[realms]` block; the
  *"salt must be at least 128 bits"* error traced to service-account **name length**
  (realm + sAMAccountName ≥ 16 chars); pre-auth error 24; UPN username form (T-3).

---

## 3. Server Reboots

**Consolidation: 1 playbook → 1 workflow.** Works for **physical and virtual** servers —
every operation is OS-level, with no hypervisor dependency.

### What the Orchestrator capability does

Reboots the Windows servers in a designated AD security group **that are actually
reporting a pending reboot** — one at a time, on a schedule — and emails an auditable
per-server report.

A server is rebooted only when **all** of the following are true:

1. It is a **direct, enabled computer member** of the target group.
2. It reports a pending reboot via Component Based Servicing, Windows Update, or the SCCM client.
3. The run is in reboot mode (which the schedule always sets).

Each reboot is then **verified back online** — the server's `LastBootUpTime` must advance
within a timeout, or it is reported as failed.

### Enhancements to the existing automation

This deliverable uncovered **four pre-existing defects** that affect the automation as it
runs today:

| # | What was wrong | Real-world effect | Fixed by |
|---|---|---|---|
| **Safety** | The pending test was `!(PendingReboot -eq 'False')`, which is **also true for `'Error Accessing Server'`** | A server whose state **could not be read** was treated as pending and **force-rebooted** (`shutdown /f`) | S-8 — reboot only on an explicit `'True'`; unreadable servers are skipped and reported |
| **Silent failure** | `shutdown.exe` is a native executable — a failure raises no PowerShell exception, so the `try/catch` never fired | **Failed reboots were indistinguishable from successful ones** | S-9 — capture output and test `$LASTEXITCODE` |
| **Latent bug** | `$global:PSScriptRoot` is always `$null`, so every derived path was rooted (`/ownership_w2k.ps1`) | The **pre-reboot step has never actually run** — and the server was rebooted anyway | S-6 |
| **Shared defect** | `Invoke-Module` swallowed import failures **and** had no `return` on success | Returned falsy on **both** success and failure — a module that imported fine was reported unavailable. **Affects every caller in the toolbox** | S-12 |

Plus new capability and hardening:

| Area | Before | After |
|---|---|---|
| **Reboot confirmation** | None — fire and forget | Verified back online via `LastBootUpTime`, else reported failed (S-10) |
| **Reporting** | The reboot action produced no report or email | Per-server HTML report (status, timing, reason) emailed to a recipient **array** (S-11, P-12) |
| **Targeting** | Unfiltered group membership | **Direct** (non-recursive), enabled, computer objects only — a nested sub-group is never silently expanded into a destructive action (S-7) |
| **Pre-reboot script** | Ran unconditionally by design | Explicit opt-in, **default OFF** (S-13) |

### Security item worth a slide

The pre-reboot script `ownership_w2k.ps1` grants `Users:RX` on the **USB mass-storage
driver INF** and full control on the **Terminal Services DLL** — both are weakenings of a
standard security control. Because of the S-6 bug it **has never executed**. Fixing S-6
alone would have *silently started* applying those permission changes to every rebooted
server — a security-posture change arriving as a side effect of a bug fix. It is
therefore gated behind an opt-in switch that **defaults to off, so behaviour matches
today exactly**, pending customer security review. The `w2k` (Windows 2000) naming
suggests it may simply be obsolete.

---

## 4. Servers Reboot Report by CN

**Workflow:** *Get Server Reboot Report*
**Consolidation: 2 playbooks → 1 workflow.** Strictly **read-only** — no reboot path
exists to misfire.

### What the Orchestrator capability does

Produces an HTML report of which Windows servers in an AD security group have a pending
reboot, with no dependency on the Ansible control node. Pending state is detected the
same way as before (CBS `RebootPending`, Windows Update `RebootRequired`, SCCM
`DetermineIfRebootPending`). The report is optionally emailed.

### Enhancements to the existing automation

| # | Area | Change |
|---|---|---|
| **R-1** | **Resolver consolidation** | Both legacy variants now use **one hardened recursive resolver**. The customer's production report used a **non-recursive, unfiltered** lookup — it silently missed servers in nested groups and emitted noise rows for users and disabled objects. Recursion is the *correct* choice here precisely because the action is read-only; the reboot workflow deliberately stays non-recursive |
| **R-2** | **Mail defect (affects every emailed report, not just this one)** | An empty CC list produced `-Cc @('')`, which throws *"Cannot validate argument on parameter 'Cc'."* — **failing every emailed report**. CC is now genuinely optional via splatting, with blank entries dropped |
| **R-5** | **Drive-fill risk on the PS host** | The result HTML was written in **append** mode and grew unbounded on every scheduled run. Now overwritten (bounded to one run) and **deleted after a confirmed successful send**; kept with a `Warn:` if the send failed or mail was off |
| **R-4** | **Input hygiene** | New build action derives the report header from the group DN (removing a redundant input), normalises recipients supplied as either an Array or a CSV string, and rejects a malformed address instead of letting vRO silently char-split a string into single characters |
| **P-1** | **Traceability** | Every log line is stamped with the workflow name and run ID |

**Risk to flag:** moving the production report onto the recursive, filtered resolver
**changes the reported set**. It is a strict improvement for a report, but group
membership should be reviewed before cutover.

---

## 5. Windows Server Clean Disks

**Workflow:** `Clean-ServerDisks-ByADGroup`
**Consolidation: 8 job templates → 1 workflow** — six SCCM cache-cleanup templates
(`c:\Windows\ccmcache`) and two user-profile templates (`c:\users`) were always the same
action with different inputs.

### What the Orchestrator capability does

Frees disk space on the Windows servers in an AD security group by deleting aged files
(and optionally folders) from one or more target directories, reached over the
`\\server\C$` admin share from a single PS host. **Defaults to a safe report-only
preview** and deletes only when explicitly told to.

An item is deleted only when **all** of the following are true:

1. Its server is a **direct, enabled computer member** of the target group.
2. Its last-modified time is **older than** the chosen `olderThanDays` threshold.
3. It is not on the intentional-preservation list (the hardcoded `vmware-vmsvc-SYSTEM.log`
   exclusion; hidden/system files; read-only files when `forceEnable` is off).
4. The run is a **live** run — the default is report-only.

The workflow **empties** target folders; it never deletes the target folder itself.

### Enhancements to the existing automation

| Area | Before (Ansible) | After |
|---|---|---|
| **Safety preview** | None — the action **always deleted** | `whatIf` report-only mode is the **default**; lists every item that *would* be deleted and deletes nothing. An invalid value fails safe (no action). The build action logs a loud warning on any live run |
| **Silent failures** | An unreachable server / inaccessible admin share raised a **non-terminating** error on the PS error stream the workflow never sees — **the run looked clean**. Its catch line was also malformed and never expanded the exception | Terminating, logged `Error:` with server and path context; the per-server loop continues; the run ends *Completed with Errors* (S-15) |
| **Targeting** | Unfiltered, returning users and disabled computer objects that then errored one by one | Direct, enabled, **computer** objects only — disabled skipped and logged (S-14) |
| **Age input** | A negative value (`-1`) fed to `AddDays()` | Intuitive **positive** `olderThanDays` |
| **File filter** | Free-text and easy to misuse | Fixed to `*.*` so folder deletion behaves as expected |
| **Failure isolation** | One failure could stop the run | Per-server **and per-item** isolation; a child already removed by a parent's recursive delete is not counted as a failure |
| **Code duplication** | Four near-identical delete branches | Collapsed into **one** candidate-selection pipeline shared by both the report and delete paths, so preview and live run can never diverge |
| **Guards** | None | Module guard that throws; zero-result guard that exits cleanly rather than looking like success |

**Design note worth stating:** the resolver here is deliberately **non-recursive**, unlike
the read-only report. Deleting files is destructive, so only what an operator placed
*directly* in the group is a target — a nested sub-group is never silently expanded into
scope. This also preserves the original Ansible behaviour.

---

## 6. Admin Accounts Report

**Workflow:** `Get-AdminAccountsReport`
**Consolidation: 3 job templates → 1 workflow.** Strictly **read-only** — `Get-ADUser`
queries and an email; it cannot create, modify, disable or delete any directory object.

### What the Orchestrator capability does

Reports which privileged ("admin") accounts **do not require a smart card to log on** —
i.e. which privileged accounts sit outside PKI enforcement — across every domain and OU
in a supplied scope, and emails a management-readable HTML report with the compliant /
non-compliant counts in the subject line.

The operator supplies a **flat list of OU distinguishedNames**; the **domain is derived
from each DN's own `DC=` components**. Single-domain versus multi-domain is no longer a
mode the operator selects or a template they must pick between — it falls out of the DNs
supplied.

### Enhancements to the existing automation

**This deliverable began with a merge.** The multi-domain capability the customer actually
runs existed **only in a forked copy** of the shared toolbox (`cvs_functions-v2.ps1`),
which predated every resilience change made during this transition. The fork's capability
was merged into the hardened mainline and the fork retired — one shared script again.

**Pre-existing defects found during the merge**, all of which produce the *same* failure
mode — an under-reported or empty compliance report that **looks successful**:

| What was wrong | Effect |
|---|---|
| **Silent partial sweeps** — `Get-ADUser` had no `-ErrorAction Stop` and no `try`/`catch` | A bad OU DN, an unreachable DC or a broken trust raised a **non-terminating** error the workflow never saw. A partial sweep was reported as a clean run — **and the missing accounts read as compliant** |
| **Inline scope silently ignored** | Passing the OU map inline left it unset; the sweep iterated nothing and the run **emailed an empty compliance report and reported success** |
| **Unhandled malformed JSON** | A bad scope map produced a parser error on the invisible error stream and the run continued with a null map |
| **Hashtable fallback corrupted the footnote** | The empty case rendered .NET members (`Keys`, `Values`, `Count`) as though they were domain names |
| **`Write-Host "DEBUG:"`** | Bypassed the logger entirely — reached neither the log file nor any prefix the workflow recognises |

**Improvements delivered:**

| Area | Before | After |
|---|---|---|
| **Failure visibility** | Failures visible only in the Ansible console; a failed OU produces no rows, which **reads exactly like a compliant OU** | Failures rendered **on the report itself** — leading banner, per-OU `NOT READ` flag, and an **`[INCOMPLETE]` subject-line prefix**. The people who act on this report read the email, not the transcript |
| **Failures explained** | Raw exception text | Each failure **classified** — *Scope error / Access denied / Authentication / Unreachable / Unclassified* — with per-category remediation guidance and a category breakdown in the banner. A **referral means the server answered** and said the naming context is not its own: a deterministic targeting fault fixed by correcting the OU list. "Not operational" is an availability fault that may clear itself. **Retrying helps the second and never the first** |
| **Report audience** | One flat table merging all domains; the reader had to infer a row's domain from its UPN suffix | Executive summary → per-domain sections with a plain-language status → per-OU sub-sections. Answers *"which domain and OU are worst?"* without reading the whole table. Sections are driven by the **scope map, not the returned data**, so an OU that returned nothing still gets a heading saying so |
| **Count accuracy** | AD searches are **fully recursive** (`SearchScope Subtree`), so an OU list containing both a parent **and** a descendant returned the deeper accounts **twice** — inflating the figures | Accounts de-duplicated to one entry, kept under the deepest OU that returned it, **before the counts are taken**, so the subject line and body cannot disagree. The recursive query itself is deliberately unchanged — correcting the *outcome* is safe, narrowing the *query* against a directory we cannot inspect is not |
| **Data quality** | Booleans rendered ambiguously | Account state column added, values projected to text before rendering, all styling inlined for reliable Outlook rendering |
| **Disk growth** | The result HTML was **appended** to, growing without bound across scheduled runs | Overwritten each run |
| **Failure contract** | Everything looked like success | Deliberate asymmetry: a **scope** problem fails the run outright (nothing can be trusted); a **per-OU** problem completes with errors and still delivers a report that says which OUs are missing |

### Assurance — worth its own slide

**191 automated checks run entirely offline** — no Active Directory, SMTP, PowerShell host
or Orchestrator appliance required. They cover the invocation building, the
JavaScript→PowerShell escaping boundary, the report rendering, and the workflow's own
scriptable-task code. They load the functions under test **out of the live files**, so
they cannot drift from shipping code.

This is not decorative: the suite caught **two silent-content defects before delivery** —
both the same class of fault the deliverable exists to eliminate, where a non-terminating
error removes content while the run still reports success. In one, **every styled table
evaluated to nothing**: the report still sent and still looked well-formed, having quietly
lost its content.

### Open items requiring customer decision

- **Report wording** — "Not enforced" is placeholder text; adopt the customer's
  established compliance language if one exists. Labels only, no logic change.
- **Service-account exemptions** — there is no allow-list, so a service account
  legitimately exempt from smart-card enforcement is reported as non-compliant on every
  run. Expect a persistent non-compliance floor until resolved.
- **Expect the first run to show *lower* counts** than the Ansible report if the OU list
  overlaps. That is the de-duplication correcting an inflated figure — not a regression.
  Explain it to recipients before cutover.

---

## 7. Service Account Expiration Reporting  *(in progress)*

**Workflow:** `Get-ServiceAccountExpirationReport`
**Consolidation: 1 job template → 1 workflow.** Strictly **read-only** — it reports on
accounts, it never renews, extends, disables or deletes one.
**Status:** code, offline test suite and the full customer documentation set are complete.
Outstanding: lab validation against real Active Directory, workflow build in vRO, and the
`.package` export.

### What the Orchestrator capability does

Reports **which service accounts have expired, and which expire within a configurable
look-ahead window**, across every OU in a supplied scope — so accounts are renewed before
the services depending on them stop working.

The emailed HTML report leads with an **Action required** block — expired and expiring
accounts across all domains, soonest first — above the full inventory, and carries the
expired / expiring counts in the subject line. A scheduled report can therefore be triaged
from the inbox without opening it.

As with the Admin Accounts Report, the operator supplies a **flat list of OU
distinguishedNames** and the domain is derived from each DN's own `DC=` components.
Today's production scope is a single OU — a list of one row — but adding OUs or whole
domains later needs no change to the workflow.

**New capability: the look-ahead window** (`expiringWithinDays`, default 30). Precisely
what it does *not* do is worth stating: it does **not filter the report** (the full
inventory is always present) and it does **not affect expired accounts** (anything past
its date is reported regardless). It rounds toward warning early — warning one scheduled
run *late* is the failure mode that matters. A bad value degrades to 30 with a warning
rather than costing the customer the report.

### The headline for this deliverable

**This is not a like-for-like port.** Four defects were found, all silent — every run
reported success — and **three of them mean the report the customer receives today is not
the report they believe they are receiving**.

| # | Defect | Consequence |
|---|---|---|
| **1** | **Silent scope narrowing.** The action omitted a parameter; because that parameter is typed `[bool]`, an omitted argument **binds to `$false`** rather than staying null, making the intended "return everything" branch beneath it **unreachable dead code**. Every run actually queried only accounts *not* requiring a smart card | **Any service account requiring a smart card has been missing from every report ever produced.** Nothing in the output indicated a filter had been applied |
| **2** | **The expiration date was queried but never rendered.** It was selected, then omitted from the column list; the line immediately below that renamed the column had nothing to match | A report titled *"Service Account Expiration"* that showed **password age and no expiry date** — the one fact it exists to convey was absent |
| **3** | **A password that had never been set was reported as an age of `0`.** The two password columns also used different time bases, disagreeing by the host's UTC offset | The accounts **most** in need of attention rendered identically to the healthiest ones — and sorted to the **bottom** of a report ordered by age descending |
| **4** | An unassigned variable was appended to the result set — copy-paste residue from the admin-accounts action | A blank row on every report |

Alongside these, the action carried the same resilience gaps closed elsewhere in the
programme: no error handling around the AD query (an empty report emailed as a success);
an AD-module guard that logged an error and **fell through**, sending nothing; an
**appending** report file that grew without bound; and a log line that wrote the **entire
HTML body** to the very stream the workflow classifies on, burying the `Error:` and
`Warn:` lines the run is judged by.

### Enhancements delivered

| Area | Before | After |
|---|---|---|
| **The report reports expiration** | No expiry date at all — password age only | `Expires on` and `Days to expiry` columns, and each account classified **Expired / Expiring / Active / Never expires** (handling AD's 1601 and 9999 "never" sentinels) |
| **Complete scope** | Smart-card-requiring accounts silently excluded | Every account in scope returned. The fix is structural — the replacement sweep declares the parameter untyped with a null default, so omitting it *genuinely* means "no filter" |
| **Actionable at a glance** | One flat table sorted by password age, no counts, no indication of failure | Action-required block above the inventory, executive summary tiles, per-domain status, per-OU sub-sections, counts in the subject line |
| **A trustworthy empty report** | "Nothing is expiring" and "the query never ran" looked **identical** | Distinguishable — an empty report carries its scope footnote and the run says so |
| **Password-hygiene signal** | "Never set" reported as an age of zero, at the bottom | Reads **"Never set"**, coloured, sorted to the **top** of its group |
| **Failure visibility** | Visible only in the Ansible console | Rendered **on the report** — banner, per-OU `NOT READ` flag, `[INCOMPLETE]` subject prefix — with the same *Scope error / Access denied / Authentication / Unreachable* classification and remediation guidance as the Admin Accounts Report |
| **Failure contract** | Everything looked like success | A **scope** problem fails the run outright; a **per-OU** problem completes with errors and still delivers a report saying which OUs are missing |
| **Operational hygiene** | Report file appended to indefinitely; multi-kilobyte HTML blob written to stdout | Overwritten each run; a one-line log summary instead |
| **Scales without rework** | One domain, one OU, hardcoded into the template | A DN list — today's single OU is a list of one |

### Consistency point worth making in the deck

This deliverable **reuses the shared functions built for the Admin Accounts Report**
(scope resolution, the multi-domain failure-isolated sweep, de-duplication, failure
classification, HTML formatting). The two reports look and behave like one product rather
than two separately-written scripts — and the second deliverable was substantially cheaper
than the first because of it.

### Assurance

**256 automated checks run entirely offline** — no AD, SMTP, PowerShell host or vRO
appliance required — covering the invocation building, the JavaScript→PowerShell escaping
boundary, the expiry classification, the report rendering and the workflow's own
scriptable-task code. Four rendered sample reports (clean / duplicates / incomplete / no
findings) are available for customer review without a lab.

**Twenty-one of those checks assert against the shipping source rather than behaviour** —
a deliberate choice worth explaining: reintroducing defect 1 would silently narrow the
report again, and **every behavioural test would still pass**, because none of them
supplies the input that would expose it. Some regressions are invisible to behavioural
testing, and this is one.

### Actions required before the first scheduled send

- **Brief recipients that the account count will RISE**, possibly substantially. That is
  defect 1 being corrected — previously invisible accounts becoming visible — **not** a
  scope expansion or a directory change. This is the single most important cutover message.
- **Review inbox rules.** The subject now carries counts and an `[INCOMPLETE]` prefix on
  degraded runs; any rule matching the old subject exactly will stop matching.
- **Match the window to the schedule.** A window shorter than the schedule interval lets
  an account expire in the gap having never appeared as Expiring.

### Open items requiring customer decision

- **Password expiry vs password age** — the report shows how *old* a password is, not when
  it expires. True expiry means reading the domain's maximum password age (and any
  Fine-Grained Password Policy) and honouring `PasswordNeverExpires`. A more useful metric,
  and a new query per domain. **Not implemented** — read the column as a hygiene signal.
- **Expected-expiry exemptions** — an account deliberately time-boxed (a contractor
  integration, a migration account) is reported as Expiring on every run until it does.
  No allow-list exists.
- **Is the OU list complete?** — the report finds *user objects in the OUs supplied*, not
  "service accounts". If service accounts live elsewhere in the directory they are
  invisible to it.

---

## Suggested closing slide — the pattern behind the findings

Across all seven deliverables, the defects found in the existing automation share **one
failure mode**, and it is the strongest message in the deck:

> **A non-terminating error, an omitted parameter or a missing column removes content or
> skips work — and the run still reports success.**

- A pending-reboot state that could not be read looked like "pending" → the server was force-rebooted.
- A failed `shutdown.exe` looked like a successful reboot.
- An unreachable server during disk cleanup looked like a clean run.
- An unreadable OU in the compliance report looked like a compliant OU.
- An omitted parameter silently excluded every smart-card account from the service-account report.
- A report titled "Service Account Expiration" never rendered an expiration date.
- An empty CC list quietly failed **every** emailed report.
- A module that imported fine was reported unavailable.
- A "safe preview" mode that silently did nothing.

Every one of these is now **visible** — as an `Error:` line the workflow can classify, a
structured end state, a flag on the emailed report, or a run that fails outright and says
what was missing.

**And the corollary, which is the real argument for the test suites:** several of these
defects are invisible to behavioural testing. A report that quietly omits a category of
account passes every test that never asks for that category. That is why the later
deliverables assert against the shipping source, not just the output.
