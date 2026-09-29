'use strict';
const IMG = require('./images');

const blocks = [
  { eyebrow: 'Ansible to Orchestrator transition' },
  { title: 'Move Archived Logs' },
  { subtitle: 'Solution architecture' },

  { meta: [
    ['System', 'Windows event log archives'],
    ['Platform', 'VCF Operations Orchestrator 9'],
    ['Workflow', '`Move Archived Logs By AD Group`'],
    ['Workflow ID', '`d6f9b6c3-422c-41c7-89b8-6906f89c796d`'],
    ['Orchestrator', '`cvsd26vcfauto01.connect.lab`'],
    ['Replaces', 'Four Ansible playbooks'],
    ['Source of truth', 'GitLab, `psscript` repository'],
    ['Script delivery', 'Manual today; pipeline planned'],
    ['Credentials at run time', '**None** — held on the plug-in endpoints'],
    ['Status', 'Built and deployed'],
  ]},

  { callout: {
    label: 'Scope of this document',
    tone: 'info',
    text: [
      'This document describes **Move Archived Logs** as a standalone automation. It can be read, and the automation installed, without reference to anything else.',
      'It has a housekeeping partner — **Remove Old Archived Logs** — which deletes files from the same share once they are past their retention period. That is a separate automation with its own architecture document. This one fills the share up; that one keeps it from filling up forever. Neither needs the other to work, and where the two share a component this document says so explicitly.',
    ],
  }},

  { pagebreak: {} },
  { toc: {} },
  { pagebreak: {} },

  // -------------------------------------------------------------------------
  { h1: '1. What the automation does' },
  { p: 'Windows servers write their event logs out to `Archive-*.evtx` files and leave them on the C: drive. Left alone they accumulate until the system volume fills.' },
  { p: 'This automation takes those files off every server in an Active Directory group and moves them to a central archive share, into a folder named after the server they came from. An operator supplies one thing — which group — and submits. Everything else is a default set when the workflow was built.' },

  { h2: '1.1 The two rules the design follows' },
  { bullets: [
    '**Anything that ran on Windows** stays in a PowerShell script. It is held in Orchestrator as a Resource Element, copied to the PowerShell host at run time, run by path, and deleted afterwards.',
    '**Anything Ansible did for itself** — principally the Active Directory lookup — is now an Orchestrator plug-in call, made by the platform rather than by a script on a host.',
  ]},
  { p: 'The consequence of the second rule is the one that matters most: the credential problem disappears. Ansible connected to a Windows host over WinRM carrying a username and password in order to run `Get-ADGroupMember` there. Orchestrator asks its own Active Directory plug-in instead, using the account stored against the domain endpoint. No PowerShell runs for that step, no host is involved, and no password appears in any variable.' },

  { h2: '1.2 What it replaces' },
  { table: {
    head: ['Playbook', 'How it picked servers', 'How it reached the files'],
    widths: [40, 27, 33],
    rows: [
      ['`file-move_with-LocalPath_Inventory.yml`', 'Static inventory file', 'Ran on each server'],
      ['`file-move_with-LocalPath_AD-Group.yml`', 'AD group', 'Ran on each server'],
      ['`file-move_with-UNCPath_AD-Group.yml`', 'AD group', 'One host, UNC to the rest'],
      ['`file-move_with-UNCPath_AD-Group-TEST(1).yml`', 'AD group plus a named domain', 'One host, UNC to the rest'],
    ],
  }},
  { p: 'All four carried the same `Move-files` function, copied. What differed was two choices, made independently of each other. The design settles both: servers come from an **Active Directory group**, and files are reached **over UNC from one host**. The fourth row collapses into the third, and the local-path variants disappear — registering every server in the estate as a PowerShell host is unworkable past a handful of machines, and unnecessary when one host can reach them all.' },

  // -------------------------------------------------------------------------
  { pagebreak: {} },
  { h1: '2. Context' },
  { p: 'The figure below shows the whole event log archive solution: how code reaches Orchestrator, and what happens at run time. Deployment runs down the page; everything at run time runs across it. The two axes are separate on purpose — getting code into Orchestrator is a build-time concern, not another hop in the data path.' },

  { figure: {
    img: IMG.whole,
    caption: 'Figure 1 — The whole path, from repository to estate',
    note: [
      'The figure shows both automations in this family. **This document covers the upper run-time path**: the Active Directory plug-in resolving a group to a list of servers, and the PowerShell host reaching those servers over `¦¦server¦C$` and writing to the archive share.',
      'The **Remove Old Archived Logs** workflow shown alongside it touches only the archive share, never Active Directory and never a server. It is documented separately.',
    ],
  }},

  { h2: '2.1 Which domain? Nobody is asked' },
  { p: 'Every Active Directory object carries its domain inside its own name:' },
  { code: [
    'CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab',
    '                                 ^^^^^^^^^^^^^^^^^',
    '                                 this can only be connect.lab',
  ]},
  { p: 'So the domain is never a question put to an operator, on either of the two routes in:' },
  { bullets: [
    '**A person running it** picks the group from a tree in the request form, or supplies its distinguished name. Orchestrator hands the group over already attached to the right endpoint.',
    '**A schedule or an API call** passes the distinguished name as text, because there is nobody there to click a tree. `findAdHostForDn` reads the `DC=` parts off the end and matches them against each registered endpoint.',
  ]},
  { p: 'In both cases the endpoint follows from the object, so the two cannot disagree. Compare `file-move_with-UNCPath_AD-Group-TEST(1).yml`, which asked for a domain name **and** a group DN as separate variables — two facts that had to be kept in step by whoever filled in the form, with nothing checking that they were.' },
  { p: 'Adding a domain to the estate means registering one more Active Directory endpoint. No code changes.' },

  // -------------------------------------------------------------------------
  { pagebreak: {} },
  { h1: '3. Run-time architecture' },
  { p: 'The workflow is a schema of bound elements rather than one large scriptable task. Each element takes its inputs from the attribute the element before it wrote, so the schema itself records where every value came from. Nothing is fetched with `System.getModule()` inside a task, and nothing is looked up by name at run time.' },

  { code: [
    'findAdHostForDn  ->  resolveAdGroup  ->  getGroupComputers',
    '                 ->  Create Script Parameters',
    '                 ->  runPowerShellScript  ->  Parse Result  ->  end',
  ]},

  { h2: '3.1 What each element does' },
  { table: {
    head: ['#', 'Element', 'Kind', 'What it contributes'],
    widths: [5, 27, 20, 48],
    rows: [
      ['1', '`findAdHostForDn`', 'Action', 'Reads the `DC=` parts off the group DN and returns the Active Directory endpoint that serves that domain'],
      ['2', '`resolveAdGroup`', 'Action', 'Finds the group, searching by CN with the endpoint from step 1 passed in as its second input'],
      ['3', '`getGroupComputers`', 'Action', 'Expands the group to computer names, following nested groups and skipping disabled accounts by name'],
      ['4', '`Create Script Parameters`', 'Scriptable task', 'Turns the form and the server list into the parameter set the script expects'],
      ['5', '`runPowerShellScript`', 'Action *(shared)*', 'Copies the script to the host, runs it, parses the single result line, returns it'],
      ['6', '`Parse Result`', 'Scriptable task', 'Splits that result into the workflow outputs and reports errors individually'],
    ],
  }},
  { p: 'Step 2 taking the endpoint as an input rather than looking it up again is deliberate. It means the workflow schema shows that the *same* endpoint flowed into both steps, which a lookup hidden inside the action would not.' },

  { h2: '3.2 The data path' },
  { p: 'Steps 1 to 3 are plug-in calls. No PowerShell runs and nothing leaves Orchestrator except LDAP queries to a domain controller, made as the account stored on the endpoint.' },
  { p: 'Step 5 is the only part that touches a Windows host. `runPowerShellScript` writes `Move-ArchivedLogs.ps1` into `%TEMP%¦Orchestrator` on the PowerShell host, invokes it by path, captures everything it printed, and deletes the file. The script then reaches each server over `¦¦<server>¦C$¦Windows¦System32¦winevt¦Logs` and writes to `¦¦<fileserver>¦archived-logs¦<server>¦`.' },
  { callout: {
    label: 'Why the script is written to disk rather than piped in',
    tone: 'info',
    text: 'Invoked by path, it runs exactly as it would if an administrator ran it by hand — so what you test at a console is what the workflow does. Deleting it afterwards means no stale copy is ever left to drift out of step with the version held in Orchestrator, which is precisely what went wrong with the pre-staged toolbox script this replaces.',
  }},

  // -------------------------------------------------------------------------
  { pagebreak: {} },
  { h1: '4. Components' },
  { p: 'Ten files, of which four are shared with the partner automation. The split is not arbitrary: **anything that runs a script on a Windows host is shared; anything that decides which servers is not.** The partner has no servers — it has a share.' },

  { h2: '4.1 This automation only' },
  { table: {
    head: ['Component', 'Kind', 'Responsibility'],
    widths: [30, 18, 52],
    rows: [
      ['`Move-ArchivedLogs.ps1`', 'Resource Element', 'The Windows-side work: enumerate, filter by age, move, report'],
      ['`findAdHostForDn.js`', 'Action', 'Domain to endpoint, read from `hostConfiguration.ldapBase`'],
      ['`resolveAdGroup.js`', 'Action', 'Distinguished name to `AD:UserGroup`'],
      ['`getGroupComputers.js`', 'Action', 'Group to computer names, nested and enabled-only'],
      ['`task_CreateScriptParameters.js`', 'Scriptable task', 'Validates, warns on an IP destination, builds the parameter set'],
      ['`task_ParseResult.js`', 'Scriptable task', 'Result to workflow outputs'],
    ],
  }},

  { h2: '4.2 Shared with Remove Old Archived Logs' },
  { table: {
    head: ['Component', 'Kind', 'Why it is shared'],
    widths: [30, 18, 52],
    rows: [
      ['`runPowerShellScript.js`', 'Action', 'The only place that knows anything about the PowerShell plug-in. Both automations run their script through it'],
      ['`selectPowerShellHost.js`', 'Action', 'Returns the only registered host, or stops with the list of choices'],
      ['`probeAdPlugin.js`', 'Action', 'Diagnostic. The partner uses only its PowerShell sections'],
      ['`Probe-ServerAccess.ps1`', 'Script', 'Diagnostic: run identity, Kerberos ticket flags, what each share can actually be read'],
    ],
  }},
  { callout: {
    label: 'If both automations are installed here',
    tone: 'warn',
    text: 'Create each shared action **once** and let both workflows call it. A second copy under a different name does not receive fixes made to the first, and nothing reports that the two have diverged. `runPowerShellScript` in particular has absorbed several hard-won corrections — byte-order-mark stripping, preferring the host’s own session over a separate one, transcript recovery when the script throws — and a stale second copy silently reintroduces all of them.',
  }},

  // -------------------------------------------------------------------------
  { pagebreak: {} },
  { h1: '5. Security model' },
  { p: 'Nothing in this automation accepts a username or a password, and no credential is passed between workflow elements. Both plug-ins use the account stored against the object they act through.' },

  { table: {
    head: ['Hop', 'Runs as', 'Held where'],
    widths: [34, 33, 33],
    rows: [
      ['Orchestrator to domain controller', 'The endpoint service account', 'On the `AD:AdHost` endpoint'],
      ['Orchestrator to PowerShell host', 'The host account', 'On the `PowerShell:PowerShellHost` object'],
      ['PowerShell host to servers and share', '**The same host account, delegated**', 'Kerberos — see below'],
    ],
  }},

  { h2: '5.1 The second hop' },
  { p: 'The third row is the one that needs configuration. Orchestrator connects to the PowerShell host; the host then reaches out to the servers and to the archive share. That is a separate authentication, and by default Windows will not forward the credential to it.' },
  { p: 'The PowerShell host must be set to **Kerberos** — Basic and NTLM cannot carry a credential to a second machine at all. Kerberos can, provided the connection actually delegates, which is a separate condition and the one worth verifying rather than assuming.' },
  { table: {
    head: ['`klist` ticket flags on the host', 'Meaning'],
    widths: [40, 60],
    rows: [
      ['`forwardable forwarded`', 'The credential **was** delegated. The second hop will work — this is a healthy host'],
      ['`forwardable` alone', 'The ticket could have been delegated but was not. The connection is not requesting delegation'],
      ['No `krbtgt` ticket, only `HOST/<pshost>`', 'No delegation at all. The session can act only on the host itself'],
    ],
  }},
  { callout: {
    label: 'A console logon proves nothing',
    tone: 'warn',
    text: 'Logging on to the PowerShell host at the console or over RDP and browsing to `¦¦server¦C$` will succeed whether delegation is configured or not. Both of those logon types hold primary credentials and can authenticate onward; a WinRM session cannot. Same account, same rights, different logon type — and the workflow uses the one that fails. Any verification has to be done in a session **Orchestrator opened**.',
  }},

  { h2: '5.2 Paths must be names, never IP addresses' },
  { p: 'Kerberos authenticates to a service principal name, which is built from a host *name*. There is no such name for an IP address, so a UNC path written with one cannot use Kerberos at all: the connection falls back to NTLM, the delegated credential is of no use to it, and the share answers `Access is denied`.' },
  { p: 'This automation is asymmetrically exposed to it. The **source** paths look after themselves — they are built from Active Directory computer names and so are always fully qualified. The **destination** is the one an operator types, and it is the one likely to have been written as an IP while testing and then left that way.' },
  { callout: {
    label: 'How this presents, and why it misleads',
    tone: 'warn',
    text: 'Because the source paths keep working, a broken destination reports as a failure against **every source server at once**. It reads as though the estate is refusing, or as though the file share has the wrong permissions — and the file share’s permissions are fine. No amount of delegation work will fix it. The workflow warns when it is given an IP, before the share is touched; the remedy is to change the path.',
  }},

  // -------------------------------------------------------------------------
  { pagebreak: {} },
  { h1: '6. Getting code into Orchestrator' },
  { p: 'The repository is the source of truth. Orchestrator holds a copy, and the copy is made by hand today.' },

  { figure: {
    img: IMG.delivery,
    caption: 'Figure 2 — Code delivery, today and planned',
    note: 'This path is shared by both automations in the family and is a **build-time** concern. It is not another hop in the run-time data path, and nothing in it runs while the workflow runs.',
  }},

  { table: {
    head: ['', 'Today', 'Planned'],
    widths: [22, 39, 39],
    rows: [
      ['Mechanism', 'Export from GitLab, paste into Orchestrator', 'GitLab CI publishes on merge, via the Orchestrator REST API'],
      ['Trigger', 'A person, when they remember', 'Merge to the default branch'],
      ['Risk', 'Orchestrator can silently drift from the repository', 'Drift is not possible without a failed pipeline'],
    ],
  }},
  { p: 'Until the pipeline exists, the repository and Orchestrator can disagree and nothing will say so. That is the single largest operational weakness in the current arrangement, and it is a deliberate, recorded gap rather than an oversight.' },

  { pagebreak: {} },
  { h1: '7. Failure behaviour and observability' },

  { h2: '7.1 The result-line contract' },
  { p: 'The script prints readable log lines for people, and exactly one line for Orchestrator:' },
  { code: ['PSO_RESULT={"serversProcessed":4,"serversRequested":5,"moved":118,"errorCount":1,"errors":[...]}'] },
  { p: 'That line is always printed, even when the script does nothing. Everything else in the output can be reworded freely without breaking anything.' },
  { p: 'Because it is always printed, its absence means something real: the script did not finish. `runPowerShellScript` treats a missing result line as a failure rather than as "zero files", so a broken run can never be mistaken for a clean one.' },

  { h2: '7.2 Partial success is a real state' },
  { p: 'One server being switched off does not fail the workflow. The work that could be done is done, the failed servers are named, and `success` comes back false with the counts still populated. A run that moved files from four servers out of five is neither a success nor a failure, and reporting it as either would be wrong.' },

  { h2: '7.3 Errors name the operation, not just the path' },
  { p: 'Windows says `Access is denied` and nothing else. On its own that leaves a reader unable to tell the source share from the destination — and which one it was is the first thing anyone needs to know, because they are different machines with different owners. The script therefore reports what it was doing as well as where:' },
  { code: ['monsrv01.vcf.lab : Access is denied - while listing files in ¦¦monsrv01.vcf.lab¦C$¦...'] },
  { callout: {
    label: 'Why this is worth the trouble',
    tone: 'warn',
    text: 'An earlier version advanced that tracking too late, so a **destination** failure was reported against the **source** path. The message named a server that was working perfectly, and the investigation went to the wrong machine for most of a day. When an error names a path, it is worth confirming the code actually failed on that path.',
  }},

  { h2: '7.4 Report only, and what it does not prove' },
  { p: 'The workflow starts with report-only switched on. A run that is not explicitly told to make changes will only ever list what it would have done.' },
  { callout: {
    label: 'A clean report-only run says nothing about the destination',
    tone: 'warn',
    text: 'Report only never writes to the archive share — both the destination folder check and the per-file check sit behind the report-only test. It can pass perfectly while the share is unwritable, and the failure only appears on the first live run, reported against the source servers. Prove the destination separately, with a real write.',
  }},

  { pagebreak: {} },
  { h1: '8. As deployed' },
  { p: 'Taken from the workflow export. Where this differs from implementation guidance, this section records what exists.' },

  { h2: '8.1 Inputs' },
  { table: {
    head: ['Name', 'Type', 'Control', 'Notes'],
    widths: [26, 15, 24, 35],
    rows: [
      ['`groupDn`', '`string`', 'Text field', 'The group distinguished name'],
      ['`olderThanDays`', '`number`', 'Decimal, min 0', '`0` means every age; negatives rejected'],
      ['`reportOnly`', '`boolean`', 'Checkbox, **default true**', 'Leave the default alone'],
      ['`overwriteExisting`', '`boolean`', 'Checkbox', 'Off means an existing file is reported, not replaced'],
    ],
  }},
  { p: 'The `AD:UserGroup` tree picker was not built; operators supply the distinguished name as text. Adding the picker later needs one extra input and a decision element at the front of the schema, and disturbs nothing downstream.' },

  { h2: '8.2 Attributes' },
  { table: {
    head: ['Name', 'Type', 'Value'],
    widths: [30, 25, 45],
    rows: [
      ['`scriptElement`', '`ResourceElement`', '`Move-ArchivedLogs.ps1`'],
      ['`psHost`', '`PowerShellHost`', 'The registered host'],
      ['`logsFilePath`', '`string`', '`C$¦Windows¦System32¦winevt¦Logs`'],
      ['`fileFilter`', '`string`', '`Archive-*.evtx`'],
      ['`fileServerPath`', '`string`', '`¦¦iaaslabdc.vcf.lab¦archived-logs`'],
      ['`adHost`, `adGroup`, `computerNames`', 'various', 'Empty; carry values between elements'],
      ['`scriptParameters`, `scriptRunResult`', '`Properties`', 'Empty; carry values between elements'],
    ],
  }},

  { h2: '8.3 Open items' },
  { p: 'None of these stops the automation working. All three are recorded so whoever picks it up next is not rediscovering them.' },
  { numbers: [
    '**No workflow outputs are declared.** `Parse Result` computes `success`, `transcript`, `serversProcessed` and `filesMoved`, but the OUT tab is empty, so the values are discarded. Nothing fails and nothing warns; a parent workflow, schedule or API caller simply gets nothing back. The transcript is still in the run log, so this matters only when something needs to consume the result.',
    '**`Create Script Parameters` uses the short boolean conversion**, `reportOnly ? "yes" : "no"`. Correct while the inputs are booleans, which they are. It is recorded because it silently stops being correct if either is ever redeclared as a string — every non-empty string is truthy, so `"no"` becomes `"yes"`, turning overwrite on for an operator who turned it off. Nothing in the log would say so.',
    '**`groupDn` is not marked required** in the input form, though `resolveAdGroup` cannot run without it. A run with it empty fails with a clear message rather than doing anything harmful, so this is cosmetic — but marking it required moves the error to the form, where it belongs.',
  ]},

  { h1: '9. What was deliberately left out' },
  { table: {
    head: ['Not done', 'Why'],
    widths: [30, 70],
    rows: [
      ['Per-server status as separate outputs', 'The script logs per-server results and reports totals. Splitting them into Orchestrator objects means a loop and far more schema for the same information'],
      ['Running servers in parallel', 'Serial output is much easier to read when something has gone wrong, and at this volume it is quick enough'],
      ['Email on completion', 'Not asked for. Orchestrator notification workflows can be attached later without touching this automation'],
      ['vCenter plug-in', 'Considered and rejected. Moving files through VMware Tools needs guest credentials for every server — the opposite of the point'],
      ['Rollback', 'A move is not undone automatically. Report only, then check the destination, is the control'],
      ['Deleting the archived files afterwards', 'The partner automation does that, deliberately. Moving and deleting are separate decisions with separate retention periods; combining them would mean one mistake could destroy logs that were never archived'],
    ],
  }},
];

module.exports = { blocks, IMG };
