# Change Register — Datastore Capacity Reporting

**Project:** Ansible → VCF Orchestrator transition — "Get Datastores Greater than 75 Percent Used"
**Platform:** VCF Automation 9 / VCF Operations Orchestrator 9
**Purpose of this document:** A single, customer-facing record of *how the datastore
capacity report works today* and *every change* made to it during the Orchestrator
transition — what changed, and **why**.

> **Continues the shared `S-` / `P-` numbering.** Changes **S-1 … S-5** / **P-1 … P-8**
> were made by **Move Windows Event Logs**, **S-6 … S-13** / **P-9 … P-13** by
> **Server Reboots**, **S-14 … S-15** / **P-14 … P-19** by **Windows Server Clean
> Disks**, **S-16 … S-21** / **P-20 … P-26** by the **Admin Accounts Report**, and
> **S-22 … S-24** / **P-27 … P-32** by **Service Account Expiration Reporting**. This
> deliverable adds process changes **P-33 … P-43**.
>
> **NO `S-` CHANGES. `cvs_functions.ps1` IS NOT TOUCHED BY THIS DELIVERABLE.**
> This is the second project in the programme — after Snapshot Cleanup — to be
> delivered **vCenter-native**, with no PowerShell host in the execution path at all.
> There is therefore no shared-script edit to promote, no re-test exposure for the
> already-delivered Active Directory packages, and no sequencing dependency on the
> `cvs_functions.ps1` promotion.
>
> **Current-state baseline:** `InProgress/Get Datastores Greater than 75 Percent Used/get_datastores_75_100_used.yml` + `vars.txt`
> **Reference copy of the retiring logic:** `InProgress/psscript/files/cvs_functions.ps1`, case `get_datastores_75_100_used` (lines 3067–3142). Read-only for this project.

---

## 1. Current state — how the customer does it today

**Goal of the automation (unchanged):** tell the storage and infrastructure teams
which datastores across the estate are close to full, early enough to act, and
email that list on a schedule.

**How it runs today (Ansible):**

- `get_datastores_75_100_used.yml` creates a temp directory on a Windows host over
  WinRM (5986), `win_copy`s the `ps_scripts` folder onto it, runs
  `cvs_functions.ps1 -Action Get_Datastores_75_100_Used …`, lists the staged folder,
  then deletes the temp directory.
- The playbook is only a **delivery shell**. All real work happens in the script, on
  that one Windows host, using PowerCLI.
- Production scope (`vars.txt`): **five vCenters**, hardcoded as a comma-separated
  string — `vc01`, `vcb01`, `vcb02`, `vc`, `vc02`, all `.corp.local`.
- The script (`get_datastores_75_100_used` case, as received):
  1. Sets `$high = 90`, and derives `$med = 80`, `$low = 70`, `$med_limit = 89.99`,
     `$low_limit = 79.99`.
  2. Imports `VMware.VimAutomation.Core`, then for each vCenter in the list:
     `Connect-VIServer -ErrorAction Stop`, `Get-View -ViewType DataStore`, computes
     percent used and percent free, and **collects the datastore only if percent used
     is above 70 AND uncommitted space exceeds free space**.
  3. Splits the collected rows into three bands, pipes each through
     `Sort-Object -Property Datastore -Unique`, and renders each with
     `ConvertTo-Html -Fragment`.
  4. Sets the mail subject to `"<prefix> | <n> Datastores @ 90%"` — the count of the
     **top band only**.
  5. Appends the body to `Debug\result.html` and emails it via `Send-MailMessage`.

### 1A. Six pre-existing defects — all of them silent

Every one of these produced a report that looked correct, or a run that produced
nothing at all with no indication why. They are recorded in full because **four of
them mean the report the customer has been receiving is not the report they believe
they have been receiving.**

| # | Defect | Effect today |
|---|---|---|
| 1 | **The overcommit AND.** Collection required `($percentUsed -gt $dsPercentUsed) -and ($ds.summary.uncommitted -gt $ds.summary.freespace)`. Both conditions had to hold. | **A datastore at 99% used is not reported unless it is also overcommitted.** A thick-provisioned or steadily-grown volume that is nearly full — the single most urgent case a capacity report exists to catch — has never appeared on it. The report heading says "Less Free Space than Uncommitted will be counted", so the behaviour is intentional; the consequence appears not to be. |
| 2 | **No exception handling around `Connect-VIServer`.** The connect call carries `-ErrorAction Stop` and sits in the `foreach` loop with no `try`/`catch` anywhere in the case. | **One unreachable vCenter out of five ends the entire run and no report is emailed at all.** The failure is total and invisible to the recipients, who simply receive nothing — indistinguishable from a healthy estate or a missed schedule. |
| 3 | **No divide-by-zero guard.** `(($ds.summary.capacity - $ds.summary.freespace) / $ds.summary.capacity)` runs against every datastore returned by `Get-View`, including inaccessible, unmounted or partially removed ones, which report `capacity = 0`. | A terminating "Attempted to divide by zero" error kills the run mid-inventory. Same outcome as defect 2: **no report at all**, from a single decommissioned volume anywhere in the estate. |
| 4 | **`Sort-Object -Property Datastore -Unique`** de-duplicates on the datastore **name**, across the merged results of all five vCenters. | **A datastore whose name already appeared on another vCenter is silently discarded.** Datastore naming conventions are normally per-site, so collisions across a five-vCenter estate are the norm rather than the exception. The surviving row is whichever sorted first — the discarded one may be the fuller of the two. |
| 5 | **Gaps between the bands.** `high: -gt 90`; `med: -gt 80 -and -lt 89.99`; `low: -gt 70 -and -lt 79.99`. The comparisons are strict and the limits are `-0.01` below the next floor. | A datastore at **exactly 90.00%**, **exactly 89.99%**, **exactly 80.00%** or **exactly 70.00%** matches **no band and is shown nowhere**, despite having been collected. Values between 89.99 and 90.00, and between 79.99 and 80.00, fall in the same holes. |
| 6 | **The mail subject counts the top band only** — `"$alert_high_cnt Datastores @ $high%"`. | A subject reading **"0 Datastores @ 90%"** is sent while fifty datastores sit at 89%. The subject line is the only part of the report most recipients read on a phone. |

Alongside those, the action carries the resilience and hygiene gaps this transition has
been closing across the programme: the report body is **appended** to
`Debug\result.html` on every run, so that file grows without bound; no stylesheet is
applied to this action's output, unlike the `VMware_Disable_SSH` action in the same
script, which builds one; and there is no `try`/`catch` isolating a single unreadable
datastore from the rest of the sweep.

### 1B. Two configuration observations for the customer

Neither is a defect. Both are worth a decision.

1. **`$high = 90`, with a comment saying it should be 95.** The line reads
   `$high = 90 # … value should be 95 (don't go below 20)`. The code and the comment
   disagree. The transition preserves the **behaviour** (90), and exposes it as the
   `thresholdHighPct` input so the decision can be made and changed without a code
   edit. Confirm which value is intended.
2. **The process is named for 75%, but the floor is 70%.** The job template, the
   playbook filename and this project folder all say "75 Percent Used"; the script
   collects everything above `$low`, which is 70. The transition preserves 70 as the
   default reporting floor. Confirm whether 70 or 75 is intended.

### 1C. No shared PowerShell host, no shared script

Unlike the Active Directory deliverables in this programme, this transition removes
the PowerShell host from the path entirely rather than re-pointing it. There is
consequently **no** deployment sequencing dependency, **no** re-test exposure for the
Event Log, Reboot, Clean Disks or Accounts packages, and **no** promotion of
`cvs_functions.ps1` triggered by this project. The `get_datastores_75_100_used` case
is left in the shared script untouched and simply stops being called once the Ansible
job template is retired.

---

## 2. Target state — how it works after the transition

A single Orchestrator workflow, **Get Datastore Capacity Report**, in package
`com.broadcom.pso.vc.storage.reporting`. It reads `DatastoreSummary` from every
registered vCenter through the vCenter plug-in, bands the results, renders an HTML
report and emails it through the Mail plug-in.

**The entire execution chain below the playbook disappears:**

| Retired | Replaced by |
|---|---|
| WinRM 5986 session to a Windows host | vCenter plug-in SDK connection |
| `win_tempfile` / `win_copy` staging of `cvs_functions.ps1` | *(nothing — no code is staged anywhere)* |
| PowerCLI `VMware.VimAutomation.Core` on that host | `VcPlugin` / `VcSdkConnection` |
| A `Connect-VIServer` credential per vCenter | the vCenter endpoint credential already registered in Orchestrator |
| `Send-MailMessage` on the Windows host | Orchestrator Mail plug-in (`EmailMessage`) |
| `var_vCenterList` — a hardcoded hostname string | `VcPlugin.allSdkConnections` |
| `Debug\result.html` on the Windows host | `reportHtml` workflow output |

**What that buys the customer, stated plainly:** no Windows host in the path of this
report; no PowerCLI version to keep current on it; no second set of vCenter
credentials stored outside Orchestrator; no Kerberos second-hop requirement; and no
vCenter list to edit when a vCenter is commissioned or retired — an unlisted vCenter
becomes impossible rather than merely unlikely.

**Read-only.** The workflow issues no write of any kind against vCenter. It reads
`DatastoreSummary` and nothing else. There is therefore no `whatIf` safety gate, for
the same reason the Service Account Expiration report has none: there is nothing to
gate.

---

## 3. Process changes (P-series)

| # | Date | Area | Change | Type |
|---|------|------|--------|------|
| **P-33** | 2026-08-10 | Execution engine & targeting | `get_datastores_75_100_used.yml` (stage + run PowerCLI over WinRM) → a vCenter-plug-in-native Orchestrator workflow. The hardcoded five-vCenter string is replaced by the vCenters registered in Orchestrator; an explicit `vCenterConnections` input narrows a run when needed. **No PowerShell host, no PowerCLI, no WinRM, no separate vCenter credential.** | Architecture |
| **P-34** | 2026-08-10 | Banding | Bands are **half-open and gapless** — `[floor, ceiling)` — so every value from the reporting floor to 100% lands in exactly one band, and a boundary value lands in the more severe one. Replaces the `-gt` / `-lt x.99` comparisons that left four exact values and two ranges unreported. | **Defect (silent omission)** |
| **P-35** | 2026-08-10 | Resilience | Three levels of isolation where there was none: per-**vCenter** `try`/`catch` so one unreachable vCenter cannot end the run; a **zero-capacity guard** so a decommissioned datastore cannot raise a divide-by-zero; per-**datastore** `try`/`catch` so one unreadable volume cannot cost the other four hundred. | **Defect (total failure)** |
| **P-36** | 2026-08-10 | Report scope | The `uncommitted > freeSpace` **AND condition is removed from collection**. Every datastore at or above the floor is reported, and the original condition is carried as an **`Overcommitted` column**. Where vCenter publishes no uncommitted value the column reads `unknown` rather than asserting `No`. | **Defect (silent omission)** — *changes what the customer sees* |
| **P-37** | 2026-08-10 | De-duplication | `Sort-Object -Property Datastore -Unique` removed. Row identity is **vCenter + MoRef**, never the display name, so identically named datastores on different vCenters both appear. A genuine duplicate identity within one vCenter is logged. | **Defect (silent omission)** — *changes what the customer sees* |
| **P-38** | 2026-08-10 | Incomplete scans | A vCenter that could not be scanned is rendered **into the report body** as a banner and a table naming it and the reason, not only into the run log. The recipient of the email is far more likely to read the email than to open Orchestrator. *(Same reasoning as S-16 on the Admin Accounts report.)* | Enhancement (trust) |
| **P-39** | 2026-08-10 | Presentation | A stylesheet is applied — this action emitted bare `ConvertTo-Html -Fragment` output with none. Four columns added: **Datacenter**, **Datastore Cluster**, **Type**, **Overcommitted**. Rows are ordered worst-first with deterministic tie-breaking, so consecutive reports can be compared by eye. | Enhancement |
| **P-40** | 2026-08-10 | Mail subject | Subject carries **all three band counts**, not the top band alone, and appends `INCOMPLETE (n vCenter(s) unreachable)` when the underlying scan had gaps. A recipient must not read a low count as good news when it is really a partial scan. | **Defect (misleading)** |
| **P-41** | 2026-08-10 | Outcome & recovery | The run classifies as `COMPLETE`, `CLEAN_NO_FINDINGS`, `COMPLETE_WITH_GAPS` or `ERROR` rather than pass/fail. A **delivery failure fails the run** — a report nobody received is not a success — and the exception handler writes the already-built report into the transcript so a late failure does not discard the whole estate sweep. | Enhancement (operability) |
| **P-42** | 2026-08-10 | Inputs & secrets | `vars.txt` → workflow inputs with defaults on the Inputs tab. Mail recipients are **arrays**, not comma-strings (consistent with P-12); blank Cc entries are stripped rather than rejected. SMTP credentials, when used, are a `SecureString` input; the current anonymous relay needs none. No configuration elements are required. | Enhancement |
| **P-43** | 2026-08-10 | Report artefact | The unbounded, **appending** `Debug\result.html` on the Windows host is replaced by the `reportHtml` workflow output, produced on every run whether or not mail is enabled and whether or not anything crossed a threshold. | Hygiene |

---

## 4. What deliberately does **not** change

| Item | Decision |
|---|---|
| **Default thresholds** | 90 / 80 / 70 preserved exactly. The bands are *derived* from `thresholdHighPct` and `bandWidthPct` rather than entered independently, so they cannot be made to overlap or invert by operator error. |
| **The 70% reporting floor** | Preserved, pending the §1B-2 decision. |
| **Short vCenter names in the report** | The retiring script displayed `$vcenter.Split('.')[0]`. Kept — the column stays readable. |
| **Worst-first ordering** | The retiring script sorted each band by `PercentFree` ascending. Kept in substance (now `% used` descending, with deterministic tie-breaks). |
| **The mail subject prefix** | `var_MailSubjectstring` carries over verbatim as `mailSubjectPrefix`. |
| **`cvs_functions.ps1`** | **Untouched.** See §1C. |
| **Read-only posture** | The automation never wrote to vCenter and still does not. |

---

## 5. Open items and watch items

| # | Item | Status |
|---|------|--------|
| 1 | **The report will get longer — brief the recipients first.** P-36, P-37 and P-34 each add rows that were previously invisible. The datastore count is expected to rise, in the lab fixtures by a factor of four. That is previously-hidden scope becoming visible, **not** a sudden deterioration in the estate. Brief the distribution list before the first scheduled send. | **Action required before go-live** |
| 2 | **`$high = 90` vs the comment saying 95** (§1B-1). | Customer decision |
| 3 | **"75 Percent" in the name vs a 70% floor** (§1B-2). | Customer decision |
| 4 | **The defects in §1A remain live in the Ansible path until the job template is retired.** This deliverable does not fix `cvs_functions.ps1` — by design, since the script is being taken out of the path entirely. For as long as both run in parallel, the Ansible report retains all six defects. Keep the overlap short, and do not treat the Ansible report as the reference during comparison. | **Open — accepted** |
| 5 | **vCenter permissions.** The Orchestrator vCenter endpoint account needs read-only at the root of each inventory. No write permission is needed or used. Confirm the registered endpoints cover all five vCenters. | Verify at deployment |
| 6 | **SMTP relay reachability from Orchestrator.** Mail now leaves the Orchestrator appliance, not the Windows host. `mailrelay.corp.local:25` must accept submission from the appliance's address. | Verify at deployment |
| 7 | **`uncommitted` is optional in the vSphere API** and is not published for every datastore type. Those rows render `unknown` in the Overcommitted column rather than a misleading `No`. Expect some on NFS. | Informational |
| 8 | **Overlapping runs are harmless.** The workflow is read-only and holds no lock, so it needs no mutex — unlike Snapshot Cleanup. A slow run overrun by the next schedule costs duplicate emails, nothing more. | Informational |

---

## 6. Parallel run — how to compare the two reports

A side-by-side comparison against the Ansible report **will** show differences, and
every one of them is a defect fix rather than a regression. Expect, in descending
order of visibility:

1. **More datastores — usually many more** (P-36). Anything full but not overcommitted
   is appearing for the first time.
2. **Duplicate names now appear** (P-37), attributed to different vCenters.
3. **Boundary datastores now appear** (P-34) — anything at exactly 90.00, 89.99, 80.00
   or 70.00 percent.
4. **New columns** (P-39) — Datacenter, Datastore Cluster, Type, Overcommitted.
5. **A styled report** (P-39).
6. **A report arrives even when a vCenter is unreachable** (P-35), and declares the gap
   on its face (P-38).

**The comparison to run.** Take the row set from each report, keyed on
vCenter + datastore name. The correct result is that the new report is a **strict
superset** of the old one: nothing that appears today should disappear. Anything that
*does* disappear is a genuine regression and should be raised — that assertion is
enforced as test T-23 in the lab harness and must also hold in production.

**Do not compare counts.** The counts are expected to differ substantially and the
difference is the point. Compare membership.

---

## Revision history

| Date | Author | Summary |
|---|---|---|
| 2026-08-10 | Automation transition | Register created. Recorded the current state of `get_datastores_75_100_used.yml` and the `get_datastores_75_100_used` script case, six pre-existing silent defects (§1A), two configuration observations for customer decision (§1B), and process changes **P-33 … P-43**. Confirmed **no `S-` changes**: this deliverable is vCenter-native and does not touch `cvs_functions.ps1`. |
