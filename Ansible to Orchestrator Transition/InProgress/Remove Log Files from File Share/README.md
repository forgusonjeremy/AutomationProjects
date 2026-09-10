# Remove Old Archived Logs

**Replaces:** one Ansible function that could not run unattended
**Platform:** VCF Operations Orchestrator 9
**Status:** deployed as `Clean Archived Event Logs from File Share` — **one reporting defect to fix**, see 07_As-Deployed.md

---

## What this does

Deletes files from the archive share once they are past their retention period. It is the
housekeeping half of the event log archive story: something fills the share up, and this
keeps it from filling up forever.

It works on **a share**, not on a list of servers. It queries no directory, touches no
server, and needs no Active Directory at all.

---

## The shape of it

```
                                      ┌──────────────────────────┐
   Operator checks two values   ───►  │      Orchestrator        │
   and clicks submit.                 │                          │
                                      │  PowerShell plug-in  ────┼──►  PowerShell host
                                      └──────────────────────────┘          │
                                                                            │ UNC
                                                                            ▼
                                                              \\fileserver\archived-logs
                                                                   (read, then delete)
```

Three schema elements end to end. The rule is the same as its partner's: **anything that
ran on Windows** is in a PowerShell script, held in Orchestrator, copied to the host at run
time, run, and deleted.

Nothing in this package accepts a username or a password. The PowerShell plug-in uses the
account stored against the host.

---

## Standalone, but not alone

**This package is complete on its own.** It can be installed into an Orchestrator that has
never seen anything else in this family, and it does not need an Active Directory endpoint
registered at all.

It has a partner — **Move Archived Logs** — which is what puts the files on the share this
one cleans. That is a separate package. Neither needs the other to work: this one will
clean any share, whatever put the files there.

Four of the files here are **shared** with it, and are marked as such in the code and
listed in [06_Shared-Components.md](Documentation/06_Shared-Components.md). If the other
automation is already installed, **all three actions this package needs already exist** —
do not create second copies.

---

## Files

```
Remove-Old-Archived-Logs/
├── README.md                        ← you are here
│
├── Code/
│   │   -- this automation's own --
│   ├── Remove-OldArchivedLogs.ps1       the Windows-side work
│   ├── task_CreateScriptParameters.js   builds the parameter bag, warns on an IP path
│   ├── task_ParseResult.js              splits the result into the workflow's outputs
│   │
│   │   -- shared with Move Archived Logs --
│   ├── runPowerShellScript.js           copies a script to the host, runs it, reads the result
│   ├── selectPowerShellHost.js          only asks which host when there is a real choice
│   ├── probeAdPlugin.js                 diagnostic. Only its PowerShell sections apply here
│   └── Probe-ServerAccess.ps1           diagnostic: identity, Kerberos flags, what the share reads
│
├── Documentation/
│   ├── 01_User-Guide.md                 for whoever runs it day to day
│   ├── 02_Design-Decisions.md           what changed from the Ansible function, and why
│   ├── 03_Implementation-Guide.md       how to build it in Orchestrator
│   ├── 04_Testing-Plan.md               how to prove it works
│   ├── 05_Architecture.docx             **the architecture document (Word) — the deliverable**
│   ├── 05_Architecture.html             the two diagrams, in a browser
│   ├── 05_Architecture-Figure*.png      the two diagrams on their own
│   ├── 06_Shared-Components.md          what is shared, with what, and how to avoid duplicating it
│   └── 07_As-Deployed.md                what was actually built, and what is outstanding on it
│
└── Reference/                       source material, kept for the record
    ├── ansible-source-playbooks.md
    └── New-ArchiveLogTestData.ps1
```

---

## Where to start

1. **[07_As-Deployed.md](Documentation/07_As-Deployed.md)** — what is actually running, its
   workflow ID, and **the reporting defect to fix**. Read this first.
2. **[06_Shared-Components.md](Documentation/06_Shared-Components.md)** — read this next
   if the other automation is already installed here. All three actions will already exist.
3. **[02_Design-Decisions.md](Documentation/02_Design-Decisions.md)** — read this first if
   you knew the Ansible toolbox. The core logic was sound; what changed is that it can now
   run with nobody watching.
4. **[03_Implementation-Guide.md](Documentation/03_Implementation-Guide.md)** — building
   it. Under an hour, and much of it is skippable if the partner is already installed.
5. **[04_Testing-Plan.md](Documentation/04_Testing-Plan.md)** — proving it. Test 4.7 is
   the one this automation exists to have.
6. **[05_Architecture.docx](Documentation/05_Architecture.docx)** — the architecture
   document. This is the one to send. `05_Architecture.html` holds the same two diagrams in
   a browser.
7. **[01_User-Guide.md](Documentation/01_User-Guide.md)** — for whoever runs it day to day.

---

## Three things worth knowing before you start

**This deletes files permanently.** There is no recycle bin on a UNC path. `reportOnly`
defaults to on and the retention cannot be set below 1 day, but neither of those helps if
the list is wrong and nobody reads it.

**A clean report-only run does not prove the files can be deleted.** Listing a folder and
deleting from it are different permissions. Report only exercises the first and never the
second, so it passes perfectly on a share the account cannot delete from. Test 1.6 and
test 4.7 are the only things that settle it.

**Never put an IP address in the share path.** There is no Kerberos SPN for an IP literal,
so the connection drops to NTLM and is refused. It presents as a share-permissions problem
and no amount of delegation work fixes it. Both the script and the workflow warn you —
take the warning seriously.
