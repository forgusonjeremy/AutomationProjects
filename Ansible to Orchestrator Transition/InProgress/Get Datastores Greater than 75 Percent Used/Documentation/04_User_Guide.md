# User Guide — Datastore Capacity Report

**Workflow:** Get Datastore Capacity Report
**Where:** Orchestrator client → *Production → VMware → vCenter → Storage → Reporting*
**Date:** 2026-08-10

---

## 1. What it does

Scans every vCenter registered in Orchestrator, finds the datastores at or above a
percent-used floor, sorts them into three severity bands, and emails a styled HTML
report with the fullest datastores first.

It runs on a schedule and needs no operator involvement. Run it by hand when you want
a report between scheduled sends, or when you are checking a specific vCenter.

**It only reads.** It never moves, deletes, expands or reconfigures anything. There is
no dry-run switch because there is nothing to gate — the workflow cannot change your
estate.

---

## 2. Reading the report

### Header

| Field | Meaning |
|---|---|
| **Generated** / **Run ID** | Timestamp and the `DSR-…` identifier. Quote the Run ID when raising a question about a specific report. |
| **vCenters scanned** | `n of m`. **If these differ, the report is incomplete** — see the red banner. |
| **Datastores inspected** | Total enumerated across the estate, before filtering. |
| **Reporting floor** | Nothing below this percent used appears anywhere in the report. |
| **Reported** | How many rows follow, and how many are overcommitted. |

### Bands

| Band | Default range | Meaning |
|---|---|---|
| **Critical** (red) | 90% and above | Act now |
| **Warning** (amber) | 80% to under 90% | Plan |
| **Advisory** (blue) | 70% to under 80% | Watch |

Bands are contiguous — every reported datastore appears in **exactly one**. Within a
band, the fullest datastore is at the top.

### Columns

| Column | Meaning |
|---|---|
| **Datastore** / **vCenter** | The datastore, and which vCenter it lives on. **The same name can legitimately appear twice** on different vCenters — those are two different datastores. |
| **Datacenter** / **Datastore Cluster** | Where it sits in the inventory. Blank if the inventory could not be walked; the capacity figures are unaffected. |
| **Type** | `VMFS`, `NFS`, `NFS41`, `vsan`, `VVOL` |
| **Capacity / Used / Free GB** | Rounded to whole gigabytes |
| **Uncommitted GB** | Space thin-provisioned disks, linked clones and snapshots are entitled to consume but have not yet |
| **% Used** / **% Free** | To two decimal places |
| **Overcommitted** | `Yes` = uncommitted space exceeds free space. **This datastore can fill without a single new VM being deployed.** `unknown` = vCenter published no uncommitted value for this datastore type, common on NFS. |

> **Overcommitted is a flag, not a filter.** A datastore at 99% used appears whether or
> not it is overcommitted. That is a deliberate change from the previous report — see
> §6.

### Red banner: "This report is incomplete"

At least one vCenter could not be scanned. The table beneath names it and gives the
reason. **Treat every count in the report as a floor, not a total** — there may be
full datastores on the vCenter that was missed. Raise it with the platform team.

### "Datastores that could not be evaluated"

Individual datastores that were enumerated but not readable — usually
decommissioned, mid-removal or reporting zero capacity. Informational; the rest of the
report is unaffected.

---

## 3. Running it by hand

1. Open the workflow and click **Run**.
2. Leave every input at its default for a normal estate-wide report.
3. Click **Run**. The report is emailed and also stored on the run.
4. To read it without waiting for the email: open the run → **Variables** →
   `reportHtml`. Copy the value into a file ending `.html` and open it in a browser.

---

## 4. Inputs you might change

Everything else can be left alone.

| Input | Change it when |
|---|---|
| `vCenterConnections` | You want **one** vCenter, not the estate. Leave empty for all. |
| `sendEmail` | Set `false` to produce the report without emailing anyone — useful when testing or when you just want to look. |
| `mailTo` | You want the report sent to yourself for a one-off run. |
| `thresholdHighPct` | You want a different Critical floor. Default `90`. |
| `bandWidthPct` | You want wider or narrower bands. Default `10`, giving 90 / 80 / 70. |
| `includeInaccessible` | You are chasing datastores vCenter currently reports as inaccessible. Off by default because they carry stale figures. |

**Thresholds are derived, not entered separately.** You set the top of the range and
the band width; the other two floors follow. This is why you cannot accidentally
create overlapping or inverted bands.

Examples:

| `thresholdHighPct` | `bandWidthPct` | Bands | Floor |
|---|---|---|---|
| 90 | 10 | 90 / 80 / 70 | 70% *(default)* |
| 95 | 5 | 95 / 90 / 85 | 85% |
| 85 | 5 | 85 / 80 / 75 | 75% |

---

## 5. Outputs

| Output | Meaning |
|---|---|
| `reportHtml` | The complete report. Always produced, even when nothing crossed a threshold and even when mail is off. |
| `outcome` | `COMPLETE` · `CLEAN_NO_FINDINGS` · `COMPLETE_WITH_GAPS` · `ERROR` |
| `criticalCount` / `warningCount` / `advisoryCount` | Rows per band |

`COMPLETE_WITH_GAPS` means the report was produced but at least one vCenter could not
be scanned. **It is not a clean run** and should be followed up.

---

## 6. What changed from the Ansible report

The report you receive after cutover is **longer**, and every difference is a
correction. Expect:

1. **Many more datastores.** The old report only counted a datastore if its
   uncommitted space exceeded its free space. A datastore at 99% used with little
   thin-provisioned growth outstanding never appeared. It does now, with
   `Overcommitted: No`.
2. **The same datastore name twice**, on different vCenters. The old report
   de-duplicated on the name across all five vCenters and silently dropped one of
   them.
3. **Datastores sitting exactly on a threshold** — 90.00%, 89.99%, 80.00%, 70.00%.
   These matched no band in the old logic and were shown nowhere.
4. **New columns** — Datacenter, Datastore Cluster, Type, Overcommitted.
5. **A subject line with all three counts**, not just the top band, plus an
   `INCOMPLETE` marker when a vCenter was missed.
6. **A report even when a vCenter rejects authentication.** The old script skipped a
   vCenter it could not reach on port 443, but a vCenter that answered and then failed
   to authenticate — expired or locked service account — ended the run and sent
   nothing at all.

**What has not changed:** the look of the email. The banded layout and the accent
colours are carried over deliberately, so the report stays familiar.

**A higher count does not mean your estate got worse.** It means the report is now
showing you what was always there.

---

## 7. Known limitations

| Limitation | Detail |
|---|---|
| Only registered vCenters are scanned | A vCenter not registered in Orchestrator is invisible to the report and **will not be flagged as missing**. Check *vCenters scanned: n of m* against the number you expect. |
| Point-in-time only | Reports what vCenter says right now. No trending, no growth rate, no forecast. |
| `Uncommitted` is not always published | Renders `unknown`, most often on NFS. |
| Zero-capacity datastores are skipped | Listed under "could not be evaluated" rather than reported as 0% or 100%. |
| Whole-gigabyte rounding | A very small datastore may show `0` GB free while `% Free` is non-zero. `% Free` is the accurate figure. |
| Bands are fixed at three | Set by `thresholdHighPct` and `bandWidthPct`; the count is not configurable. |

---

## 8. Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| **No email arrived** | Delivery failed, or `sendEmail` was false | Open the run log and filter `[DATASTORE-REPORT] [NOTIFY]`. A delivery failure fails the run and names the relay. The report body is written into the transcript by the exception handler — copy it out rather than re-running. |
| **Red "incomplete" banner** | A vCenter could not be scanned | The banner names it and the reason. Usually expired endpoint credentials or an unreachable vCenter. Fix under **Administration → vCenter Server**. |
| **"vCenters scanned: 4 of 5"** but no banner | Not possible — the two always agree | Raise it; something is wrong with the run |
| **Fewer vCenters than expected** | One is not registered in Orchestrator | **Administration → vCenter Server**. This is the most likely cause of an unexpectedly short report |
| **Report much longer than the Ansible one** | Expected — see §6 | No action. Compare membership, not counts |
| **A datastore you expected is missing** | It is below the reporting floor, inaccessible, or on an unscanned vCenter | Check the floor in the header, then the "could not be evaluated" table, then the banner |
| **Blank Datacenter / Datastore Cluster** | The inventory walk failed on that vCenter | Cosmetic. Capacity figures are unaffected. The run log carries a `placement map` warning |
| **`Overcommitted: unknown`** | vCenter published no uncommitted value for that datastore type | Normal, most often on NFS |
| **Run failed immediately** | Input validation | The error names the offending input. Validation runs before any vCenter is contacted, so nothing was scanned |
| **Duplicate emails** | Two runs overlapped | Harmless — the workflow is read-only and holds no lock. Lengthen the schedule interval if it recurs |

**For any issue:** filter the Orchestrator log on `[DATASTORE-REPORT]` to get the full
run transcript, and quote the `DSR-…` Run ID.
