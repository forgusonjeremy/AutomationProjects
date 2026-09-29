# VMware Automation Delivery — Slide Outline

**Deck purpose:** brief the overall impact, then alternate — brief a project, demo it, brief
the next, demo it.
**Target length:** 47 slides. Seven DEMO slides are holding slides the presenter leaves up
while switching to the live system.
**Audience:** customer stakeholders — mixed business and technical.

**Design intent:** every project follows the identical three-beat rhythm — *What was* → *What
is* → *Demo*. Keep that visual pattern consistent across all seven so the audience learns the
structure and can anticipate it.

**Session shape:** open with the one thing that is entirely new (VM provisioning), then spend
the rest on what already existed — and how much of it was quietly broken.

---

# SECTION 1 — OVERVIEW

## Slide 1 — Title

**VMware Automation Delivery**
Ansible → VCF Orchestrator Transition, and Self-Service VM Provisioning

*Notes: Opening. Set expectations — brief, demo, brief, demo. Seven projects this session.*

---

## Slide 2 — Two workstreams

- **Ansible → Orchestrator transition** — migrating existing automation off Ansible, and hardening it on the way through
- **VM Deployment Automation** — net-new self-service VM provisioning on VCF 9.1

*Notes: One replaces automation. One replaces manual work. Different starting points, same platform.*

---

## Slide 3 — By the numbers

- **24** Ansible playbooks and job templates → **8** Orchestrator workflows
- **1** net-new capability — the self-service VM catalog
- **24** hardening changes to the shared PowerShell toolbox
- **15+** pre-existing defects found and fixed
- **447** automated regression checks, all running offline

*Notes: Lead with consolidation, land on the defects — that's the pivot into the next slide.*

---

## Slide 4 — What was delivered

| Project | Was | Is |
|---|---|---|
| VM Deployment Automation | *manual builds* | 4 catalog items — net-new |
| Server Reboot Report | 2 playbooks | 1 workflow |
| Admin Accounts Report | 3 templates, 2 on a forked script | 1 workflow |
| Service Account Expiration | 1 template | 1 workflow *(in progress)* |
| Move Windows Event Logs | 7 playbooks | 2 workflows |
| Windows Server Clean Disks | 8 templates | 1 workflow |
| Server Reboots | 1 playbook | 1 workflow |
| Snapshot Cleanup | 2 playbooks — one a duplicate | 1 workflow *(demonstrated previously)* |

*Notes: Don't read it out. Let the right column do the work. Snapshot Cleanup stays on this slide because it was delivered — it just isn't being demonstrated again today.*

---

## Slide 5 — This was not a lift-and-shift

**Every process was migrated *and* hardened.**

The transition surfaced 15+ defects in automation running in production today.

They share one failure mode:

> **An error, an omitted parameter, or a missing column removes content or skips work —
> and the run still reports success.**

*Notes: This is the spine of the deck. Every transition project after the opening demo is an instance of it.*

---

## Slide 6 — What that looked like in practice

- Servers were **force-rebooted** when their state **could not be read**
- **Failed reboots** looked identical to successful ones
- An **unreadable OU** in a compliance report looked exactly like a **compliant** one
- A report titled *"Service Account Expiration"* **never showed an expiration date**
- A **"safe preview" mode** that silently did nothing

*Notes: Pause after each. These are the findings that justify the engagement.*

---

## Slide 7 — Everything is now visible

Each of those now produces:

- A **classified error line** the workflow can act on
- A **structured end state** — Completed / Completed with Errors / Failed
- A **flag on the emailed report** itself
- Or a run that **fails outright and says what was missing**

*Notes: The common platform gives every workflow the same failure vocabulary.*

---

## Slide 8 — The work compounds

- One shared toolbox, one invocation contract, one output classifier, one report layer
- The two AD reports look and behave like **one product**, not two scripts
- The second was **substantially cheaper** to build than the first

*Notes: Argument for the programme approach over per-playbook ports.*

---

## Slide 9 — Running order

**The new capability first — then the transition work, escalating by risk**

1. **VM Deployment Automation** — what didn't exist before
2. Server Reboot Report — read-only
3. Admin Accounts Report
4. Service Account Expiration
5. Move Windows Event Logs
6. Windows Server Clean Disks — first destructive action
7. Server Reboots — most destructive

*Notes: Snapshot Cleanup was demonstrated previously and isn't repeated. Also: Orchestrator and Ansible use separate PowerShell hosts in dev and production — nothing demonstrated today can disturb a running Ansible job.*

---

# SECTION 2 — PROJECT 1: VM DEPLOYMENT AUTOMATION

## Slide 10 — Self-Service VM Provisioning

**Net-new. Replaces manual, ticket-driven builds.**

VCF 9.1 — Service Broker catalog, Orchestrator customization.

---

## Slide 11 — What was

**A ticket, a build queue, and a runbook.**

- Delivery gated by engineer availability
- **Configuration drift** between machines built by different people at different times
- Rework after handover
- No audit trail beyond the ticket

---

## Slide 12 — What is — four catalog items

| Item | Deploys |
|---|---|
| **Windows 2025 — Domain Join** | Domain-joined or workgroup Windows VM, fully customized |
| **Windows 2025 — Data Disks + Domain Join** | The same, plus up to 10 data disks — each with size, controller, drive letter, label |
| **Linux Shell** | Prepared VM shell with install media attached |
| **Linux Shell — Data Disks** | The same, plus data disks |

**The form populates itself from the live environment** — vCenter, cluster, network, folder,
OS version, ISO media, and the AD OU list.

---

## Slide 13 — What gets automated

**Windows, end to end:** waits for genuine guest readiness → moves the CD-ROM drive letter →
renames the built-in administrator → sets its password → initializes, formats and mounts each
data disk, **matched by disk UUID**.

**Domain join, driven explicitly:** the requester picks an OU **scoped to their own project's
subtree**. The computer account is pre-created there; the OS join doesn't override it. A
destroy-time workflow removes the object.

**On failure the platform destroys the VM** — no half-built machines.

---

## Slide 14 — How it enhances what was

| | Before | Now |
|---|---|---|
| Delivery | A ticket in a queue | Minutes, self-service |
| Consistency | Depends who built it | Same standard every time |
| Data disks | Manually initialized and lettered | Automatic, matched by UUID |
| AD placement | Manual, or wherever the default sends it | Chosen from a scoped list, pre-created |
| Cleanup | Stale computer objects accumulate | Removed on destroy |
| Failure | A half-built VM to unpick | Destroyed automatically |
| Audit | The ticket | Full run history |

---

## Slide 15 — A supportability decision worth showing

**The per-project AD OU is not exposed by any supported API.**

An internal, undocumented endpoint was found that returns it. **It works.**

**It was rejected for production use** — an internal service can change without notice.

Instead: the administrator sets the OU as a **project custom property**, and the picker
enumerates beneath it. It **fails closed** — unset means it returns nothing, rather than
exposing the whole directory.

*Notes: A deliberate trade of convenience for supportability, with the reasoning recorded.*

---

## Slide 16 — DEMO

**Self-Service VM Provisioning** — end to end, live

- The catalog, and a request form **populated from the live environment**
- Two data disks specified, and an **AD OU dropdown scoped to this project only**
- Provisioning → event → customization workflow
- **Log into the finished VM:** admin renamed, disks online on the requested letters and labels, domain-joined **in the OU picked on the form**

*Notes: This opens the session and sets the standard everything after is measured against — give it room. Provisioning takes real time: start the request, talk over it using slides 12–15, then return to the finished VM. Close by destroying the deployment and showing the AD computer object removed with it.*

---

# SECTION 3 — PROJECT 2: SERVER REBOOT REPORT

## Slide 17 — Server Reboot Report

**Which servers in this group have a pending reboot?**

Read-only. No reboot path exists to misfire.

---

## Slide 18 — What was

**Two playbooks doing one job — a lab variant and a production variant**

- Production used a **non-recursive, unfiltered** lookup — servers in nested groups were **silently missing**
- Users and disabled computer objects appeared as **noise rows**
- An empty CC list **failed every emailed report in the toolbox**
- The result file **grew on every run** — an unbounded drive-fill risk

*Notes: The CC defect is the one to dwell on — it wasn't scoped to this report.*

---

## Slide 19 — What is

**One workflow — *Get Server Reboot Report***

- Both variants on **one hardened resolver** — recursive, enabled computers only
- Recursion is correct **here** because the report is read-only — expanding a nested group only completes the picture
- **CC genuinely optional** — fixes emailed reports across the toolbox
- Report files **overwritten, then deleted after confirmed send**
- Every log line stamped with workflow name and run ID

*Notes: Flag the risk — the reported set changes. Review group membership before cutover.*

---

## Slide 20 — DEMO

**Server Reboot Report**

- The custom form — few inputs, host pre-bound
- A disabled object being **skipped and logged**
- The emailed HTML report

*Notes: Closing line — with no CC configured, the old code would have failed to send at all.*

---

# SECTION 4 — PROJECT 3: ADMIN ACCOUNTS REPORT

## Slide 21 — Admin Accounts Report

**Which privileged accounts sit outside PKI enforcement?**

Read-only compliance reporting across every domain and OU in scope.

---

## Slide 22 — What was

**Three job templates — two of them on a *forked copy* of the shared script**

- The fork was the **only** source of the multi-domain report — and predated every hardening change
- **Silent partial sweeps** — a bad OU, dead DC or broken trust raised an error nobody saw
- A partial sweep reported as a clean run — **and the missing accounts read as compliant**
- **Overlapping OUs inflated the counts**
- One flat table; the reader had to infer each row's domain

*Notes: "A failed OU produces no rows — which looks exactly like a compliant OU."*

---

## Slide 23 — What is

**One workflow — *Get-AdminAccountsReport*.** The fork is retired.

- Failures rendered **on the report** — banner, `NOT READ` flags, **`[INCOMPLETE]` subject prefix**
- Failures **classified** — scope error / access denied / authentication / unreachable — with remediation guidance
- **Management-readable** — executive summary → per-domain status → per-OU detail
- Sections driven by **requested scope, not returned data** — an empty OU still gets a heading
- Overlapping OUs **de-duplicated before the counts are taken**

*Notes: Scope problem fails the run outright. Per-OU problem completes with errors and still delivers a report naming what's missing.*

---

## Slide 24 — Why classification matters

**"A referral was returned" and "the server is not operational" look equally opaque — and are entirely different problems.**

- A **referral means the server answered** — the naming context isn't its own. A **targeting** fault. Deterministic. Fixed by correcting the OU list.
- **Not operational** is an **availability** fault. May clear by itself.

**Retrying helps the second and never the first.**

*Notes: Strong slide for a technical audience. Cut if the room is purely business.*

---

## Slide 25 — DEMO

**Admin Accounts Report** — runs entirely offline

- Clean report — summary → per-domain → per-OU
- **Incomplete report** — banner, NOT READ flags, `[INCOMPLETE]` subject
- Duplicates report — what was collapsed, and why totals are now correct
- 191 offline regression checks

*Notes: Money moment — under the old report, the incomplete run would have looked completely clean.*

---

# SECTION 5 — PROJECT 4: SERVICE ACCOUNT EXPIRATION

## Slide 26 — Service Account Expiration Report

**Which service accounts have expired — and which expire soon?**

*In progress: code, tests and documentation complete; lab validation outstanding.*

---

## Slide 27 — What was — four silent defects

**Three of them mean the report received today is not the report believed to be received.**

| # | Defect | Consequence |
|---|---|---|
| 1 | An omitted parameter defaulted to a filter | **Every smart-card service account missing from every report ever produced** |
| 2 | Expiration date queried, never displayed | A report showing **password age and no expiry date** |
| 3 | A password never set reported as age `0` | Worst accounts sorted to the **bottom** |
| 4 | Unassigned variable appended | A **blank row** on every report |

*Notes: Defect 1 is the headline of the entire programme. Nothing in the output indicated a filter had been applied.*

---

## Slide 28 — What is

**One workflow — *Get-ServiceAccountExpirationReport***

- **The report finally reports expiration** — `Expires on` and `Days to expiry`
- **Complete scope** — smart-card accounts no longer silently excluded
- **New: a look-ahead window** — drives an *Action required* block and subject-line counts
- **Actionable from the inbox** — expired and expiring lifted above the inventory, counts in the subject
- **A trustworthy empty report** — "nothing is expiring" and "the query never ran" are now distinguishable

*Notes: Reuses the shared functions from the Admin Accounts Report — same product, cheaper to build.*

---

## Slide 29 — Before first scheduled send

- **The account count will RISE** — possibly substantially
- That is **defect 1 being corrected**, not a scope expansion or a directory change
- **Recipients must be briefed**, or it reads as something changing in AD
- **Inbox rules will stop matching** — the subject now carries counts

*Notes: This needs customer sign-off. Don't let it slip past the demo.*

---

## Slide 30 — DEMO

**Service Account Expiration** — runs entirely offline

- Clean report — *Action required* above the inventory, expiry columns present
- No-findings report — nothing expiring, said explicitly
- Incomplete report — degraded-run treatment
- 256 offline checks

*Notes: 21 of those checks read the shipping source, not behaviour — because re-introducing defect 1 would pass every behavioural test. Some regressions are invisible to behavioural testing.*

---

# SECTION 6 — PROJECT 5: MOVE WINDOWS EVENT LOGS

## Slide 31 — Move Windows Event Logs

**Offload archived Windows event logs to a central share — and keep that share clean.**

---

## Slide 32 — What was

**Seven playbooks**

- The **"safe preview" mode did not work** — it asked for keyboard confirmation where nothing is at a keyboard
- **Three near-duplicate targeting variants**, plus a local-host special case
- An **unreachable source failed invisibly**
- **Disabled members** handed into the move loop, erroring one at a time
- Hardcoded file filter and age

---

## Slide 33 — What is

**Two workflows — move, and archive-share cleanup**

- **Report-only actually works** — and it's the default
- **One targeting method** — three variants and the local-host case collapse into one
- **Unreachable sources visible**; **disabled members skipped and logged**
- One failure is skipped; the remaining moves continue
- Fully parameterised — domain, group, paths, filter, age

*Notes: Also delivered — the reusable PowerShell Host build guide. Live bring-up found that the WinRM HTTPS listener was never actually being created, while the script printed a false success message.*

---

## Slide 34 — DEMO

**Move Windows Event Logs**

- Source servers populated, archive share empty
- Group resolved — a **disabled member skipped with a logged reason**
- Archive share — per-server subfolders, files moved
- Cleanup in **preview** — lists, deletes nothing — then live

*Notes: Money moment — on the current automation this preview could not run at all. It stopped and waited for a keypress.*

---

# SECTION 7 — PROJECT 6: WINDOWS SERVER CLEAN DISKS

## Slide 35 — Windows Server Clean Disks

**Free disk space across a group of Windows servers — safely.**

First destructive workflow of the session.

---

## Slide 36 — What was

**Eight job templates — six cache cleanup, two user profiles. Same action, different inputs.**

- **No dry run. The action always deleted.**
- **Silent failures** — an unreachable server raised an error nobody saw. **The run looked clean.**
- **Unfiltered targeting** — users and disabled objects, erroring one by one
- A **negative** number-of-days input
- Four near-identical copies of the delete logic

---

## Slide 37 — What is

**One workflow — *Clean-ServerDisks-ByADGroup*. Report-only by **default**.**

- Preview lists what *would* be deleted, deletes nothing. An invalid value **fails safe**
- Unreachable server → logged error, loop continues, run ends **Completed with Errors**
- **Direct, enabled computers only** — nested groups never silently expanded into a destructive action
- Positive "older than N days"
- **Per-server *and per-item* isolation**
- One code path shared by preview and live run — they **cannot diverge**

*Notes: Non-recursive deliberately. Deleting is destructive — only what an operator placed directly in the group is a target.*

---

## Slide 38 — DEMO

**Windows Server Clean Disks**

- The form — `whatIf` **already set to report-only**
- Preview run → target folder **untouched**
- Unreachable server → logged, loop continues, **Completed with Errors**
- Live run → aged files gone, recent and preserved files still there

*Notes: Money moment — on the current automation there was no way to preview. It always deleted. And the unreachable-server run would have reported a clean success.*

---

# SECTION 8 — PROJECT 7: SERVER REBOOTS

## Slide 39 — Server Reboots

**Reboot only the servers actually reporting a pending reboot — and confirm they came back.**

Physical and virtual alike. The most destructive workflow in the set.

---

## Slide 40 — What was — the most serious findings

| Defect | Effect today |
|---|---|
| The pending test asked *"is this not False?"* — **also true when the state could not be read** | A server whose state **could not be determined** was **force-rebooted** |
| Reboot failures raised no error the code was watching for | **Failed reboots were indistinguishable from successful ones** |
| A path bug meant the pre-reboot step **never ran** | It has **never executed** — and the server was rebooted anyway |
| A shared helper returned "failed" on success | A working prerequisite reported unavailable — **affects every caller** |

**Plus: unfiltered targeting, no reboot confirmation, and no report of any kind.**

---

## Slide 41 — What is

**Rebooted only when *all* are true:**

1. **Direct, enabled computer member** of the target group
2. **Reports a pending reboot** — CBS, Windows Update, or SCCM
3. The run is in reboot mode

**Servers whose state cannot be read are skipped, never rebooted.**

- Every reboot **verified back online** within a timeout, or reported failed
- Failed reboots **detected and reported**
- **Per-server HTML report, emailed** — there was previously none at all

---

## Slide 42 — The security decision

**The optional pre-reboot script weakens protections on the USB storage driver definition and the Terminal Services component.**

- Because of the path bug, **it has never executed**
- Fixing that bug alone would have **silently started applying** those changes to every rebooted server
- A security change arriving as a **side effect of a bug fix**

**Now opt-in, default OFF — so default behaviour matches today exactly.**

*Notes: Needs a security review, or a decision to retire it. Its naming suggests it dates to Windows 2000.*

---

## Slide 43 — DEMO

**Server Reboots**

- One server flagged pending, one not
- **Only the flagged server reboots** — the healthy one is left alone
- Post-reboot verification confirms it returned
- The emailed per-server report

*Notes: Money moment — point at a server whose state cannot be read. Show it skipped and reported. Then say: in production today, that server would have been force-rebooted, precisely because nobody could tell whether it needed it.*

---

# SECTION 9 — CLOSING

## Slide 44 — The pattern behind the findings

> **An error, an omitted parameter or a missing column removes content or skips work —
> and the run still reports success.**

- An unreadable reboot state looked like "pending" → force-rebooted
- A failed reboot looked like a successful one
- An unreachable server during disk cleanup looked like a clean run
- An unreadable OU looked like a compliant OU
- An omitted parameter excluded every smart-card account from a report
- An empty CC list quietly failed **every** emailed report
- A "safe preview" that silently did nothing

---

## Slide 45 — Why the test suites read the source

**Several of these defects are invisible to behavioural testing.**

A report that quietly omits a category of account **passes every test that never asks for
that category**.

That is why the later deliverables assert against the **shipping source**, not just the
output.

---

## Slide 46 — Where this leaves the estate

- **Manual work removed at both ends** — builds are self-service, maintenance is scheduled and verified
- **One shared toolbox** — so the next deliverable is cheaper than the last
- **Decisions recorded, not just made** — including where the convenient option was deliberately rejected

---

## Slide 47 — Open decisions

| Decision | Project |
|---|---|
| **Pre-reboot script** — security review, or retire? Currently off by default | Server Reboots |
| **Brief recipients that the account count will rise** | Service Account Expiration |
| **Review inbox rules** — subject lines changed | Both AD reports |
| **Service-account exemptions** — no allow-list exists | Both AD reports |
| **Password expiry vs password age** — a different, more useful metric; not yet implemented | Service Account Expiration |
| **Confirm group membership** before cutover to the recursive resolver | Server Reboot Report |

*Notes: Close here. These need customer decisions, not just acknowledgement.*
