'use strict';
const IMG = require('./images');

const blocks = [
  { eyebrow: 'Ansible to Orchestrator transition' },
  { title: 'Remove Old Archived Logs' },
  { subtitle: 'Solution architecture' },

  { meta: [
    ['System', 'Windows event log archives'],
    ['Platform', 'VCF Operations Orchestrator 9'],
    ['Workflow', '`Clean Archived Event Logs from File Share`'],
    ['Workflow ID', '`b453f157-9cc7-48c5-855e-b1f666141897`'],
    ['Orchestrator', '`cvsd26vcfauto01.connect.lab`'],
    ['Replaces', 'One Ansible function, `Remove-OldFiles-UNCPath`'],
    ['Source of truth', 'GitLab, `psscript` repository'],
    ['Script delivery', 'Manual today; pipeline planned'],
    ['Credentials at run time', '**None** — held on the plug-in endpoint'],
    ['Active Directory', '**Not used** — see section 3'],
    ['Status', 'Deployed; one reporting defect outstanding'],
  ]},

  { callout: {
    label: 'Scope of this document',
    tone: 'info',
    text: [
      'This document describes **Remove Old Archived Logs** as a standalone automation. It can be read, and the automation installed, without reference to anything else — including into an Orchestrator with no Active Directory plug-in configured at all.',
      'It has a partner — **Move Archived Logs** — which is what puts files on the share this one cleans. That is a separate automation with its own architecture document. Neither needs the other to work: this one will clean any share, whatever put the files there. Where the two share a component, this document says so explicitly.',
    ],
  }},

  { pagebreak: {} },
  { toc: {} },
  { pagebreak: {} },

  { h1: '1. What the automation does' },
  { p: 'Files accumulate on the archive share. This automation deletes those past their retention period, so the share does not grow without bound.' },
  { p: 'It works on **a share**, not on a list of servers. An operator checks two values — how old, and whether this is a real run — and submits.' },

  { h2: '1.1 What it replaces' },
  { p: 'One function out of the Ansible toolbox: `Remove-OldFiles-UNCPath`, run from `remove-OldFiles-UNCPath.yml`.' },
  { p: 'Unlike the four move playbooks, there was only ever one of these, and its core logic was sound. The retention arithmetic was correct, the path was validated, and per-file errors were counted rather than allowed to stop the run. Most of what follows is therefore not a correction — it is the same job made to work **unattended**, which is the one thing it could not do.' },
  { p: 'The toolbox also carried a second, more dangerous function, `Remove-files`, which piped matches straight into `Remove-Item -Force -Recurse`. That one is not carried forward: it could remove directories as well as files, and a recursive delete is not something an unattended job should be able to reach for.' },

  { h2: '1.2 The interactive prompt had to go' },
  { p: 'This is the change that mattered. The original asked, at the console:' },
  { code: [
    'if (-not $Force -and -not $WhatIfPreference) {',
    '    $Confirmation = Read-Host "Are you sure you want to delete these files? (Y/N)"',
    '    if ($Confirmation -ne \'Y\') {',
    '        write-log "Info: Operation cancelled by user" $true',
    '        return',
    '    }',
    '}',
  ]},
  { p: 'On an automated run there is nobody there. `Read-Host` either blocked the job or read empty input — which is not `Y` — so the function returned having deleted nothing and logged it as a *user cancellation*.' },
  { p: 'The safety feature therefore never worked as a safety feature. It worked as an obstacle: to make the job run at all you passed `-Force`, and `-Force` skipped the confirmation entirely. The only two available modes were **hangs** and **no preview at all**.' },
  { callout: {
    label: 'What replaces it',
    tone: 'good',
    text: '`reportOnly` defaults to on. A run that is not explicitly told to delete will only ever list what it would have deleted. It does the job the prompt was meant to do, it works with nobody watching, and — unlike the prompt — the preview is a real run whose output can be read afterwards in the workflow transcript.',
  }},

  { pagebreak: {} },
  { h1: '2. Context' },
  { p: 'The figure below shows the whole event log archive solution: how code reaches Orchestrator, and what happens at run time. Deployment runs down the page; everything at run time runs across it.' },

  { figure: {
    img: IMG.whole,
    caption: 'Figure 1 — The whole path, from repository to estate',
    note: [
      'The figure shows both automations in this family. **This document covers only the right-hand end of the run-time path**: the PowerShell host reaching the archive share.',
      'Everything on the Active Directory side — the plug-in, the domain endpoints, the expansion of a group into servers — belongs to the **Move Archived Logs** workflow. This automation uses none of it, and needs none of it configured.',
    ],
  }},

  { h1: '3. No Active Directory, and no servers' },
  { p: 'Worth stating on its own, because the partner automation does all three of the things below, the two are usually installed together, and the shared diagnostic action reports on infrastructure this automation will never touch.' },
  { table: {
    head: ['Not required', 'Why'],
    widths: [38, 62],
    rows: [
      ['An Active Directory endpoint', 'It asks Active Directory nothing'],
      ['Administrative share access to any server', 'It touches one share, not the estate'],
      ['The `Move-ArchivedLogs.ps1` Resource Element', 'That belongs to the partner. The probe reporting it `NOT IMPORTED` is correct and harmless here'],
      ['A list of servers, or an inventory of any kind', 'The share is a parameter. Whatever put files there, this reads timestamps and deletes'],
    ],
  }},
  { p: 'What it does need is a PowerShell host, and an account on that host which can both **read and delete** on the archive share. Those are two different permissions, and section 5 explains why the distinction matters more here than anywhere else in this solution.' },

  { pagebreak: {} },
  { h1: '4. Run-time architecture' },
  { p: 'Three elements end to end. Each takes its inputs from the attribute the element before it wrote, so the schema itself records where every value came from. Nothing is fetched with `System.getModule()` inside a task, and nothing is looked up by name at run time.' },

  { code: ['Create Script Parameters  ->  runPowerShellScript  ->  Parse Result  ->  end'] },

  { h2: '4.1 What each element does' },
  { table: {
    head: ['#', 'Element', 'Kind', 'What it contributes'],
    widths: [5, 27, 20, 48],
    rows: [
      ['1', '`Create Script Parameters`', 'Scriptable task', 'Validates the path and the retention, warns on an IP address, converts the tick-box, builds the parameter set'],
      ['2', '`runPowerShellScript`', 'Action *(shared)*', 'Copies the script to the host, runs it, parses the single result line, returns it'],
      ['3', '`Parse Result`', 'Scriptable task', 'Splits that result into the workflow outputs and reports errors individually'],
    ],
  }},

  { h2: '4.2 The data path' },
  { p: '`runPowerShellScript` writes `Remove-OldArchivedLogs.ps1` into `%TEMP%¦Orchestrator` on the PowerShell host, invokes it by path, captures everything it printed, and deletes the file. The script enumerates the share recursively, filters by last-write time, and deletes matching files one at a time.' },
  { callout: {
    label: 'Why the script is written to disk rather than piped in',
    tone: 'info',
    text: 'Invoked by path, it runs exactly as it would if an administrator ran it by hand — so what you test at a console is what the workflow does. Deleting it afterwards means no stale copy is left to drift out of step with the version held in Orchestrator.',
  }},
  { p: 'Files are deleted individually rather than piped as a set into `Remove-Item`. One locked or protected file is then reported and skipped while the cleanup continues; piped, its error behaviour depends on the preference in force, and under `Stop` a single open log file ends the run. A file being open is the ordinary case here, not the exception — these are event log archives on a share another job writes to.' },
  { p: 'Folders are left alone. Only files are deleted, so a server folder stays on the share between archive runs rather than vanishing and reappearing.' },

  { pagebreak: {} },
  { h1: '5. Components' },
  { p: 'Seven files, of which four are shared with the partner automation and only three are this automation own. The split follows one rule: **anything that runs a script on a Windows host is shared; anything that decides which servers belongs to the partner.** This automation has no servers.' },

  { h2: '5.1 This automation only' },
  { table: {
    head: ['Component', 'Kind', 'Responsibility'],
    widths: [32, 18, 50],
    rows: [
      ['`Remove-OldArchivedLogs.ps1`', 'Resource Element', 'The Windows-side work: enumerate, filter by age, delete, report'],
      ['`task_CreateScriptParameters.js`', 'Scriptable task', 'Validates, warns on an IP path, builds the parameter set'],
      ['`task_ParseResult.js`', 'Scriptable task', 'Result to workflow outputs'],
    ],
  }},

  { h2: '5.2 Shared with Move Archived Logs' },
  { table: {
    head: ['Component', 'Kind', 'Note'],
    widths: [32, 18, 50],
    rows: [
      ['`runPowerShellScript.js`', 'Action', 'The only place that knows anything about the PowerShell plug-in. **Required**'],
      ['`selectPowerShellHost.js`', 'Action', 'Only needed if more than one host is registered'],
      ['`probeAdPlugin.js`', 'Action', 'Diagnostic. **Only its PowerShell sections apply here**; ignore its Active Directory output'],
      ['`Probe-ServerAccess.ps1`', 'Script', 'Diagnostic: run identity, Kerberos ticket flags, what the share can actually be read'],
    ],
  }},
  { callout: {
    label: 'If the partner is already installed here',
    tone: 'good',
    text: 'All three actions this automation needs already exist. Use them; do not create second copies. Only the two scriptable tasks are new, and those live inside the workflow rather than in the action library — so in that case there is nothing to add to the library at all.',
  }},

  { pagebreak: {} },
  { h1: '6. Security model' },
  { p: 'Nothing in this automation accepts a username or a password. The PowerShell plug-in uses the account stored against the host.' },

  { table: {
    head: ['Hop', 'Runs as', 'Held where'],
    widths: [34, 33, 33],
    rows: [
      ['Orchestrator to PowerShell host', 'The host account', 'On the `PowerShell:PowerShellHost` object'],
      ['PowerShell host to archive share', '**The same account, delegated**', 'Kerberos — see below'],
    ],
  }},

  { h2: '6.1 Read and delete are different permissions' },
  { p: 'This is the distinction this automation turns on, and the one most likely to be missed.' },
  { table: {
    head: ['Operation', 'Needs', 'Exercised by'],
    widths: [30, 30, 40],
    rows: [
      ['Listing the share', 'Read', 'Every run, including report-only'],
      ['Deleting a file', 'Delete', '**Only a live run**'],
    ],
  }},
  { callout: {
    label: 'A clean report-only run does not prove the files can be deleted',
    tone: 'warn',
    text: 'Report only reads the share and never writes to it. An account with read but not delete produces a flawless report — every file correctly identified, no errors — and then fails on every single file the moment the box is unticked. No amount of re-running the report will reveal it. The only way to establish delete permission is to delete something.',
  }},
  { p: 'The script says as much in its own log rather than leaving it to be discovered.' },

  { h2: '6.2 The second hop' },
  { p: 'Orchestrator connects to the PowerShell host; the host then reaches the archive share. That is a separate authentication, and by default Windows will not forward the credential to it. The host must be set to **Kerberos** — Basic and NTLM cannot carry a credential to a second machine at all — and the connection must actually delegate, which is a separate condition worth verifying rather than assuming.' },
  { table: {
    head: ['`klist` ticket flags on the host', 'Meaning'],
    widths: [40, 60],
    rows: [
      ['`forwardable forwarded`', 'The credential **was** delegated. The second hop will work'],
      ['`forwardable` alone', 'The ticket could have been delegated but was not'],
      ['No `krbtgt` ticket, only `HOST/<pshost>`', 'No delegation at all. The session can act only on the host itself'],
    ],
  }},
  { p: 'Because this automation reaches exactly one machine, resource-based constrained delegation is straightforward here: it needs configuring on the file server alone, not across an estate.' },
  { callout: {
    label: 'A console logon proves nothing',
    tone: 'warn',
    text: 'Logging on to the PowerShell host at the console or over RDP and browsing to the share will succeed whether delegation is configured or not. Both hold primary credentials and can authenticate onward; a WinRM session cannot. Same account, same rights, different logon type — and the workflow uses the one that fails. Verification has to happen in a session **Orchestrator opened**.',
  }},

  { h2: '6.3 Paths must be names, never IP addresses' },
  { p: 'Kerberos authenticates to a service principal name, built from a host *name*. There is none for an IP address, so a UNC path written with one cannot use Kerberos at all: it falls back to NTLM, the delegated credential is useless to it, and the share answers `Access is denied`.' },
  { p: 'This automation has exactly one path, so it is entirely exposed to this. There is no second, working path to compare against, and no way to tell it apart from a share-permissions fault by reading the error.' },
  { p: 'Both the script and the first task **warn** when given an IP, rather than refusing — a local path or a mapped drive is legitimate, and the caller may know something the check does not. The script emits its warning *before* the reachability test, which on an unreachable IP takes about twenty seconds to fail, so the cause appears in the log ahead of the symptom.' },

  { pagebreak: {} },
  { h1: '7. Getting code into Orchestrator' },
  { p: 'The repository is the source of truth. Orchestrator holds a copy, and the copy is made by hand today.' },
  { figure: {
    img: IMG.delivery,
    caption: 'Figure 2 — Code delivery, today and planned',
    note: 'This path is shared by both automations in the family and is a **build-time** concern. It is not another hop in the run-time data path, and nothing in it runs while the workflow runs.',
  }},
  { p: 'Until the pipeline exists, the repository and Orchestrator can disagree and nothing will say so. That is a deliberate, recorded gap rather than an oversight.' },

  { h1: '8. Failure behaviour and observability' },

  { h2: '8.1 The result-line contract' },
  { p: 'The script prints readable log lines for people, and exactly one line for Orchestrator:' },
  { code: ['PSO_RESULT={"matched":412,"deleted":412,"freedMB":1180.44,"errorCount":0,"errors":[]}'] },
  { p: 'That line is always printed — even when the script deletes nothing, and even when it refuses to run at all. Because it is always printed, its absence means something real: the script did not finish. `runPowerShellScript` treats a missing result line as a failure rather than as "zero files".' },

  { h2: '8.2 One unreadable folder must not abandon the share' },
  { p: 'The original stopped on the first enumeration error. On a share of any size some folder eventually cannot be read — a per-folder ACL, a protected subdirectory, something another job created — and the first one then ends the enumeration, leaving the rest of the share uncleaned.' },
  { p: 'There is a worse consequence in the Orchestrator setting. The error is terminating, so the script exits *before* printing its result line, and the workflow reports:' },
  { code: [
    'runPowerShellScript: Remove-OldArchivedLogs.ps1 did not report a result.',
    'It always writes a PSO_RESULT line, so it did not run to completion.',
  ]},
  { callout: {
    label: 'Why that message is worse than the fault it describes',
    tone: 'warn',
    text: 'It states that the script never ran. It did run — it was denied on one folder. The message sends the reader looking for a broken session, a missing Resource Element or a dead host, none of which is the problem.',
  }},
  { p: 'The enumeration is therefore guarded twice: it continues past folders it cannot read and logs each one individually as an error naming it, and a backstop catch handles a failure that terminates anyway. The rest of the share is still cleaned, the denials are named, the error count is non-zero so the run does not claim success, and the result line is written either way.' },

  { h2: '8.3 Errors say which operation failed' },
  { p: '`Test-Path` proves less than it appears to: reaching a path needs only traverse rights, while listing its contents needs more. A share can pass the reachability check and then refuse to be listed. The script therefore reports the operation as well as the path — `could not list` and `could not delete` are different permissions with different fixes, and `Access is denied` alone cannot tell them apart.' },

  { h2: '8.4 Partial success is a real state' },
  { p: 'A few files being locked does not fail the workflow. They are named, everything else is deleted, and `success` comes back false with the counts still populated. Locked files usually go on the next run.' },

  { pagebreak: {} },
  { h1: '9. As deployed' },
  { p: 'Taken from the workflow export. Where this differs from implementation guidance, this section records what exists.' },

  { h2: '9.1 Inputs and attributes' },
  { table: {
    head: ['Name', 'Kind', 'Value or control'],
    widths: [30, 22, 48],
    rows: [
      ['`olderThanDays`', 'Input', 'Decimal, **minimum 1**, enforced by the form as well as the script'],
      ['`reportOnly`', 'Input', 'Checkbox, **default true**'],
      ['`scriptElement`', 'Attribute', '`Remove-OldArchivedLogs.ps1`'],
      ['`psHost`', 'Attribute', 'The same registered host the partner uses'],
      ['`fileFilter`', 'Attribute', '`Archive-*.evtx`'],
      ['`fileServerPath`', 'Attribute', '`¦¦iaaslabdc¦archived-logs`'],
      ['`scriptParameters`, `scriptRunResult`', 'Attribute', 'Empty; carry values between elements'],
    ],
  }},
  { p: 'Only two inputs, which is the intended shape: an operator checks two values and submits.' },

  { h2: '9.2 Outstanding items' },
  { callout: {
    label: 'Defect 1 — Parse Result reads the partner workflow field names',
    tone: 'warn',
    text: [
      'The deployed `Parse Result` is the move workflow task, pasted in unchanged. It reads `serversProcessed`, `moved` and `serversRequested`; this script reports `matched`, `deleted` and `freedMB`, and none of those. All three come back **null**, so every successful run logs `Finished. null file(s) across null server(s).`',
      'Nothing throws and nothing warns. A run that correctly deleted four hundred files reports null, and so does a run that deleted nothing — the log cannot tell them apart. The deletions themselves are correct and the transcript holds the truth, so this is a reporting defect rather than a destructive one, but it makes the workflow output worthless. **Replace that task with `task_ParseResult.js` from this package.**',
    ],
  }},
  { p: '**Item 2 — the share is addressed by short name.** Deployed as `¦¦iaaslabdc¦archived-logs`; the partner uses `¦¦iaaslabdc.vcf.lab¦archived-logs`. This is *not* the IP trap — a short host name usually has its own service principal name registered, so it will normally authenticate and work. It is still worth aligning: it depends on DNS suffix search order resolving correctly, a short name is ambiguous in a multi-domain estate, and the two workflows now point at the same share under two different names, so a search for one will not find the other.' },
  { p: '**Item 3 — no workflow outputs are declared.** `Parse Result` assigns its values into an empty OUT tab, so they are computed and discarded. Given that this workflow deletes files, being able to read the counts back from a scheduled run afterwards is worth having.' },

  { h2: '9.3 What is correct, and worth not breaking' },
  { bullets: [
    '`Create Script Parameters` is this automation own task, adapted properly — it validates the path, warns on an IP address before the share is touched, converts the tick-box by reading its value rather than testing it for truth, and refuses a retention below 1.',
    '`reportOnly` defaults to true, and the form enforces a minimum retention of 1 day independently of the script.',
    '`psHost` and `scriptElement` are bound attributes, so nothing is looked up by name at run time.',
    'Only `runPowerShellScript` is called as an action, and it is the shared one.',
  ]},

  { h1: '10. What was deliberately left out' },
  { table: {
    head: ['Not done', 'Why'],
    widths: [32, 68],
    rows: [
      ['Deleting empty folders', 'A server folder disappearing between archive runs looks like the server was removed. Files only'],
      ['A file-exclusion parameter', 'The original had one, matching a single name case-sensitively. `fileFilter` already scopes what is considered, and one hard-coded exclusion is a worse tool than a filter'],
      ['Recursing into the delete', 'The original companion function used a recursive delete, which can remove directories. An unattended job should not have that reach'],
      ['Moving to a recycle location first', 'There is no recycle bin on a UNC path. Report only, read the list, then run it live — that is the control'],
      ['Reporting per-folder totals', 'The script logs every file and reports the totals. A per-folder breakdown is more schema for the same information'],
      ['Email on completion', 'Not asked for. Orchestrator notification workflows can be attached later without touching this automation'],
    ],
  }},
];

module.exports = { blocks, IMG };
