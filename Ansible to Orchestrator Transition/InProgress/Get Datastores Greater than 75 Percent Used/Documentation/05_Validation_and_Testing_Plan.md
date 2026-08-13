# Validation and Testing Plan — Datastore Capacity Reporting

**Workflow:** Get Datastore Capacity Report
**Package:** `com.broadcom.pso.vc.storage.reporting`
**Date:** 2026-08-10

---

## 1. Approach

Three layers, in order. Each answers a question the next cannot.

| Layer | Question answered | Where |
|---|---|---|
| **A. Offline suite** | Is the logic correct, including the cases you cannot conjure in a lab? | `lab/Run-AllTests.js` |
| **B. Lab validation** | Do the vCenter and Mail plug-in calls behave as assumed on a real appliance? | Lab Orchestrator + vCenters |
| **C. Parallel run** | Does the production output differ from today's only in the ways predicted? | Production, two cycles |

**Layer A cannot replace Layer B.** It stubs `System`, `VcPlugin` and `EmailMessage`;
it proves the logic built on those calls, not the calls themselves.

**Layer B cannot replace Layer A.** A zero-capacity datastore, an unreachable vCenter,
two datastores sharing a name across sites and a datastore sitting on exactly 90.00%
are all trivial as fixtures and impractical to arrange on demand in a lab.

---

## 2. Layer A — offline test suite

```
cd lab
node Run-AllTests.js
```

**Result on delivery: `PASSED: 112   FAILED: 0`.** Requires Node 18+. No network,
no dependencies, no appliance.

The suite executes the **shipped source** from `../Code` unmodified against a
synthetic five-vCenter estate. Actions are wrapped as functions taking their declared
inputs; scriptable tasks are evaluated against a pre-seeded workflow context, which is
how vRO binds attributes. Full fixture inventory is in [../lab/README.md](../lab/README.md).

### Scenario coverage

| # | Scenario | Proves |
|---|---|---|
| T-01 | Full run, defaults, mail enabled | Happy path end to end |
| T-02 | Unreachable vCenter does not end the run | **P-35** |
| T-03 | Zero-capacity datastore skipped, not fatal | **P-35** |
| T-04 | Unreadable datastore isolated from its siblings | **P-35** |
| T-05 | Full-but-not-overcommitted datastore reported | **P-36** |
| T-06 | Boundary values land in exactly one band | **P-34** |
| T-07 | Below-floor datastore excluded | Floor honoured |
| T-08 | Same-named datastores on different vCenters both survive | **P-37** |
| T-09 | Absent `uncommitted` renders `unknown`, never asserted `No` | **P-36** |
| T-10 | Inaccessible datastores excluded by default, included on request | Input behaviour |
| T-11 | Placement resolves; failure degrades to blank, not to a dead run | Design §3.3 |
| T-12 | Rendering, stylesheet, HTML escaping | **P-38, P-39**, security |
| T-13 | Worst-first, run-to-run deterministic ordering | **P-39** |
| T-14 | Subject carries all three counts and declares incompleteness | **P-40** |
| T-15 | Blank Cc entries stripped, not rejected | **P-42** |
| T-16 | Input validation fails before any vCenter is contacted | Fail-fast |
| T-17 | vCenter resolution: all / explicit / none registered | **P-33** |
| T-18 | Clean estate → `CLEAN_NO_FINDINGS`, report still sent | **P-41** |
| T-19 | Custom thresholds re-band correctly | **P-34** |
| T-20 | Delivery failure fails the run; report recoverable from transcript | **P-41** |
| T-21 | `sendEmail=false` builds the report, sends nothing | Input behaviour |
| T-22 | Every log line carries the `[DATASTORE-REPORT]` marker | Operability |
| T-23 | Legacy vs new delta | All of the above, quantified |

### T-23 — the measured delta

Both implementations are run over the subset the legacy logic can survive (the others
abort it outright):

```
legacy reported : 2
new reports     : 8
newly visible   : PROD-VMFS-002 (99.10%, not overcommitted)
                  SITE-PROD-01 on vcb02 (name collision victim)
                  BOUNDARY-90-00, BOUNDARY-89-99, BOUNDARY-80-00, BOUNDARY-70-00
no longer shown : (none)
```

Two assertions, both of which must also hold in production:

- **Strict superset** — nothing the customer sees today disappears.
- **On the full estate the legacy implementation reports nothing at all**, aborting on
  the zero-capacity datastore before reaching the email step.

The 4× ratio is a property of the fixtures, not a production forecast. The production
figure is measured in Layer C.

### Sample reports

Regenerated on every run, for review before the first scheduled send:

| File | Shows |
|---|---|
| `Sample-Report-Full.html` | Default thresholds, one vCenter unreachable — the incomplete-scan banner |
| `Sample-Report-Complete.html` | All vCenters reachable |
| `Sample-Report-NoFindings.html` | Clean estate |
| `Sample-Report-Thresholds-95.html` | `thresholdHighPct=95`, `bandWidthPct=5` |

---

## 3. Layer B — lab validation

Run in order. Each step has a defined pass condition; do not proceed past a failure.

| # | Test | Method | Pass condition |
|---|---|---|---|
| **B-1** | Package imports cleanly | Import `com.broadcom.pso.vc.storage.reporting` | Workflow and both actions present; **no** element overwritten |
| **B-2** | Dry run, no mail | Run with `sendEmail = false` | `outcome = COMPLETE` or `CLEAN_NO_FINDINGS`; `reportHtml` populated; log ends `[FINALISE] [RESULT]` |
| **B-3** | **Plug-in calls behave as assumed** | Inspect the `[INVENTORY]` log lines | Each vCenter logs `n datastore(s) enumerated`. A non-zero figure confirms `getAllDatastores()` returns real inventory |
| **B-4** | Endpoint coverage | Read the report header | *vCenters scanned: n of n*, `n` = vCenters in scope. **A shortfall here is the most likely go-live defect** |
| **B-5** | Placement resolution | Inspect Datacenter / Datastore Cluster columns | Populated for datastores in datacenters and storage pods. Blank columns with a `placement map` warning are acceptable but should be understood |
| **B-6** | Figures are correct | Pick three datastores; compare against the vSphere Client | Capacity, free and % used match to rounding |
| **B-7** | Mail delivery | `mailTo` = your address, `sendEmail = true` | Delivered; subject `<prefix> \| n critical / n warning / n advisory`; renders correctly **in the recipients' actual mail client**, not only a browser |
| **B-8** | Cc handling | Add a real Cc, then an empty one | Both send; the empty Cc does not fail the run |
| **B-9** | Narrowed run | Populate `vCenterConnections` with one vCenter | Report scopes to it; header reads *1 of 1* |
| **B-10** | **Gap handling** | Break one vCenter endpoint's credentials, re-run | Report **still delivered**; red banner names that vCenter and the reason; subject carries `INCOMPLETE`; `outcome = COMPLETE_WITH_GAPS` |
| **B-11** | Delivery failure | Set `smtpHost` to an unreachable host | Run ends `ERROR`; log names the relay; the **full report HTML is written into the transcript** between the `---BEGIN REPORT HTML---` markers |
| **B-12** | Input validation | `thresholdHighPct = 140`; then `mailTo = []` with `sendEmail = true` | Both fail immediately, naming the input. **No `[INVENTORY]` lines appear** — nothing was scanned |
| **B-13** | Custom thresholds | `thresholdHighPct = 95`, `bandWidthPct = 5` | Bands read 95 / 90 / 85; rows re-band accordingly |
| **B-14** | Read-only posture | Review the vCenter task list for the run window | **No tasks attributable to the Orchestrator service account.** The workflow must generate none |
| **B-15** | Log filterability | Filter VCF Operations for Logs on `[DATASTORE-REPORT]` | The complete run transcript returns, and nothing else |

**B-14 is the one to run deliberately.** The claim that this workflow cannot change
the estate is worth evidencing once rather than asserting.

---

## 4. Layer C — parallel run

**Duration:** at least two full scheduled cycles with both systems running.

### Before the first send

- [ ] **Recipients briefed** that the report will get longer, using Change Register §6.
      *This is the primary go-live risk and the most likely cause of an escalation.*
- [ ] Orchestrator schedule created, matching the Ansible cadence.
- [ ] Ansible job template still enabled.

### The comparison

For each cycle, take the row set from each report keyed on **vCenter + datastore name**
and compute:

| Set | Expected |
|---|---|
| Present in **both** | The bulk of the Ansible report |
| **New only** | Expected and large. Categorise each as P-36 (full, not overcommitted), P-37 (name collision), or P-34 (boundary) |
| **Ansible only** | **Must be empty.** Any member is a regression and blocks cutover |

Record the actual counts — they are the production measurement of the delta and the
evidence for the customer that the previous report was incomplete.

> **Do not compare counts as a pass/fail test.** They are expected to differ
> substantially; that difference is the deliverable. Compare membership.

### Acceptance criteria

| # | Criterion |
|---|---|
| C-1 | Two consecutive cycles complete with `outcome` of `COMPLETE` or `CLEAN_NO_FINDINGS` |
| C-2 | **Zero** rows present in the Ansible report and absent from the Orchestrator report |
| C-3 | Every additional row attributable to P-34, P-36 or P-37 |
| C-4 | *vCenters scanned* equals the vCenters in scope on every cycle |
| C-5 | Report delivered to the full distribution list, rendering correctly in their mail client |
| C-6 | No vCenter task generated by the Orchestrator service account across the window |
| C-7 | Change Register §1B decisions resolved — the 90-vs-95 threshold and the 70-vs-75 floor |

Cutover on all seven. Then disable the Ansible job template.

---

## 5. Failure scenarios and expected behaviour

Reference table for anyone assessing a run.

| Scenario | Expected behaviour | Retiring behaviour |
|---|---|---|
| One vCenter unreachable | Run continues; vCenter named in the report and the subject; `COMPLETE_WITH_GAPS` | **Entire run aborts. Nothing emailed.** |
| All vCenters unreachable | Report delivered listing every failure; zero rows; `COMPLETE_WITH_GAPS` | Aborts on the first |
| No vCenter registered | Fails in ST-01 before contacting anything, with a message naming the fix | n/a |
| Datastore reports capacity 0 | Skipped with a reason; listed in "could not be evaluated" | **Divide-by-zero. Run dies. Nothing emailed.** |
| Datastore properties fault mid-sweep | Skipped with a reason; siblings unaffected | Run dies |
| `uncommitted` not published | `unknown` in the Overcommitted column | Treated as 0, so the datastore was excluded from collection entirely |
| Nothing above the floor | Report delivered saying so; `CLEAN_NO_FINDINGS` | Empty tables emailed |
| SMTP unreachable | Run ends `ERROR`; report written to the transcript for recovery | Run fails; report lost |
| Invalid threshold input | Rejected in ST-01 before any vCenter is contacted | No validation |
| Two runs overlap | Both complete; duplicate emails | Same |
| Inventory walk fails on one vCenter | Placement columns blank for it, warned; capacity data intact | n/a |

---

## 6. Regression testing after any code change

1. Run `node lab/Run-AllTests.js`. **All 112 assertions must pass.**
2. If behaviour changed intentionally, update the assertion **and** the Change Register
   in the same edit.
3. Re-run lab tests B-2, B-7 and B-10 as a minimum — the collection path, the delivery
   path and the gap path.
4. Update [../Code/Get-DatastoreCapacityReport_spec.js](../Code/Get-DatastoreCapacityReport_spec.js)
   if the schema, inputs, attributes or outputs changed. The spec is the as-built
   record and drifts silently if it is not maintained.
