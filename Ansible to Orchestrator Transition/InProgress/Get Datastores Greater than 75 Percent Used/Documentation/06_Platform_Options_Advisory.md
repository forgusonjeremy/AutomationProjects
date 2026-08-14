# Platform Options Advisory — Datastore Capacity and Fill Projection

**Question asked:** the newer `datastore_fill_projection_report.yml` looks like the
successor to the 75–100% usage report. Should it be transitioned to Orchestrator, or
can VCF Operations do this natively?

**Recommendation:** **VCF Operations should own the projection and the alerting.** Do
not rebuild `cvs_datastore_fill_projection.ps1` as an Orchestrator workflow. Keep a
much smaller Orchestrator workflow only if the bespoke banded email is itself a
requirement.

**Date:** 2026-08-13
**Status:** Advisory — decision required before any projection work is scheduled

---

## 1. What the projection script does

`cvs_datastore_fill_projection.ps1` samples `disk.used.latest` per datastore over a
7-day and a 30-day lookback, takes the **faster** of the two positive growth rates,
divides the gap to a 90% threshold by that rate, and tiers the result:

| Tier | Condition |
|---|---|
| Immediate risk | Already ≥ 90%, or projected to reach it within 30 days |
| Watchlist | Positive growth, but outside the 30-day window |
| No/low growth | Below `MinimumGrowthGBPerDay` (0.10), or no metric available — **top 25 only** |

Output is a styled HTML email plus a CSV in the debug folder.

---

## 2. Why VCF Operations is the better home

VCF Operations is already deployed in this environment and is **already collecting
these metrics continuously**. The capability is native, not an add-on.

| Requirement | VCF Operations capability |
|---|---|
| Days until a datastore fills | **`Capacity \| Time Remaining`** on every Datastore object |
| Headroom before a threshold | **`Capacity \| Capacity Remaining`**, with thresholds set per policy |
| Thin-provisioning overcommit | **`Disk Space \| Provisioned Space`** and space-overcommitment metrics |
| Alert when a datastore is at risk | OOTB alert definition **"Datastore is running out of disk space"**, with symptoms on time-remaining and utilisation |
| Emailed report on a schedule | **Views → Reports**, scheduled and delivered as PDF/CSV via the Standard Email Plugin |
| Multi-vCenter | Native — a single Operations instance spans all five |

### Three reasons this is better, not merely equivalent

1. **The projection model is stronger.** The script fits a straight line through two
   points — the first and last sample in the window. A datastore where a large VM was
   deleted early in the window projects as **flat**; one that spiked and recovered
   projects as **growing**. Operations' capacity engine works from months of history
   with trend handling and does not have that failure mode. The script also floors the
   observed span at one day (`[Math]::Max(1, …TotalDays)`), which **understates**
   growth when samples span less than a day — erring towards "safe" on a report whose
   whole purpose is to warn.

2. **An alert beats a weekly email.** A datastore crossing its projection at 02:00 on
   a Tuesday is actionable that morning. On the current model it surfaces in the next
   scheduled send, and only if someone reads past the first table.

3. **Nothing to maintain.** No PowerCLI version to track, no `Get-Stat` metric-name
   fallback list (`disk.used.latest.average` then `disk.used.latest`), no per-datastore
   API loop, no CSV housekeeping. It also removes the load: the script re-queries
   historical stats for every datastore on every run — roughly **two `Get-Stat` calls
   per datastore per run**, against vCenters that have already handed the same data to
   Operations.

---

## 3. What VCF Operations does not give you

Stated plainly, so the decision is made with both sides visible.

| Gap | Detail | Weight |
|---|---|---|
| **The exact email format** | Operations Views produce a scheduled list report (PDF/CSV). You can select the same columns and group by severity, but you will not reproduce the banded HTML layout the team reads today. | The main one |
| **Report look-and-feel control** | Branding, colour banding, section ordering and prose are limited to what the Views/Reports engine offers. | Moderate |
| **Bespoke derived columns** | Anything not expressible as a metric or super metric needs a super metric or a different tool. | Low — the required columns all exist |
| **Change of habit** | The team currently reads an email. Moving to alerts is a process change, not just a tooling change. | Moderate — plan it |

---

## 4. Recommended split

| Concern | Owner |
|---|---|
| Fill projection, days-to-full, trend analysis | **VCF Operations** — capacity analytics |
| Alerting when a datastore is projected to fill | **VCF Operations** — alert definition + email notification |
| Historical reporting and CSV export | **VCF Operations** — scheduled Views/Reports |
| Point-in-time banded usage email, if the format is a hard requirement | **Orchestrator** — the workflow already built in this deliverable |
| Any *remediation* action (expand, Storage vMotion, reclaim) | **Orchestrator** — triggered by an Operations alert |

The last row is the pattern worth aiming at: **Operations decides, Orchestrator acts.**
Operations already supports invoking automation on an alert, which is a materially
better end state than a report that a human reads and then acts on manually.

---

## 5. Validation before retiring anything

Do not switch off the script on the strength of this advisory alone.

1. Open **Environment → Datastore** in VCF Operations and confirm `Time Remaining` and
   `Capacity Remaining` are populated for a representative sample. Newly added objects
   need history before the analytics settle.
2. Pick three datastores with known growth — one filling, one flat, one that recently
   had a large VM deleted — and compare Operations' `Time Remaining` against the
   script's `DaysToThreshold`. **The third is the interesting one**: it is where the
   two-point fit is expected to disagree with Operations, and confirming that
   disagreement is the evidence for the recommendation.
3. Confirm the OOTB datastore space alert is enabled in the active policy and that its
   thresholds match the 90% / 30-day intent.
4. Build one scheduled View/Report with the columns the team wants and send it to a
   test recipient. Decide whether the format is acceptable **before** committing to
   retire the email.
5. Run both in parallel for two cycles, as with any other cutover in this programme.

---

## 6. Impact on this deliverable

**None to the code.** The workflow built here reports current usage; it never claimed
to project. This advisory only settles whether a *second* Orchestrator workflow should
be built for projection — and the recommendation is no.

If the recommendation is accepted, the follow-on question becomes whether the
current-usage email is still wanted once Operations alerts are firing. If it is not,
this deliverable's scope reduces to retiring `get_datastores_75_100_used.yml` with no
Orchestrator replacement at all, which is a better outcome than either transition.

**Recorded as open item 10 in `Change-Register.md`.**
