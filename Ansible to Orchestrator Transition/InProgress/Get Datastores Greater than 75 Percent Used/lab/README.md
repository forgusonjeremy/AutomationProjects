# Lab — Get Datastore Capacity Report

Offline test harness for the vRO code in [../Code/](../Code/). It executes the
**shipped source**, unmodified, under Node against a synthetic five-vCenter
estate, so every behavioural claim in the Change Register is demonstrated rather
than asserted.

```
node Run-AllTests.js
```

Exit code `0` = all assertions passed. Requires Node 18+. No network, no vCenter,
no Orchestrator appliance, no dependencies to install.

---

## Why this exists

The awkward cases in this transition — a datastore reporting zero capacity, an
unreachable vCenter, two datastores sharing a name across sites, a value sitting
exactly on a band boundary — are all cases you cannot conjure on demand in a lab
vCenter. They are trivial to construct as fixtures. The harness therefore proves
the corrections in a way a lab run cannot, and the lab run then confirms the
plug-in calls behave as expected against real inventory.

**The harness does not replace the lab validation in
[../Documentation/05_Validation_and_Testing_Plan.md](../Documentation/05_Validation_and_Testing_Plan.md).**
It cannot verify that `getAllDatastores()`, `rootFolder.childEntity` or
`EmailMessage` behave on the appliance as they are stubbed here. It verifies the
logic built on top of them.

---

## Files

| File | Purpose |
|---|---|
| `vro-shim.js` | Stubs `System`, `VcPlugin` and `EmailMessage`, and loads the real `../Code/*.js` files. Actions are wrapped as functions taking their declared inputs; scriptable tasks are evaluated inside `with (ctx)` against a pre-seeded workflow context, which is how vRO binds attributes. |
| `fixtures.js` | The synthetic estate, plus `legacySelect()` — a faithful transcription of the retiring PowerShell's selection and banding, used only to quantify the delta. |
| `Run-AllTests.js` | 112 assertions across 23 scenarios. Also writes the sample reports below. |
| `Sample-Report-Full.html` | Default thresholds, one vCenter unreachable. The incomplete-scan banner is visible. |
| `Sample-Report-Complete.html` | All vCenters reachable, nothing skipped. |
| `Sample-Report-NoFindings.html` | A clean estate — nothing at or above the floor. |
| `Sample-Report-Thresholds-95.html` | `thresholdHighPct=95`, `bandWidthPct=5`. Shows rows re-banding. |

The sample reports are regenerated on every run. Open them in a browser to
review layout before the first scheduled send.

---

## What the synthetic estate contains

Every fixture exists to exercise a specific defect or edge case.

| Datastore | vCenter | Represents |
|---|---|---|
| `PROD-VMFS-014` 92.97% | vc01 | Ordinary critical + overcommitted. Reported by old and new alike — the control case. |
| `PROD-VMFS-002` 99.10% | vc01 | **Full but not overcommitted.** Invisible in the old report (P-36). |
| `BOUNDARY-90-00` 90.00% | vc01 | Exactly on the high boundary. Old logic: `-gt 90` false, `-lt 89.99` false → shown nowhere (P-34). |
| `BOUNDARY-89-99` 89.99% | vc01 | Exactly on `$med_limit`. `-lt 89.99` is false → shown nowhere (P-34). |
| `BOUNDARY-80-00` 80.00% | vc01 | Exactly on `$med`. Matched neither band (P-34). |
| `BOUNDARY-70-00` 70.00% | vc01 | Exactly on the collection floor. `-gt 70` false → never collected (P-34). |
| `QUIET-VMFS-050` 41.20% | vc01 | Below the floor. Must stay out. |
| `DECOMMISSIONED-01` cap=0 | vc02 | **Divide by zero.** Killed the entire old run before anything was emailed (P-35). |
| `APD-VMFS-007` inaccessible | vc02 | Skipped by default, included via `includeInaccessible`. |
| `NFS-ARCHIVE-01` 97.50% | vc02 | vCenter publishes no `uncommitted` value → must render `unknown`, not `No`. |
| `FAULTY-VMFS-099` | vc02 | Property access faults mid-enumeration. Must be isolated, siblings still collected. |
| `<script>alert…` 93.40% | vc02 | Datastore names are free text from vCenter. Must be escaped. |
| `SITE-PROD-01` 94.00% | vcb01 | **Name collision across sites.** `Sort-Object -Unique` on the name silently dropped one of these (P-37). |
| `SITE-PROD-01` 91.50% | vcb02 | The other half of the collision. |
| *(none)* | vc.corp.local | Connection throws on login. Old script aborted the whole run; new run reports the gap (P-35, P-38). |

---

## The measured delta

`T-23` runs both implementations over the subset the legacy logic can survive
(vc01 + vcb01 + vcb02 — the others kill it outright) and compares the row sets:

```
legacy reported : 2   PROD-VMFS-014, SITE-PROD-01 (one of two)
new reports     : 8
newly visible   : PROD-VMFS-002, SITE-PROD-01 (vcb02), BOUNDARY-90-00,
                  BOUNDARY-89-99, BOUNDARY-80-00, BOUNDARY-70-00
no longer shown : (none)
```

Two properties are asserted, and both matter for the parallel-run brief:

- **The new report is a strict superset.** Nothing the customer sees today
  disappears. Every difference is an addition.
- **On the full estate the legacy implementation reports nothing at all** — it
  aborts on the zero-capacity datastore in vc02 before reaching the email step.

Those ratios are a property of the fixtures, not a prediction for production. The
production figure is measured during the parallel run described in
[05_Validation_and_Testing_Plan.md](../Documentation/05_Validation_and_Testing_Plan.md).

---

## Scenario index

| # | Scenario | Change proved |
|---|---|---|
| T-01 | Full run, defaults, mail enabled | — |
| T-02 | Unreachable vCenter does not end the run | P-35 |
| T-03 | Zero-capacity datastore skipped, not fatal | P-35 |
| T-04 | Unreadable datastore isolated from its siblings | P-35 |
| T-05 | Full-but-not-overcommitted datastore reported | P-36 |
| T-06 | Boundary values land in exactly one band | P-34 |
| T-07 | Below-floor datastore excluded | — |
| T-08 | Same-named datastores on different vCenters both survive | P-37 |
| T-09 | Absent `uncommitted` renders `unknown` | P-36 |
| T-10 | Inaccessible datastores excluded by default, included on request | — |
| T-11 | Datacenter / datastore cluster resolve; failure degrades to blank | — |
| T-12 | Rendering, stylesheet, HTML escaping | P-38, P-39 |
| T-13 | Worst-first, run-to-run deterministic ordering | — |
| T-14 | Subject carries all three counts and declares incompleteness | P-40 |
| T-15 | Blank Cc entries stripped, not rejected | — |
| T-16 | Input validation fails before any vCenter is contacted | — |
| T-17 | vCenter resolution: all / explicit / none registered | P-33 |
| T-18 | Clean estate → `CLEAN_NO_FINDINGS`, report still sent | — |
| T-19 | Custom thresholds re-band correctly | P-34 |
| T-20 | Delivery failure fails the run; report recoverable from the transcript | P-41 |
| T-21 | `sendEmail=false` builds the report, sends nothing | — |
| T-22 | Every log line carries the `[DATASTORE-REPORT]` marker | — |
| T-23 | Legacy vs new delta | all |

---

## Adding a case

Add the datastore to `buildEstate()` in `fixtures.js`, then assert against it in
`Run-AllTests.js`. `ds()` computes byte values that produce an **exact**
two-decimal `percentUsed`, so boundary behaviour can be asserted precisely:

```js
ds('MY-CASE-01', { percentUsed: 84.50, capacityGB: 2048, uncommittedGB: 100,
                   datacenter: 'DC-EAST', datastoreCluster: 'SDRS-PROD' })
```

Useful `opts`: `type`, `accessible`, `maintenanceMode`, `uncommittedGB: null`
(vCenter publishes no value), `rawCapacity` / `rawFree` (bypass the percentage
calculation entirely), `summaryThrows`.
