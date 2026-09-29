# Move Archived Logs

**Replaces:** four Ansible playbooks with one Orchestrator workflow
**Platform:** VCF Operations Orchestrator 9
**Status:** built and deployed — `Move Archived Logs By AD Group`

---

## What this does

Windows servers write their event logs out to `Archive-*.evtx` files and leave them on the
C: drive. This automation takes those files off every server in an Active Directory group
and puts them on a central share, in a folder named after the server.

An operator picks a group from a tree and clicks submit. Nothing is typed, and no
credential is entered anywhere.

---

## The shape of it

```
                                      ┌──────────────────────────┐
   Operator picks an AD group  ───►   │      Orchestrator        │
   from a tree. Nothing typed.        │                          │
                                      │  AD plug-in  ────────────┼──►  Domain controllers
                                      │  (which servers?)        │     (one endpoint per domain)
                                      │                          │
                                      │  PowerShell plug-in  ────┼──►  PowerShell host
                                      └──────────────────────────┘          │
                                                                            │ UNC
                                                                            ▼
                                                            \\server\C$  ──►  \\share\<server>
```

Two rules decide where every piece of logic lives:

- **Anything that ran on Windows** is in a PowerShell script, held in Orchestrator, copied
  to the PowerShell host at run time, run, and deleted.
- **Anything Ansible did itself** — mainly the Active Directory lookup — is now an
  Orchestrator plug-in call.

Nothing in this package accepts a username or a password. The AD plug-in uses the account
stored against each domain endpoint; the PowerShell plug-in uses the account stored against
the host. Neither one crosses the network from a workflow.

---

## Standalone, but not alone

**This package is complete on its own.** It can be installed into an Orchestrator that has
never seen anything else in this family.

It has a housekeeping partner — **Remove Old Archived Logs** — which deletes files from the
same share once they are past their retention period. That is a separate package. This one
fills the share up; that one keeps it from filling up forever. Neither needs the other to
work.

Four of the files here are **shared** with it, and are marked as such in the code and
listed in [06_Shared-Components.md](Documentation/06_Shared-Components.md). If you are
installing both, create each shared action **once**.

---

## Files

```
Move-Archived-Logs/
├── README.md                        ← you are here
│
├── Code/
│   │   -- this automation's own --
│   ├── Move-ArchivedLogs.ps1            the Windows-side work
│   ├── getGroupComputers.js             expands the AD group, nested groups included
│   ├── findAdHostForDn.js               works out the domain, and so the endpoint, from a name
│   ├── resolveAdGroup.js                accepts a picked group or a typed name
│   ├── task_CreateScriptParameters.js   builds the parameter bag, warns on an IP path
│   ├── task_ParseResult.js              splits the result into the workflow's outputs
│   ├── workflow_Move-ArchivedLogs.js    reference only -- see 06_Shared-Components.md
│   │
│   │   -- shared with Remove Old Archived Logs --
│   ├── runPowerShellScript.js           copies a script to the host, runs it, reads the result
│   ├── selectPowerShellHost.js          only asks which host when there is a real choice
│   ├── probeAdPlugin.js                 one-off check that this Orchestrator can do all of the above
│   └── Probe-ServerAccess.ps1           diagnostic: identity, Kerberos flags, what each share reads
│
├── Documentation/
│   ├── 01_User-Guide.md                 for whoever runs it day to day
│   ├── 02_Design-Decisions.md           what was standardised, and why
│   ├── 03_Implementation-Guide.md       how to build it in Orchestrator
│   ├── 04_Testing-Plan.md               how to prove it works
│   ├── 01–04 *.docx                     the same four, in Word, for sending out
│   │                                    (generated -- edit the .md, then Tools/markdown-docx)
│   ├── 05_Architecture.docx             **the architecture document (Word) — the deliverable**
│   ├── 05_Architecture.html             the two diagrams, in a browser
│   ├── 05_Architecture-Figure*.png      the two diagrams on their own
│   ├── 06_Shared-Components.md          what is shared, with what, and how to avoid duplicating it
│   └── 07_As-Deployed.md                what was actually built, and what is outstanding on it
│
├── Tools/                           build tooling for the Word copies
│   ├── architecture-docx/               builds 05_Architecture.docx (needs Node)
│   └── markdown-docx/                   builds 01-04 .docx from the Markdown (PowerShell)
│
└── Reference/                       source material, kept for the record
    ├── ansible-source-playbooks.md
    ├── New-ArchiveLogTestData.ps1
    └── com.broadcom.pso.cvs-dt.conus.eventlogarchivesmove.package
```

---

## Where to start

1. **[07_As-Deployed.md](Documentation/07_As-Deployed.md)** — what is actually running,
   its workflow ID, and the three gaps still open on it. Read this before changing anything.
2. **[06_Shared-Components.md](Documentation/06_Shared-Components.md)** — read this next
   if the other automation is already installed here. It tells you what not to build twice.
3. **[02_Design-Decisions.md](Documentation/02_Design-Decisions.md)** — read this first if
   you knew the playbooks. It explains what changed and why, including four places where
   the old behaviour was wrong and has been corrected.
4. **[03_Implementation-Guide.md](Documentation/03_Implementation-Guide.md)** — building
   it. Starts with the `probeAdPlugin` check, which will save you time.
5. **[04_Testing-Plan.md](Documentation/04_Testing-Plan.md)** — proving it. Part 7 tests
   the destination on its own, which is the part everyone skips and then regrets.
6. **[05_Architecture.docx](Documentation/05_Architecture.docx)** — the architecture
   document. This is the one to send. `05_Architecture.html` holds the same two diagrams in
   a browser.
7. **[01_User-Guide.md](Documentation/01_User-Guide.md)** — for whoever runs it day to day.

---

## Before anything else

Run the `probeAdPlugin` action once. It changes nothing and prints exactly what this
Orchestrator's plug-ins offer, which is the fastest way to find out whether the AD
endpoints and the PowerShell host are set up the way this workflow expects. Everything in
the Implementation Guide assumes you have done it.

---

## Two things that will cost you a day if you skip them

**Never put an IP address in a path.** There is no Kerberos SPN for an IP literal, so the
connection drops to NTLM and is refused. It presents as a share-permissions problem and no
amount of delegation work fixes it.

**A clean report-only run does not mean the destination works.** Report only never writes
to the archive share. When the live run then fails, the errors are reported against the
*source* servers — because that is where the files are being read from — and every server
appears to refuse at once. Check the destination first.
