/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Workflow: Get Datastore Capacity Report
 *   Workflow ID : (TBD — assign on first save in vRO, then record it here)
 *   Folder      : Production >> VMware >> vCenter >> Storage >> Reporting
 *                 (lab/dev: Workflows >> Customer >> <Customer Name> >> ...)
 *   Package     : com.broadcom.pso.vc.storage.reporting
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE DOCUMENTS THE AS-BUILT WORKFLOW. It mirrors the exported workflow
 * definition so the design and the appliance stay in sync. The code in each
 * ST-*.js file in this folder is the exact code deployed in the corresponding
 * schema element.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ───────────────────────────────────────────────────────────────────────────
 *   READ-ONLY capacity report over every datastore in the estate. Sweeps each
 *   registered vCenter, keeps the datastores at or above a reporting floor,
 *   sorts them into three contiguous severity bands, and emails a banded HTML
 *   report that leads with the datastores closest to full.
 *
 *   NOTHING IS EVER MODIFIED. The workflow issues no write of any kind against
 *   vCenter — it reads DatastoreSummary and nothing else. There is therefore no
 *   whatIf / safety gate: there is nothing to gate. This is the same reasoning
 *   applied to the Service Account Expiration report.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MAPS FROM (Ansible)
 * ───────────────────────────────────────────────────────────────────────────
 *   - get_datastores_75_100_used.yml  x1 job template, which staged
 *                                     cvs_functions.ps1 onto a Windows host over
 *                                     WinRM and invoked it with
 *                                     -Action Get_Datastores_75_100_Used
 *
 *   One playbook, one workflow. There is no fork and no second variant.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS TRANSITION REMOVES ENTIRELY
 * ───────────────────────────────────────────────────────────────────────────
 *   Unlike the Active Directory deliverables in this programme, this workflow
 *   does NOT call the PowerShell host at all. The whole execution chain below
 *   the playbook disappears:
 *
 *     RETIRED                                    REPLACED BY
 *     ─────────────────────────────────────────  ──────────────────────────────
 *     WinRM 5986 session to a Windows host       vCenter plug-in SDK connection
 *     win_tempfile / win_copy staging of         (nothing — no code is staged
 *       cvs_functions.ps1                          anywhere)
 *     PowerCLI VMware.VimAutomation.Core         VcPlugin / VcSdkConnection
 *     Connect-VIServer credential per vCenter    the vCenter endpoint credential
 *                                                  already registered in vRO
 *     Send-MailMessage on the Windows host       vRO Mail plug-in (EmailMessage)
 *     var_vCenterList hardcoded hostname list    VcPlugin.allSdkConnections
 *     Debug\result.html on the Windows host      reportHtml workflow output
 *
 *   Consequences worth stating to the customer: there is no longer a Windows
 *   host in the path of this report, no PowerCLI version to keep current on it,
 *   no second vCenter credential stored outside vRO, and no Kerberos second-hop
 *   requirement. The vCenter list is no longer a string that has to be edited
 *   when a vCenter is added or decommissioned — an unlisted vCenter is now
 *   impossible rather than merely unlikely.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE OUTPUT WILL NOT MATCH THE OLD REPORT — READ BEFORE PARALLEL RUN
 * ───────────────────────────────────────────────────────────────────────────
 *   A side-by-side comparison against the Ansible report WILL show differences,
 *   and every one of them is a defect fix rather than a regression. Expect:
 *
 *   1. MORE DATASTORES — usually MANY more. The old run only counted a
 *      datastore when uncommitted space exceeded free space, so a datastore at
 *      99% used with little thin-provisioned growth outstanding was never
 *      reported at all. That AND is gone; overcommit is now a column
 *      (Change-Register P-36).
 *   2. DUPLICATE NAMES NOW APPEAR. The old report piped each band through
 *      Sort-Object -Property Datastore -Unique, silently dropping any datastore
 *      whose NAME already appeared on another vCenter. Rows are now keyed on
 *      vCenter + MoRef (P-37).
 *   3. BOUNDARY DATASTORES NOW APPEAR. A datastore at exactly 90.00%, or
 *      between 89.99% and 90.00%, matched no band in the old logic and was
 *      shown nowhere. Bands are now half-open and gapless (P-34).
 *   4. NEW COLUMNS — Datacenter, Datastore Cluster, Type, Overcommitted.
 *   5. A STYLED REPORT. The old action emitted bare ConvertTo-Html -Fragment
 *      output with no stylesheet (P-39).
 *   6. A REPORT ARRIVES EVEN WHEN A vCENTER IS DOWN, and says so on its face.
 *      The old script aborted the entire run on the first unreachable vCenter
 *      and sent nothing at all (P-35, P-38).
 *
 *   Brief the recipients before the first scheduled send. The datastore COUNT is
 *   expected to rise sharply; that is previously-invisible scope becoming
 *   visible, not a sudden deterioration in the estate.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PREREQUISITES
 * ───────────────────────────────────────────────────────────────────────────
 *   - VCF Operations Orchestrator 8.11+ (validated on the VCF 9 embedded
 *     Orchestrator).
 *   - vCenter plug-in: every vCenter to be reported must be registered under
 *     Administration > vCenter Server, with a service account holding
 *     read-only at the root of each inventory. No write permission is needed
 *     or used.
 *   - Mail plug-in: reachable SMTP relay. Only needed when sendEmail is true.
 *   - NO PowerShell host. NO PowerCLI. NO WinRM. NO configuration elements.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PACKAGE CONTENTS
 * ───────────────────────────────────────────────────────────────────────────
 *   Module com.broadcom.pso.vc.storage.reporting
 *     - getDatastoreCapacity        (action)  per-vCenter inventory
 *     - buildDatastoreReportHtml    (action)  pure renderer
 *     - Get Datastore Capacity Report (workflow)
 *
 *   This package has NO dependency on any other package in the programme. It
 *   shares only the log-marker convention with the Snapshot Cleanup package.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WORKFLOW SCHEMA (as built)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * [Start]
 *     ▼
 * (item1) [Scriptable: ST-01 Initialise Run]                 ── root element
 *     validates thresholds and mail settings, stamps runId,
 *     resolves targetConnections
 *     OUT runId, startedAtIso, targetConnections,
 *         collectedJson="[]", failuresJson="[]", skippedJson="[]",
 *         outcome="RUNNING"
 *     ▼
 * (item2) [Scriptable: ST-02 Collect Datastores]
 *     loops targetConnections, calls action getDatastoreCapacity per vCenter
 *     inside a try/catch so one unreachable vCenter cannot end the run
 *     OUT collectedJson, failuresJson, skippedJson, scanSummaryJson
 *     ▼
 * (item3) [Scriptable: ST-03 Band and Sort]
 *     single source of truth for banding; also derives mailSubject and outcome
 *     OUT bandedJson, criticalCount, warningCount, advisoryCount,
 *         mailSubject, outcome
 *     ▼
 * (item4) [Scriptable: ST-04 Build Report]
 *     calls action buildDatastoreReportHtml
 *     OUT reportHtml
 *     ▼
 * (item5) [Decision: Send the report?   return (sendEmail == true)]
 *     ├─ true  → (item6) [Scriptable: ST-05 Send Report] ─┐
 *     └─ false ───────────────────────────────────────────┤
 *                                                         ▼
 *                                        (item7) [Scriptable: ST-06 Finalise]
 *                                                         ▼
 *                                                    (item8) [End]
 *
 * [Exception handler] (item99) [Scriptable: EH Exception Handler]
 *     bound to errorCode; writes any already-built report into the transcript
 *     so a late failure does not discard the inventory sweep
 *     → (item100) [End — failure]
 *
 *   NOTE ON THE DECISION ELEMENT: ST-05 also checks sendEmail internally and
 *   logs a SKIP line when it is false. The decision element exists so the
 *   schema shows the branch visually; the internal check means the task is also
 *   safe to run directly during testing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * INPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *   Name                 Type                    Default        Notes
 *   ──────────────────── ─────────────────────── ────────────── ─────────────────────────
 *   vCenterConnections   Array/VC:SdkConnection  (empty)        Empty = every vCenter
 *                                                               registered in Orchestrator.
 *                                                               Populate only to narrow a run.
 *   thresholdHighPct     number                  90             Floor of the Critical band.
 *   bandWidthPct         number                  10             Width of each band below it.
 *                                                               Reporting floor is
 *                                                               thresholdHighPct - 2 x this.
 *   includeInaccessible  boolean                 false          Report datastores vCenter
 *                                                               currently reports as
 *                                                               inaccessible.
 *   sendEmail            boolean                 true           False = build the report and
 *                                                               return it, send nothing.
 *   smtpHost             string                  (site relay)   Required when sendEmail.
 *   smtpPort             number                  25
 *   smtpUseSsl           boolean                 false
 *   smtpUsername         string                  (empty)        Empty = anonymous submission,
 *                                                               matching the current relay.
 *   smtpPassword         SecureString            (empty)
 *   mailFrom             string                  vro_Do_Not_Reply@<domain>
 *   mailTo               Array/string            (site list)    At least one address required
 *                                                               when sendEmail is true.
 *   mailCc               Array/string            (empty)        Optional. Blank entries are
 *                                                               stripped, not rejected.
 *   mailSubjectPrefix    string                  "VCF-Orchestrator-Report: Datastore Report"
 *
 *   THRESHOLDS ARE DERIVED, NOT INDEPENDENTLY ENTERED. Only the top of the range
 *   and the band width are configurable, so the bands cannot be made to overlap
 *   or invert by operator error. With the defaults the bands are
 *   Critical >= 90%, Warning 80-90%, Advisory 70-80%, matching the effective
 *   thresholds of the retiring script.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATTRIBUTES
 * ───────────────────────────────────────────────────────────────────────────
 *   runId              string                  DSR-YYYY-MM-DDTHH-MM-SS
 *   startedAtIso       string                  Human-readable start stamp
 *   targetConnections  Array/VC:SdkConnection  Resolved scan targets
 *   collectedJson      string                  Merged datastore records
 *   failuresJson       string                  vCenters that could not be scanned
 *   skippedJson        string                  Datastores that could not be read
 *   scanSummaryJson    string                  Run-level counters for the header
 *   bandedJson         string                  Banded + sorted rows
 *   mailSubject        string                  Derived in ST-03
 *   mailSent           boolean                 Set in ST-05
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUTPUTS
 * ───────────────────────────────────────────────────────────────────────────
 *   reportHtml     string   Complete HTML document, always produced
 *   outcome        string   COMPLETE | CLEAN_NO_FINDINGS | COMPLETE_WITH_GAPS | ERROR
 *   criticalCount  number
 *   warningCount   number
 *   advisoryCount  number
 *
 *   OUTCOME IS DELIBERATELY MORE GRANULAR THAN SUCCESS/FAILURE. A run that
 *   completed but could not reach one of five vCenters is not the same as a
 *   clean run and must not be reported as one. A scheduler or calling workflow
 *   should treat COMPLETE_WITH_GAPS as actionable.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SCHEDULING
 * ───────────────────────────────────────────────────────────────────────────
 *   Replaces the Ansible job template's schedule. Set defaults on the workflow
 *   Inputs tab, then create the recurring task under Orchestrator's Scheduler.
 *   The run is read-only and holds no lock, so overlapping runs are harmless —
 *   unlike Snapshot Cleanup, this workflow needs no mutex.
 */
