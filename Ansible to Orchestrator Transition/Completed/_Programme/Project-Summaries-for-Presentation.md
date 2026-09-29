# VMware Automation Delivery — Briefing & Demo Pack

**Format this pack is built for:** one overall impact brief, then for each project a short
brief (*what was* → *what is*) immediately followed by a live demo of that workflow, then
on to the next project.

Each project section is therefore laid out in exactly three blocks:

| Block | Purpose |
|---|---|
| **What was** | The process as it exists today — what it did, and what was wrong with it |
| **What is** | The delivered capability, and specifically how it improves on what was |
| **Demo** | What to show, in what order, and the moment that lands the point |

---

# Part 1 — Overview: everything created

## The two workstreams

| | Workstream | Nature |
|---|---|---|
| **A** | **Ansible → VCF Orchestrator transition** | Migrating the customer's existing automation off Ansible — and hardening it on the way through |
| **B** | **VM Deployment Automation** | Net-new self-service VM provisioning and guest customization on VCF 9.1 |

## Headline numbers

| | |
|---|---|
| **Automation processes transitioned** | **24 Ansible playbooks / job templates → 16 Orchestrator workflows** |
| **Net-new capability delivered** | **1** — a self-service VM provisioning catalog (4 catalog items) |
| **Shared PowerShell toolbox** | **24 hardening changes** (S-1 … S-24) |
| **Pre-existing defects found and fixed** | **At least 15**, all silent — every one of them reported success |
| **Divergent script copies eliminated** | A forked second copy of the shared toolbox merged back and retired |


## What was delivered, by project

| # | Project | Was | Is |
|---|---|---|---|
| 1 | **VM Deployment Automation** | *nothing — manual ticket-driven builds* | Self-service catalog, 4 items **(net-new)** |
| 2 | **Server Reboot Report** | 2 Ansible report playbooks | 1 read-only workflow |
| 3 | **Admin Accounts (PKI) Report** | 3 job templates, 2 of them on a forked script | 1 workflow, one shared script |
| 4 | **Service Account Expiration Report** | 1 job template | 1 workflow *(in progress)* |
| 5 | **Move Windows Event Logs** | 7 playbooks | 2 workflows |
| 6 | **Windows Server Clean Disks** | 8 job templates | 1 workflow |
| 7 | **Server Reboots** | 1 playbook | 1 workflow |

## The three messages worth making up front

**1. This was not a lift-and-shift.** Every process was migrated *and* hardened. The
transition surfaced at least 15 pre-existing defects in automation that is running in
production today — and they share a single failure mode:

> **A non-terminating error, an omitted parameter, or a missing column removes content or
> skips work — and the run still reports success.**

Concretely: servers were being force-rebooted when their state *could not be read*; failed
reboots looked identical to successful ones; an unreadable OU in a compliance report looked
exactly like a compliant one; and a report titled *"Service Account Expiration"* never
rendered an expiration date.

**2. Everything is now visible.** Each of those becomes a classified error line, a
structured end state, a flag on the emailed report, or a run that fails outright and says
what was missing. The common platform gives every workflow the same failure vocabulary.

**3. The work compounds.** The deliverables share a toolbox, a script-invocation contract,
an output classifier and a report-rendering layer. The two AD reports look and behave like
one product rather than two separately-written scripts — and the second was substantially
cheaper to build than the first.

## Suggested running order for the session

**Open with the new capability, then the transition work in escalating order** — read-only
first, then file operations, then destructive.

| Order | Project | Why here |
|---|---|---|
| 1 | **VM Deployment Automation** | Opens strong — the most visual demo, and the one thing that is entirely new rather than an improvement on something existing |
| 2 | Server Reboot Report | First transition project; simplest, and establishes the common pattern the rest reuse |
| 3 | Admin Accounts Report | Same pattern, richer output — the report-quality story |
| 4 | Service Account Expiration | Strongest defect story; visibly the same product as #3 |
| 5 | Move Windows Event Logs | Moves to acting on servers, not just reading them |
| 6 | Windows Server Clean Disks | First destructive action — introduces the safety gate |
| 7 | Server Reboots | Most destructive; the biggest safety story of the programme |


**The shape of the session:** open by showing what did not exist before, then spend the rest
of it on what did — and how much of it was quietly broken.

**A note that applies to every demo:** Orchestrator and the existing Ansible automation use
**separate PowerShell hosts in both development and production**. Nothing demonstrated here
can disturb a running Ansible job, and there is no cross-team deployment sequencing to
coordinate.

---

# Part 2 — Project briefs and demos

---

## 1. VM Deployment Automation

### What was

**Nothing automated — this replaces a manual, ticket-driven build process.** A user raised a
request; a platform engineer built the VM by hand; configuration consistency depended on
whoever did it and how carefully they followed the runbook.

The cost of that: slow delivery, configuration drift between machines built by different
people at different times, rework after handover, and no audit trail beyond the ticket.

### What is

A **Service Broker catalog** on VCF 9.1 that lets authorized users deploy fully customized
Windows and Linux VMs on demand, each configured to a consistent standard automatically,
immediately after provisioning.

**Four catalog items:**

| Catalog item | What it deploys |
|---|---|
| **Windows Server 2025 — Domain Join Support** | A domain-joined (or workgroup) Windows VM, fully customized |
| **Windows Server 2025 — With Data Disks and Domain Join Support** | The same, plus up to 10 data disks — each with its own size, SCSI controller, drive letter, label and provisioning type |
| **Linux Shell** | A prepared Linux VM shell with installation media attached, ready for OS install |
| **Linux Shell — With Data Disks** | The same, plus additional data disks |

The request form is **populated live from the environment** rather than hand-typed —
vCenter, cluster, network, VM folder, OS version, available ISO media, and the Active
Directory OU list are all driven by Orchestrator actions.

**How it works:** the user requests a catalog item; VCF Automation provisions the VM and
fires a post-provision event; a subscription routes that event by OS type to the right
Orchestrator workflow, which customizes the machine. On success the VM is handed back ready
to use. **On failure the platform destroys the VM** — no half-built machines left behind.

**Windows** is customized end to end: waits for the guest to be genuinely ready, moves the
CD-ROM drive letter out of the way, renames the built-in administrator account, sets its
password, then initializes, formats and mounts each data disk — **matched by disk UUID**, so
the right disk always gets the right letter and label.

**Linux** prepares a shell for installation from media: attaches the ISO and reshapes the
boot disk to blank.

**Domain join** is driven explicitly. The requester picks an OU from a dropdown **scoped to
their own project's subtree** — never the whole directory. The computer account is
pre-created in that OU, and the OS join is performed without overriding it, so the picked OU
is the single source of truth. A destroy-time workflow removes the computer object so stale
accounts don't accumulate.

### How it enhances what was

| | Before (manual) | Now |
|---|---|---|
| **Delivery time** | A ticket in a build queue | Minutes, self-service |
| **Consistency** | Depends who built it | Every VM customized to the same standard |
| **Data disks** | Manually initialized, formatted and lettered in the guest | Automatic, matched by UUID |
| **AD placement** | Manual, or wherever the default sends it | Chosen from a scoped list, pre-created, verified |
| **Cleanup** | Stale computer objects accumulate | Removed on destroy |
| **Failure** | A half-built VM someone has to unpick | Destroyed automatically |
| **Audit** | The ticket | Full run history in VCF Automation and Orchestrator |
| **Engineer time** | Routine builds | Freed for higher-value work |

### Engineering depth — worth a slide for a technical audience

Each of these is a real platform behaviour that breaks a naïve implementation:

- **A blank VM never reaches the post-provision event.** The platform waits for a guest
  readiness signal that a machine with no OS never sends — so the Linux pipeline could never
  be triggered at all. Solved by deploying a throwaway template to satisfy the gate, then
  reshaping the VM.
- **Windows reports disk identifiers in a different format than vSphere does.** Both sides
  are normalized before matching, so disks are identified reliably rather than by ordering.
- **Disk operations fail silently without a template prerequisite.** A pre-flight assertion
  gates execution, so the run fails with a clear cause instead of misbehaving later.
- **The platform's own customization blanks the local administrator password** during
  sysprep on linked-clone deployments. The password is set explicitly afterwards.
- **VCF Automation 9 authentication is not the 8.x flow** — the documented 8.x login fails
  outright. Also: a token with rotation enabled is single-use and **breaks a form that
  populates itself**, so a non-rotating token is required.

### Supportability — a decision worth showing

**The per-project AD OU is not exposed by any supported API.** An internal, undocumented
endpoint was found that returns it, and it **works** — and it was **rejected for production
use**, because it is an internal service that can change without notice.

The delivered design instead has the administrator set the project's base OU as a **project
custom property** — one place, supported, stable — and the picker enumerates the subtree
beneath it. The action **fails closed**: if the property is unset it returns nothing, rather
than exposing the whole directory.

This is a deliberate trade of convenience for supportability, with the reasoning recorded.
The same principle governs the rest of the solution: officially documented APIs only.

### Demo

**This opens the session** — the most visual demo of the set, run live end to end. It sets
the standard everything after it is measured against, so give it room.

**A practical note:** the deployment takes real time to provision. Start the request, then
talk over it — the architecture, the four catalog items, the platform behaviours on the
following slides — and return to the finished VM. Don't watch it in silence.

1. **Open the Service Broker catalog** as a requesting user. Show the four items.
2. **Open the Windows-with-data-disks request form.** This is where the polish shows:
   - The vCenter, cluster, network and folder dropdowns are **populated from the live
     environment**.
   - Add two data disks, each with its own size, drive letter, label and provisioning type.
   - Open the **AD OU dropdown** and point out that it shows **only OUs inside this
     project's subtree** — not the whole directory.
3. **Submit, and talk over the provisioning** — the post-provision event, the subscription
   routing by OS type, and the customization workflow running as a blocking task.
4. **Show the Orchestrator run** in flight: the guest-readiness wait, then the four
   customization steps in sequence.
5. **Log into the finished VM.** This is the payoff:
   - The administrator account is **renamed** to the standard name.
   - The CD-ROM is **out of the way**.
   - Both data disks are **online, formatted, and mounted on the requested drive letters
     with the requested labels** — the right disk on the right letter.
   - The machine is **domain-joined, in the OU that was picked on the form**. Show the
     computer object sitting there in AD.
6. **Optionally, run the Linux shell item** and show it boot straight to the installer from
   the attached ISO.
   **Say:** this pipeline exists at all only because of the guest-readiness workaround — a
   blank VM never reaches the trigger.
7. **Close by destroying the deployment** and showing the AD computer object removed with it.


---

## 2. Server Reboot Report

### What was

Two Ansible report playbooks doing the same job in two different ways — a lab variant and a
production variant. Both were read-only: resolve an AD security group, check each member's
pending-reboot state over WMI/registry/SCCM, and email an HTML report.

**What was wrong with it:**

- **The production variant used a non-recursive, unfiltered lookup.** Servers sitting in a
  nested sub-group were **silently missing from the report**, and users and disabled
  computer objects were included as noise rows.
- **An empty CC list broke the email entirely.** The mail routine always passed a `-Cc`
  argument; with no CC configured it passed a single blank recipient, which the mail cmdlet
  rejects outright. This **failed every emailed report in the toolbox**, not just this one.
- **The result file was written in append mode** and grew on every scheduled run — an
  unbounded drive-fill risk on the PowerShell host, with no guarantee that any cleanup job
  existed.
- Two playbooks to maintain for one question.

### What is

**One read-only workflow — *Get Server Reboot Report*** — that answers "which servers in
this group have a pending reboot?" with no Ansible dependency.

| Enhancement | What it fixes |
|---|---|
| **Both variants consolidated onto one hardened resolver** | The lookup is now **recursive**, and filtered to enabled computer objects only. Nested groups are expanded; users and disabled objects are dropped. Production reporting no longer silently misses servers |
| **Recursion is the *right* choice here — deliberately** | Expanding a nested group on a **read-only** report only makes the picture more complete. The reboot workflow stays deliberately non-recursive, because *acting* on a silently-expanded group is a different risk entirely |
| **CC is genuinely optional** | Blank entries are dropped before the mail is built. Fixes emailed reports across the whole toolbox |
| **Report files no longer accumulate** | Written with overwrite instead of append, and **deleted after a confirmed successful send**. On a report-only run or a failed send the file is kept — at one run's size — and a warning is logged |
| **Input hygiene** | The report header is derived from the group DN rather than being a second input that can disagree with it; recipients are accepted as either a list or a comma-separated string; a malformed address is rejected with a clear error instead of being silently split into single characters |
| **Traceability** | Every log line in the run is stamped with the workflow name and run ID |

**Risk to state plainly:** moving production onto the recursive filtered resolver **changes
the reported set**. It is a strict improvement for a report, but group membership should be
reviewed before cutover.

### Demo

1. **Open the workflow's custom form.** Point out how few inputs there are — group DN, mail
   settings — and that the PowerShell host is pre-bound as a workflow attribute rather than
   being a per-run choice.
2. **Run it against the lab group.** Let it complete.
3. **Show the run log.** Point out the log marker on every line, and the per-server
   resolution lines — including a **disabled or non-computer object being skipped and
   logged**, which the old production report would have handed straight into the check.
4. **Open the emailed HTML report.**
5. **The moment that lands it:** state that if this same run had been configured with no CC
   address, the old code would have **failed to send at all** — and that this was true of
   every emailed report the toolbox produced.

*Optional, if a lab server is available:* use `lab/Set-PendingRebootFlag.ps1` to flag a
server as pending beforehand, so the report has a genuine finding to show rather than an
empty list.

---

## 3. Admin Accounts Report

### What was

**Three** Ansible job templates producing a privileged-account PKI compliance report — which
admin accounts do **not** require a smart card to log on. Two were multi-domain; one was
single-OU.

**What was wrong with it:**

- **The two multi-domain templates ran on a *forked copy* of the shared script.** That fork
  was the only place the multi-domain capability existed — and it predated **every**
  resilience improvement made during this transition. Two divergent copies of a shared
  toolbox were being maintained indefinitely.
- **Silent partial sweeps.** The AD query had no error handling. A bad OU DN, an unreachable
  domain controller or a broken trust raised a **non-terminating** error nobody saw — so a
  partial sweep was reported as a clean run, **and the missing accounts read as compliant**.
- **A failed OU produces no rows — which looks exactly like a compliant OU.** The people who
  act on this report read the email, not a console.
- **Overlapping OUs inflated the figures.** AD searches are fully recursive, so listing both
  a parent OU and a descendant returned the deeper accounts twice.
- One flat table merging every domain, forcing the reader to infer a row's domain from its
  email-address suffix.

### What is

**One workflow — *Get-AdminAccountsReport*** — replacing all three templates. Strictly
read-only: it issues directory queries and sends an email; it cannot modify anything.

The operator supplies a **flat list of OU distinguishedNames** and the domain is derived
from each DN itself. Single-domain versus multi-domain stops being a mode anyone selects —
it falls out of the DNs supplied.

| Enhancement | What it fixes |
|---|---|
| **The fork is retired** | Its capability merged into the hardened mainline. One shared script again — no more fixes landing in only one copy |
| **Failures are visible on the report** | A leading banner, a per-OU `NOT READ` flag, and an **`[INCOMPLETE]` prefix on the subject line**. An unread OU can no longer masquerade as a compliant one |
| **Failures are explained, not just reported** | Each is classified — *scope error / access denied / authentication / unreachable* — with guidance on who fixes it. A **referral means the server answered** and said the naming context isn't its own: a deterministic targeting fault fixed by correcting the OU list. "Not operational" is an availability fault that may clear itself. **Retrying helps the second and never the first** |
| **Management-readable output** | Executive summary → per-domain sections with a plain-language status → per-OU sub-sections. Answers *"which domain and OU are worst?"* without reading the whole table |
| **Sections driven by the requested scope, not the returned data** | An OU that returned nothing still gets a heading saying so — rather than silently vanishing |
| **Counts can be trusted** | Overlapping OUs de-duplicated to one entry per account, **before the counts are taken**, so subject line and body cannot disagree |
| **Failure contract** | A **scope** problem fails the run outright — nothing can be trusted. A **per-OU** problem completes with errors and still delivers a report that names what is missing |

**Expect counts to drop slightly on the first run** if the OU list overlaps. That is the
de-duplication correcting an inflated figure — not a regression.

### Demo

This one demos well **entirely offline** — the rendered sample reports need no lab.

1. **Open `lab/Sample-Report-Clean.html`.** Walk down it: executive summary → per-domain
   status → per-OU detail. Contrast with the old single flat table.
2. **Open `lab/Sample-Report-Incomplete.html`.** This is the money moment. Show the banner,
   the `NOT READ` flags, the **`[INCOMPLETE]` subject prefix**, and the classified failure
   table with its *Problem* and *What to do* columns.
   **Say:** under the old report, this exact run would have looked **completely clean** —
   the unread OU would simply have contributed no rows.
3. **Open `lab/Sample-Report-Duplicates.html`.** Show the informational notice explaining
   what was collapsed and why the totals are now correct.
4. **Run the workflow live** against the lab OUs and show it routing to *Completed* or
   *Completed with Errors* accordingly.
5. **Optional closer — `lab/Run-AllTests.ps1`.** Run the offline suite in front of them.
   191 checks, no infrastructure required. Mention that it caught two silent-content defects
   before delivery — in one, **every styled table evaluated to nothing** and the report still
   sent, still looking well-formed, having quietly lost its content.

---

## 4. Service Account Expiration Report

### What was

One Ansible job template reporting on service accounts in an OU, so accounts approaching
expiry get renewed before the services depending on them stop working.

**What was wrong with it — and this is the strongest single item in the programme.** Four
defects, all silent, every run reporting success. **Three of them mean the report the
customer receives today is not the report they believe they are receiving:**

| # | Defect | Consequence |
|---|---|---|
| **1** | An **omitted parameter**. Because it was declared as a boolean, omitting it bound it to `false` rather than leaving it unset — which also made the intended "return everything" branch beneath it **unreachable dead code**. Every run silently queried only accounts *not* requiring a smart card | **Any service account requiring a smart card has been missing from every report ever produced.** Nothing in the output indicated a filter had been applied |
| **2** | The expiration date was queried, then **omitted from the column list** | A report titled *"Service Account Expiration"* that showed **password age and no expiry date**. The one fact it exists to convey was absent |
| **3** | A password that had **never been set** was reported as an age of `0` | The accounts most in need of attention rendered identically to the healthiest ones — and sorted to the **bottom** of a report ordered by age descending |
| **4** | An unassigned variable appended to the results — copy-paste residue from the admin-accounts report | A blank row on every report |

Plus the same resilience gaps closed elsewhere: no error handling on the query (an empty
report emailed as a success); a module guard that logged an error and **fell through**,
sending nothing at all; an appending report file growing without bound; and a log line that
wrote the **entire HTML body** to the very stream the run is classified on — burying the
error lines the run is judged by.

### What is

**One workflow — *Get-ServiceAccountExpirationReport*.** Read-only: it reports on accounts,
it never renews, extends, disables or deletes one.

| Enhancement | What it fixes |
|---|---|
| **The report finally reports expiration** | `Expires on` and `Days to expiry` columns, with each account classified **Expired / Expiring / Active / Never expires** |
| **Complete scope** | Smart-card-requiring accounts are no longer silently excluded. The fix is structural — the replacement query path cannot be defaulted into a filter the way the old one was |
| **New capability: a look-ahead window** | Configurable (default 30 days), driving an **Action required** block and the subject-line counts. It does **not** filter the report — the full inventory is always present — and it does **not** affect expired accounts. It rounds toward warning *early*, because warning one scheduled run **late** is the failure mode that matters |
| **Actionable from the inbox** | Expired and expiring accounts lifted **above** the inventory, worst first, with the counts in the subject line. A scheduled report can be triaged without opening it |
| **A trustworthy empty report** | "Nothing is expiring" and "the query never ran" are now distinguishable. They were previously identical |
| **Correct password-hygiene signal** | "Never set" reads as **"Never set"**, coloured, sorted to the **top** of its group — not as an age of zero at the bottom |
| **Same failure visibility and classification as the Admin Accounts Report** | Banner, per-OU flag, `[INCOMPLETE]` subject prefix, categorised failures with remediation guidance |
| **Operational hygiene** | Report file overwritten rather than appended; a one-line log summary instead of the whole HTML body |

**Consistency point worth making out loud:** this deliverable **reuses the shared functions
built for the Admin Accounts Report**. The two reports look and behave like one product, and
the second was substantially cheaper to build because of it.

**Status:** code, the offline test suite and the full documentation set are complete. Lab
validation against real Active Directory, the workflow build in vRO and the package export
are outstanding.

### Demo

Follow this immediately after the Admin Accounts demo — the family resemblance is the point.

1. **Open `lab/Sample-Report-Clean.html`.** Let them notice unprompted that it looks like
   the report they just saw. Show the **Action required** block sitting above the inventory,
   and the `Expires on` / `Days to expiry` columns.
   **Say:** the previous report had **no expiration column at all**.
2. **Open `lab/Sample-Report-NoFindings.html`.** Show that "nothing is expiring" now says so
   explicitly, with its scope listed. **Say:** previously this was indistinguishable from a
   query that never ran.
3. **Open `lab/Sample-Report-Incomplete.html`** to show the degraded-run treatment.
4. **Run `lab/Run-AllTests.ps1`** — 256 offline checks.
   **The moment that lands it:** explain that **21 of those checks read the shipping source
   rather than testing behaviour**, deliberately. Re-introducing defect 1 would silently
   narrow the report again — and **every behavioural test would still pass**, because none
   of them supplies the input that would expose it. Some regressions are invisible to
   behavioural testing.
5. **Close on the cutover actions**, because they need customer sign-off:
   - **The account count will RISE on the first run**, possibly a lot. That is defect 1
     being corrected — previously invisible accounts becoming visible — **not** a scope
     expansion. Recipients must be briefed, or it reads as a directory change.
   - **Subject-line inbox rules will stop matching** — the subject now carries counts.

---

## 5. Move Windows Event Logs

### What was

**Seven** Ansible playbooks moving Windows event-log archives off servers to a central
archive share, plus cleaning that share down.

**What was wrong with it:**

- **The "safe preview" mode did not work.** The cleanup routine asked for interactive
  confirmation at the keyboard — in a context where nothing is at a keyboard. The preview
  either blocked or silently cancelled.
- **Three near-duplicate AD-targeting variants**, plus a separate special case for running
  on the local host.
- **An unreachable source server failed invisibly** — no error was raised that anyone saw.
- **Disabled group members** were handed into the move loop and errored, one at a time.
- Hardcoded file filter and age.
- An orphaned, unused targeting path still in the script.

### What is

**Two workflows**, covering the full archive lifecycle:

| Workflow | What it does |
|---|---|
| **Move-ArchivedLogs-ByADGroup** | Moves archived event logs off every enabled member of an AD group to a central archive share, into a per-server subfolder |
| **Remove-OldFiles-UNCShare** | Deletes files on the archive share older than a retention threshold — **report-only by default** |

| Enhancement | What it fixes |
|---|---|
| **Report-only mode actually works** | The interactive prompt is gone. The preview lists what *would* be deleted and deletes nothing — and it is the default |
| **One targeting method** | Three variants and the local-execution special case collapse into a single recursive, enabled-only resolver. The PowerShell host is now treated as an ordinary group member |
| **Unreachable sources are visible** | An unreachable server now produces a logged error line instead of failing silently |
| **Disabled members skipped *and logged*** | You can see what was excluded and why |
| **Resilient by design** | One unreachable member is logged and skipped while the remaining moves continue. Only a failure that would break **every** move fails the run |
| **Fully parameterised** | Domain, group, script path, share target, file filter and age are all inputs |

**Also delivered — reusable tooling.** The *How to Build a PowerShell Host* guide and its
setup script, now a shared cross-project library. Three fixes came out of live bring-up and
are worth a slide of their own if the audience is technical:

- The host certificate must be exported **Base-64**, not binary — Orchestrator's trust store
  rejects the binary form.
- The **WinRM HTTPS listener was never actually being created.** The command was being
  mangled before it ran — while the script printed a **false success message**.
- Kerberos: the realm configuration must be multi-line; and the cryptic
  *"salt must be at least 128 bits"* error traces to the **service account name being too
  short**, which is not discoverable from the message.

### Demo

1. **Seed the lab** with `lab/New-ArchiveLogTestData.ps1` — the test data must be
   **back-dated**, because the logic filters on last-modified time, not on filenames.
2. **Show the source servers** — archived logs present, and the archive share empty.
3. **Run Move-ArchivedLogs-ByADGroup.** Show the run log resolving the group, and
   **skipping a disabled member with a logged reason**.
4. **Show the archive share** — per-server subfolders created, files moved.
5. **Run Remove-OldFiles-UNCShare with the default settings.** Show it listing what it
   *would* delete and deleting nothing.
   **The moment that lands it:** state that on the current automation, this preview mode
   **could not run at all** — it stopped and waited for someone to press a key.
6. **Re-run it live** and show the files removed.

*If the lab is not available:* the same points can be made from the run history of a
previous execution, and the PowerShell-host build guide is a good standalone artifact to
show — particularly the false-success bug in the listener setup.

---

## 6. Windows Server Clean Disks

### What was

**Eight** Ansible job templates freeing disk space on Windows servers in a security group —
six clearing the SCCM download cache, two clearing user profile folders. Same action, eight
templates, different inputs.

**What was wrong with it:**

- **No dry run. The action always deleted.** There was no way to preview what a run would
  remove.
- **Silent failures.** An unreachable server or an inaccessible admin share raised a
  **non-terminating** error the operator never saw — **the run looked clean**. Its error
  message was also malformed and never actually printed the exception.
- **Unfiltered targeting** — the group lookup returned users and disabled computer objects,
  which then errored one by one during the clean.
- A **negative** number-of-days input, which is counter-intuitive and easy to get wrong.
- A free-text file filter that was easy to misuse.
- Four near-identical copies of the delete logic in one function.

### What is

**One workflow — *Clean-ServerDisks-ByADGroup*** — covering all eight templates. It
**defaults to a safe report-only preview** and deletes only when explicitly told to.

An item is deleted only when **all** of the following are true:

1. Its server is a **direct, enabled computer member** of the target group.
2. Its last-modified time is **older than** the chosen threshold.
3. It is not on the intentional-preservation list.
4. The run is a **live** run — the default is preview.

| Enhancement | What it fixes |
|---|---|
| **A safety preview that is the default** | Lists every item that *would* be deleted and deletes nothing. An invalid value **fails safe** — no action taken. A live run logs a loud warning so it is unmistakable in the log |
| **Failures are visible** | An unreachable server now produces a logged error with server and path context; the per-server loop continues; the run ends *Completed with Errors* rather than looking clean |
| **Filtered targeting** | Direct, enabled computer objects only — disabled and non-computer objects skipped and logged |
| **Intuitive age input** | A positive "delete items older than N days" instead of a negative number |
| **Per-server *and per-item* isolation** | One failure is logged and the rest proceed. An item already removed as part of a parent folder is correctly not counted as a failure |
| **One code path** | The four duplicate delete branches collapse into a single selection pipeline shared by both preview and live run — so the two **cannot diverge** |
| **Guards** | A missing prerequisite throws; an empty group or empty folder list exits cleanly with a warning rather than looking like a successful clean |

**Design decision worth stating:** this resolver is deliberately **non-recursive**, unlike
the read-only report. Deleting files is destructive, so only what an operator placed
*directly* in the group is a target — a nested sub-group is never silently expanded into
scope. This also preserves the original behaviour.

### Demo

This is the first destructive workflow of the session — make the safety gate the star.

1. **Seed the lab** with `lab/New-DiskCleanTestData.ps1`, and show the target folder
   populated with a mix of old and recent files.
2. **Open the form.** Point out that `whatIf` is **already set to report-only** — the
   operator has to make a deliberate choice to delete.
3. **Run it as-is.** Show the log listing every item it *would* delete — and then show the
   target folder **untouched**.
   **Say:** on the current automation there was no way to do this. The action always deleted.
4. **Show a disabled or non-computer group member being skipped and logged.**
5. **Optionally, point an input at an unreachable server** and run again. Show the logged
   error, the loop continuing to the next server, and the run ending
   **Completed with Errors**.
   **The moment that lands it:** this exact run, on the current automation, would have
   reported a clean success.
6. **Now set `whatIf` to no and run live.** Show the loud warning in the log, then the files
   gone — and the recent files and the preserved file still present.

---

## 7. Server Reboots

### What was

One Ansible playbook that rebooted the Windows servers in a designated AD security group.

**What was wrong with it — this is the most serious set of findings in the programme:**

| Defect | Real-world effect today |
|---|---|
| **The pending-reboot test was inverted-by-accident.** It asked "is this *not* False?" — which is **also true when the state could not be read at all** | A server whose pending state **could not be determined** — WMI or RPC failure — was treated as pending and **force-rebooted**, with the force flag set |
| **Reboot failures raised no error.** The shutdown command is a native executable; when it fails it does not raise the kind of error the surrounding error handling was watching for | **Failed reboots were indistinguishable from successful ones.** Nothing was logged, and no report reflected it |
| **A path-building bug meant the pre-reboot step never ran.** The variable it was built from is always empty, so every path derived from it was wrong | The pre-reboot step **has never executed** — and the server was rebooted anyway |
| **A shared helper returned "failed" on success.** Its success path had no return value at all | A prerequisite that loaded correctly was reported as unavailable. **This affects every caller in the toolbox** |

Beyond the defects: unfiltered group membership, no reboot confirmation, and **no report or
email of any kind** from the reboot action.

### What is

**One workflow** that reboots only the servers **actually reporting a pending reboot**, one
at a time, on a schedule — and produces an auditable per-server report. It covers **physical
and virtual** servers alike, because every operation is OS-level.

A server is rebooted only when **all** of these are true:

1. It is a **direct, enabled computer member** of the target group.
2. It **reports a pending reboot** — via Component Based Servicing, Windows Update, or the
   SCCM client.
3. The run is in reboot mode, which the schedule always sets.

**Servers whose pending state cannot be read are skipped, never rebooted.**

| Enhancement | What it fixes |
|---|---|
| **Never reboots what it could not first interrogate** | The state test now requires an explicit "pending". An unreadable server is skipped and reported |
| **Reboots are verified** | Each server must come back — its last-boot time must advance — within a timeout, or it is reported as failed |
| **Failed reboots are detected** | The command's exit status is captured and tested. A failure is logged and reported |
| **Per-server HTML report, emailed** | Status, timing and reason per server. The reboot action previously produced nothing at all |
| **Filtered, non-recursive targeting** | Direct, enabled computer objects only — a nested sub-group is never silently expanded into a **destructive** action |
| **The pre-reboot script is opt-in, default OFF** | See below |

### The security item — this deserves its own slide

The optional pre-reboot script grants broad access to the **USB mass-storage driver
definition** and the **Terminal Services component** on every server it touches. Restrictive
permissions on those files are a standard control; loosening them is a security-posture
change.

Because of the path-building bug, **it has never actually executed.**

Fixing that bug alone would have **silently started applying those permission changes** to
every rebooted server in the group — a security change arriving as a side effect of a bug
fix. It is therefore gated behind an explicit opt-in switch that **defaults to off, so
default behaviour matches today exactly**, pending customer security review.

The naming of the script suggests it dates to Windows 2000 and may simply be obsolete.

### Demo

1. **Set the scene:** state that this is the most destructive workflow in the set, and that
   it is scheduled to reboot automatically — so **AD group membership is the control
   surface**.
2. **Flag a lab server as pending** using `lab/Set-PendingRebootFlag.ps1`. Leave a second
   server *not* pending.
3. **Run the workflow.** Show it resolving the group, checking each server, and **rebooting
   only the flagged one** — the healthy server is left alone.
4. **Show the post-reboot verification** waiting for the server to return, and confirming it.
5. **Open the emailed per-server report.**
   **Say:** the current automation produces **no report at all** from the reboot action.
6. **The moment that lands it — do this one deliberately.** Point at a server whose state
   cannot be read (unreachable, or simulated). Show that it is **skipped and reported**.
   Then state plainly: on the automation running in production today, that server would have
   been **force-rebooted**, precisely *because* nobody could tell whether it needed it.
7. **Close on the pre-reboot script decision** — what it does, that it has never run, that
   it is now off by default, and that it needs a security review or a decision to retire it.

---

# Closing

## The pattern behind the findings

*This closes the transition half of the session — everything after the opening demo.*

Across the transition deliverables, the defects found in the existing automation share **one
failure mode**. This is the strongest single message available:

> **A non-terminating error, an omitted parameter or a missing column removes content or
> skips work — and the run still reports success.**

- A pending-reboot state that could not be read looked like "pending" → the server was force-rebooted.
- A failed reboot command looked like a successful reboot.
- An unreachable server during disk cleanup looked like a clean run.
- An unreadable OU in the compliance report looked like a compliant OU.
- An omitted parameter silently excluded every smart-card account from the service-account report.
- A report titled "Service Account Expiration" never rendered an expiration date.
- An empty CC list quietly failed **every** emailed report in the toolbox.
- A prerequisite that loaded correctly was reported as unavailable.
- A "safe preview" mode that silently did nothing.

Every one of these is now **visible** — a classified error line, a structured end state, a
flag on the emailed report, or a run that fails outright and says what was missing.

**And the corollary, which is the argument for the test suites:** several of these defects
are invisible to behavioural testing. A report that quietly omits a category of account
passes every test that never asks for that category. That is why the later deliverables
assert against the shipping source, not just the output.

## Where this leaves the estate

- **Manual work removed** at both ends of the lifecycle: routine builds are self-service,
  and routine maintenance is scheduled and verified.
- **One shared toolbox**, one invocation contract, one output classifier, one report layer —
  so the next deliverable is cheaper than the last.
- **Decisions are recorded, not just made** — including the ones where the convenient option
  was deliberately rejected.

## Open decisions to put in front of the customer

| Decision | Project |
|---|---|
| **The pre-reboot script** — security review, or retire it? It has never run; it is currently off by default | Server Reboots |
| **Brief recipients that the service-account count will rise** before the first scheduled send | Service Account Expiration |
| **Review inbox rules** — report subject lines have changed | Both AD reports |
| **Service-account exemptions** — no allow-list exists, so legitimately-exempt accounts recur on every report | Both AD reports |
| **Password expiry vs password age** — the report shows how old a password is, not when it expires. Computing true expiry is a different, more useful metric, not yet implemented | Service Account Expiration |
| **Confirm group membership** before cutting the reboot report over to the recursive resolver | Server Reboot Report |
