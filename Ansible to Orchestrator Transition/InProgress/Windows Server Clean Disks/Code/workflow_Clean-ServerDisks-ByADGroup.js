/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW:  Clean Server Disks by AD Group
 * Name:      Clean-ServerDisks-ByADGroup
 * Folder:    Production >> Servers >> Windows >> Server Disk Management
 * Package:   com.broadcom.pso.servers.windows.serverDiskClean
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * >>> SUPERSEDED AS THE REFERENCE, 2026-09-30 <<<
 *   The workflow is deployed as "Windows Server Disk Cleans". Its export,
 *   Code/serverDiskCleansWorkflow.yml, is now the authoritative definition, and
 *   Documentation/02_Design_Document.md and 03_Implementation_Guide.md describe it.
 *   The deployment renamed several items this sheet still uses:
 *       adGroupDn -> distinguishedName     whatIf -> reportOnly
 *       diskCleanScript -> scriptElement   scriptDirectory -> targetPath (input)
 *       psHostCandidates -> psHosts        scriptPath -> stagedScript
 *       getGroupComputersDirect -> getADComputersGroupDirectMembers
 *   The Closing Summary task for the deployed names is Code/task_ClosingSummary.js.
 *   Keep this file for its reasoning; build from the export.
 *
 * THIS FILE IS THE BUILD SHEET FOR THE CANVAS.
 *   Everything needed to build the workflow in Orchestrator is here: the elements in
 *   order, every IN and OUT binding, the inputs and attributes, the outputs, the
 *   exception routing, and the three scriptable tasks in full at the bottom.
 *
 *   It SUPERSEDES Code/Superseded/Clean-ServerDisks-ByADGroup_spec.js and
 *   Code/Superseded/buildCleanDisksInvocation.js (the cvs_functions.ps1 /
 *   clean-ServerDisk design, July 2026).
 *
 * WHAT THE WORKFLOW DOES
 *   Deletes aged files -- by default everything older than a day in c:\Windows\ccmcache --
 *   from every Windows server that is a DIRECT, ENABLED computer member of an Active
 *   Directory group, or reports what it would delete. Then emails a per-server report.
 *
 *   It replaces servers_diskclean.yml. See Documentation/Change-Register.md.
 *
 * HOW THE WORK IS SPLIT
 *
 *   Active Directory     Orchestrator AD plug-in        elements 1-3
 *   Script delivery      Resource Element + staging     element 6
 *   The clean itself     PowerShell host, over SMB      element 7
 *   Email                Orchestrator Mail plug-in      element 10
 *
 *   Physical servers and VMs are handled identically. The PowerShell host reaches every
 *   target through its admin share (\\server\c$). Nothing touches vCenter.
 *
 * THE SCRIPT AND HOW IT GETS TO THE HOST
 *   Invoke-ServerDiskClean.ps1 is held -- fully commented -- in the Resource Element
 *   PSO/Scripts/Invoke-ServerDiskClean.ps1. Element 6 (stageScriptOnHost) compares it with
 *   the copy on the PowerShell host by SHA-256:
 *
 *       not on the host yet          -> copied               (first run)
 *       an exact match               -> left alone, and run  (every run after that)
 *       any difference at all        -> overwritten, verified, then run
 *
 *   Element 7 then runs the copy on disk by path. The script body crosses WinRM only on a
 *   run where it has changed.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * BEFORE YOU BUILD: actions this workflow uses that ALREADY EXIST
 * ───────────────────────────────────────────────────────────────────────────────
 *   Create each ONCE per Orchestrator and let every workflow call it. A second copy
 *   under a different name drifts silently from the first.
 *
 *     findAdHostForDn          InProgress/_Shared/Code/    (AD plug-in)
 *     resolveAdGroup           InProgress/_Shared/Code/    (AD plug-in)
 *     getGroupComputersDirect  InProgress/_Shared/Code/    (AD plug-in; NON-recursive)
 *     selectPowerShellHost     InProgress/_Shared/Code/    (UPDATED
 *                              2026-09-29: picks the least busy of an ARRAY of hosts;
 *                              input is now psHosts, not psHost -- replace any older copy)
 *
 *   New shared actions, source in InProgress/_Shared/Code/:
 *
 *     stageScriptOnHost        com.broadcom.pso.vcf.powershell.staging   (P-67)
 *     invokeStagedScript       com.broadcom.pso.vcf.powershell.staging   (P-68)
 *
 *   OOTB workflow (ships with Orchestrator -- nothing to import):
 *
 *     Send notification (TLSv1.2)   Library > Mail                          (P-69)
 *
 *   No action is specific to this package. Everything project-specific is in the
 *   three scriptable tasks below and in the .ps1.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE CANVAS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   [Start]
 *      │
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 1. Find AD Host for Group DN      │  Action  findAdHostForDn
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - AD Resolution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 2. Resolve AD Group from DN       │  Action  resolveAdGroup
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - AD Resolution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 3. Get Computers in AD Group      │  Action  getADGroupComputersDirect
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - AD Resolution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 4. Select PowerShell Host         │  Action  selectPowerShellHost
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - PS Execution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 5. Create Script Parameters       │  Scriptable task  (code below)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - Bad Inputs]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 6. Stage Script on Host           │  Action  stageScriptOnHost
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - Script Staging]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 7. Run Disk Clean                 │  Action  invokeStagedScript
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - PS Execution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 8. Parse Results & Build Report   │  Scriptable task  (code below)
 *   └───────────────────────────────────┘
 *      │
 *      ▼
 *   ◇ 9. Email the report?  ◇            Decision  emailReport == true
 *      │ true                 │ false
 *      ▼                      │
 *   ┌───────────────────────┐ │
 *   │ 10. Send Report Email │ │           Workflow  Send notification (TLSv1.2)  (OOTB)
 *   └───────────────────────┘ │
 *      │   └─[Exception]──────┤           → attr emailError, then on to element 11
 *      ▼                      ▼
 *   ┌───────────────────────────────────┐
 *   │ 11. Closing Summary               │  Scriptable task  (code below)
 *   └───────────────────────────────────┘
 *      │
 *      ▼
 *   [End]
 *
 *   ONE completion end state and four failure end states. Nothing is deleted before
 *   element 7, so every failure end state up to and including "Script Staging" means
 *   NOTHING WAS TOUCHED on any target server.
 *
 *     Failed - AD Resolution    the target list was never built
 *     Failed - Bad Inputs       the request itself was wrong
 *     Failed - Script Staging   the host copy could not be made to match Orchestrator's;
 *                               the script was NOT run
 *     Failed - PS Execution     no host, or the script did not run to completion
 *     End                       it RAN -- cleanly, or with per-server problems
 *
 *   WHY PER-SERVER PROBLEMS DO NOT FAIL THE WORKFLOW
 *   A run where 48 of 50 servers were cleaned and 2 were unreachable did its job and
 *   produced its report. It ends normally, executionSuccess is false, and the log and
 *   email say exactly which servers and why. Only a problem that stops the whole run
 *   lands on a Failed end state.
 *
 *   An email that could not be sent is the same: the clean already happened, so it does
 *   not fail the workflow. It sets executionSuccess false and says so (element 11).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ELEMENT-BY-ELEMENT BINDINGS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   "input" = workflow input, "attr" = workflow attribute, "output" = workflow output.
 *
 * ── 1. Find AD Host for Group DN ───────────────────────────────────────────────
 *    Action:    findAdHostForDn
 *    IN    distinguishedName   string              ← input  adGroupDn
 *    OUT   actionResult        AD:AdHost           → attr   adHost
 *    Exception → [End: Failed - AD Resolution]
 *
 *    The DN's DC= parts name the domain, so the AD endpoint follows from the group and
 *    there is no "which domain?" input to disagree with it. (Replaces var_DomainName.)
 *
 * ── 2. Resolve AD Group from DN ────────────────────────────────────────────────
 *    Action:    resolveAdGroup
 *    IN    adGroupDn           string              ← input  adGroupDn
 *          adHost              AD:AdHost           ← attr   adHost
 *    OUT   actionResult        AD:UserGroup        → attr   adGroup
 *    Exception → [End: Failed - AD Resolution]
 *
 * ── 3. Get Computers in AD Group ───────────────────────────────────────────────
 *    Action:    getGroupComputersDirect
 *    IN    adGroup             AD:UserGroup        ← attr   adGroup
 *    OUT   actionResult        Array/string        → attr   computerNames
 *    Exception → [End: Failed - AD Resolution]
 *
 *    DIRECT members only; nested groups are named in a warning and NOT expanded;
 *    disabled computer accounts are skipped. Deleting files is destructive, so the
 *    target list is exactly what someone put in the group -- the same rule as the
 *    Server Reboots workflow (S-7), and the same targeting the Ansible script used
 *    (Get-ADGroupMember without -Recursive). DO NOT substitute the recursive
 *    getGroupComputers from the Move Archived Logs package.
 *
 * ── 4. Select PowerShell Host ──────────────────────────────────────────────────
 *    Action:    selectPowerShellHost
 *    IN    psHosts             Array/PowerShell:PowerShellHost  ← attr   psHostCandidates
 *    OUT   actionResult        PowerShell:PowerShellHost        → attr   resolvedHost
 *    Exception → [End: Failed - PS Execution]
 *
 *    AUTOMATIC -- there is no host picker on the form. Each host in psHostCandidates is
 *    probed once and the one with the lowest resource utilization wins:
 *
 *        score = cpu% + 0.5 x memory-in-use% + 20 x other ACTIVE remote PS sessions
 *
 *    Hosts that do not answer are warned about and skipped; the run stops only if none
 *    answers. A list of one is used without probing. The log lists every candidate, its
 *    figures, its score, and the choice.
 *
 *    WHICH HOSTS ARE CANDIDATES IS DECIDED AT BUILD TIME, in psHostCandidates. The action
 *    does not check what domain a host is in: list only hosts whose account can reach
 *    this workflow's targets (local admin over \\server\c$ -- see BEFORE THE FIRST
 *    PRODUCTION RUN).
 *
 * ── 5. Create Script Parameters ────────────────────────────────────────────────
 *    Scriptable task        ← code at the bottom of this file
 *    IN    computerNames       Array/string        ← attr   computerNames
 *          adGroup             AD:UserGroup        ← attr   adGroup
 *          folderTarget        Array/string        ← input  folderTarget
 *          olderThanDays       number              ← input  olderThanDays
 *          folderIncluded      boolean             ← input  folderIncluded
 *          forceEnable         boolean             ← input  forceEnable
 *          whatIf              string              ← input  whatIf
 *          fileFilter          string              ← input  fileFilter
 *          maxItemsListed      number              ← attr   maxItemsListed
 *          emailReport         boolean             ← input  emailReport
 *          mailTo              Array/string        ← input  mailTo
 *    OUT   scriptParameters    Properties          → attr   scriptParameters
 *          mailToString        string              → attr   mailToString
 *    Exception → [End: Failed - Bad Inputs]
 *
 *    Validates EVERYTHING before the host is touched -- including the email recipients,
 *    because a run that deletes files and then cannot say what it deleted is worse than
 *    one that stops at the start.
 *
 * ── 6. Stage Script on Host ────────────────────────────────────────────────────
 *    Action:    stageScriptOnHost
 *    IN    psHost              PowerShell:PowerShellHost  ← attr   resolvedHost
 *          script              ResourceElement            ← attr   diskCleanScript
 *          targetPath          string                     ← attr   scriptDirectory   (the DIRECTORY)
 *    OUT   actionResult        string                     → attr   scriptPath
 *    Exception → [End: Failed - Script Staging]
 *
 *    Builds the full path  targetPath + '\' + <Resource Element name>
 *    (C:\PSO\Scripts\Invoke-ServerDiskClean.ps1), copies the script there if it is missing
 *    or differs, verifies it, and returns that path. The log line
 *        staged: <path> | <name> v<version> | sha256=<12 hex> | first copy|updated|unchanged
 *    records which generation this run executes. 'updated' on a run where nobody changed
 *    the Resource Element means the copy on the host had been edited; the action has
 *    already logged both hashes as a warning.
 *
 * ── 7. Run Disk Clean ──────────────────────────────────────────────────────────
 *    Action:    invokeStagedScript
 *    IN    psHost              PowerShell:PowerShellHost  ← attr   resolvedHost
 *          scriptPath          string                     ← attr   scriptPath
 *          parameters          Properties                 ← attr   scriptParameters
 *    OUT   actionResult        Properties                 → attr   scriptRunResult
 *    Exception → [End: Failed - PS Execution]
 *
 *    psHost must be the same attribute element 6 used, and scriptPath must be the path
 *    element 6 RETURNED -- that is what guarantees the file run is the file just verified.
 *
 *    scriptRunResult holds: success (boolean), transcript (string), and result
 *    (Properties) with the script's PSO_RESULT fields -- see the .ps1's .OUTPUTS. The
 *    per-server list arrives as a JSON STRING under result.servers.
 *
 * ── 8. Parse Results & Build Report ────────────────────────────────────────────
 *    Scriptable task        ← code at the bottom of this file
 *    IN    scriptRunResult     Properties                 ← attr   scriptRunResult
 *          adGroup             AD:UserGroup               ← attr   adGroup
 *          resolvedHost        PowerShell:PowerShellHost  ← attr   resolvedHost
 *          scriptPath          string                     ← attr   scriptPath
 *          folderIncluded      boolean                    ← input  folderIncluded
 *          forceEnable         boolean                    ← input  forceEnable
 *          mailSubject         string                     ← input  mailSubject
 *    OUT   executionSuccess    boolean                    → output executionSuccess
 *          executionOutput     string                     → output executionOutput
 *          serversProcessed    number                     → output serversProcessed
 *          itemsDeleted        number                     → output itemsDeleted
 *          bytesFreed          number                     → output bytesFreed
 *          transcript          string                     → output transcript
 *          reportSubject       string                     → attr   reportSubject
 *          reportHtml          string                     → attr   reportHtml
 *
 *    BIND EVERY OUT. An unbound OUT is not an error and produces no warning: the value is
 *    computed and thrown away, and the workflow finishes looking successful with nothing
 *    to show for it.
 *
 * ── 9. Email the report? ───────────────────────────────────────────────────────
 *    Decision:  input emailReport  is  true
 *    true  → element 10          false → element 11
 *
 * ── 10. Send Report Email ──────────────────────────────────────────────────────
 *    Type:      Workflow element  →  Library > Mail > "Send notification (TLSv1.2)"  (OOTB)
 *    IN    smtpHost            string              ← input  smtpHost      (blank = plug-in default)
 *          smtpPort            number              ← input  smtpPort      (0 = plug-in default)
 *          username            string              (leave NOT BOUND)
 *          password            SecureString        (leave NOT BOUND)
 *          fromName            string              (leave NOT BOUND)
 *          fromAddress         string              ← input  fromAddress   (blank = plug-in default)
 *          toAddress           string              ← attr   mailToString  (built by element 5)
 *          subject             string              ← attr   reportSubject
 *          content             string              ← attr   reportHtml
 *          useStartTls         boolean             (leave NOT BOUND = false)
 *    OUT   (none)
 *    Exception → bind to attr emailError, and route to element 11 (NOT to a Failed end)
 *
 *    The OOTB workflow overrides a Mail plug-in default only when the input is non-empty,
 *    so unbound / blank inputs use the settings from Library > Mail > Configuration >
 *    'Configure mail'. username / password are deliberately left unbound: the customer's
 *    relay is anonymous today. That also means any credentials stored in 'Configure mail'
 *    WILL be used -- keep them empty there for an anonymous relay. The workflow logs
 *    "sending mail to host: ... with user: ..." so one test run shows what it used.
 *
 *    WHY THE EXCEPTION GOES TO ELEMENT 11, NOT A FAILED END. Unlike a custom action, the
 *    OOTB workflow THROWS when the relay rejects or cannot be reached. By then the clean
 *    has already happened; ending on a Failed state would make a completed run look as if
 *    nothing was done. Element 11 records it as "completed, report NOT emailed" instead.
 *
 *    NO CC. The OOTB workflow has no CC input, so this workflow has no mailCc input.
 *    Put every recipient in mailTo.
 *
 * ── 11. Closing Summary ────────────────────────────────────────────────────────
 *    Scriptable task        ← code at the bottom of this file
 *    IN    executionSuccess    boolean             ← output executionSuccess
 *          executionOutput     string              ← output executionOutput
 *          emailReport         boolean             ← input  emailReport
 *          emailError          string              ← attr   emailError
 *          adGroup             AD:UserGroup        ← attr   adGroup
 *          whatIf              string              ← input  whatIf
 *          scriptPath          string              ← attr   scriptPath
 *    OUT   executionSuccess    boolean             → output executionSuccess
 *
 *    Reached three ways: from element 10 normally (report sent), from element 10's
 *    exception (emailError holds the reason), or from decision 9's false branch (email
 *    off). executionSuccess is on BOTH tabs: it arrives from element 8 and leaves false if
 *    the report was wanted and not sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW INPUTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Defaults set DIRECTLY on each input -- no Configuration Element to install first.
 *
 *   Name            Type                       Default                                     Mand.
 *   ─────────────── ────────────────────────── ─────────────────────────────────────────── ─────
 *   adGroupDn       string                     (none)                                      Yes
 *   folderTarget    Array/string               [ c:\Windows\ccmcache ]                     Yes
 *   fileFilter      string                     *.*                                         Yes
 *   olderThanDays   number                     1                                           Yes
 *   folderIncluded  boolean                    false                                       Yes
 *   forceEnable     boolean                    false                                       Yes
 *   whatIf          string                     yes                                         Yes
 *   emailReport     boolean                    true                                        Yes
 *   mailTo          Array/string               (set to real recipients)                    No
 *   mailSubject     string                     VCF Orchestrator: Windows Server Disk Clean No
 *   smtpHost        string                     (blank = Mail plug-in default)              No
 *   smtpPort        number                     0 (= plug-in default)                       No
 *   fromAddress     string                     (blank = Mail plug-in default)              No
 *
 *   PRESENTATION
 *
 *   whatIf        ** THE SAFETY GATE. ** A PREDEFINED ANSWERS list with exactly two
 *                 values: 'yes' (label "Report only - delete nothing") and 'no' (label
 *                 "Delete for real"). Default 'yes'. Element 5 refuses anything else.
 *
 *   adGroupDn     The group's distinguishedName, e.g.
 *                 CN=CVS-DPT-AllServers,OU=Groups,DC=dom4,DC=invalid
 *                 The domain, the AD endpoint and the target list all follow from it.
 *
 *   folderTarget  One LOCAL path per row, as seen on each server. The production values
 *                 (Ansible), and what each needs on this form (S-35 / P-71):
 *
 *                   Cache cleanup (6)    c:\Windows\ccmcache  1 day   folders ON, force off
 *                   Profile cleanup (2)  c:\users             0 days  folders ON, force ON
 *
 *                 The cache templates' combination (folders ON, force OFF) now cleans
 *                 FILES ONLY -- the hash-named package folders stay. To keep removing them,
 *                 tick "delete read-only items" too; decide with the cache owner before
 *                 migrating those six templates.
 *
 *   olderThanDays Label: "Delete items older than N days". 0 = everything up to now.
 *
 *   Put the mail inputs in an "Email report" section shown when emailReport is true, and
 *   folderIncluded / forceEnable / smtp* in an "Advanced" section. An operator running
 *   this day to day should see a DN, the folders, the age, and the safety gate.
 *
 *   fileFilter    Label: "Delete files matching (wildcards supported)". Default '*.*'.
 *                 Applies to FILES only -- folders are chosen by age, whatever their name.
 *
 *   folderIncluded / forceEnable / fileFilter -- THE FOLDER RULE (S-35 / P-71):
 *                 deleting a folder deletes EVERYTHING in it, so "delete folder" is only
 *                 performed together with fileFilter '*' or '*.*' AND forceEnable ticked.
 *                 With any other combination the run still goes ahead, but FOLDER DELETION
 *                 IS DECLINED: element 5 warns, the script leaves every folder in place and
 *                 cleans only the files matching fileFilter, and the log, summary and email
 *                 say so. Nothing is ever escalated automatically. Put this in each field's
 *                 custom help so the operator knows before pressing Run.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW ATTRIBUTES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Name              Type                       Set by           Value
 *   ───────────────── ────────────────────────── ──────────────── ─────────────────────────────────────────
 *   diskCleanScript   ResourceElement            YOU, at build    PSO/Scripts/Invoke-ServerDiskClean.ps1
 *   scriptDirectory   string                     YOU, at build    C:\PSO\Scripts
 *   maxItemsListed    number                     YOU, at build    25
 *   psHostCandidates  Array/PowerShell:          YOU, at build    the PowerShell host objects this
 *                     PowerShellHost                              workflow may run on (one or more)
 *   adHost            AD:AdHost                  element 1
 *   adGroup           AD:UserGroup               element 2
 *   computerNames     Array/string               element 3
 *   resolvedHost      PowerShell:PowerShellHost  element 4
 *   scriptParameters  Properties                 element 5
 *   scriptPath        string                     element 6
 *   scriptRunResult   Properties                 element 7
 *   reportSubject     string                     element 8
 *   reportHtml        string                     element 8
 *   mailToString      string                     element 5        mailTo joined with ','
 *   emailError        string                     element 10       exception binding (default empty)
 *
 *   diskCleanScript is an ATTRIBUTE bound to the element, not a name looked up at run
 *   time, so the run record shows which Resource Element was staged.
 *
 *   scriptDirectory: created on first staging. The account the
 *   PowerShell host object connects as needs Modify on it (to stage) and Read & Execute
 *   (to run). Nobody else needs write access -- and should not have it: anything written
 *   there is overwritten on the next run anyway.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW OUTPUTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   executionSuccess  boolean  true only if every server was cleaned (or reported) with no
 *                              error AND, when emailReport is on, the report was sent
 *   executionOutput   string   one-line summary
 *   serversProcessed  number   servers whose admin share could be opened
 *   itemsDeleted      number   items removed (0 in a report-only run)
 *   bytesFreed        number   bytes removed; in a report-only run, the estimate of what
 *                              would be removed
 *   scriptPath        string   bind attr scriptPath here too: the staged script that ran
 *                              (its version and hash are in element 6's log line)
 *   transcript        string   the script's full log
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAILURE HANDLING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Condition                                          Element  End state
 *   ────────────────────────────────────────────────── ───────  ──────────────────────────────
 *   adGroupDn is not a DN / no AD endpoint for it          1    Failed - AD Resolution
 *   Group not found on that endpoint                       2    Failed - AD Resolution
 *   Plug-in will not report group membership               3    Failed - AD Resolution
 *   Nested group in the group                              3    warned, not expanded → continues
 *   Disabled computer account                              3    skipped + logged → continues
 *   psHostCandidates empty                                 4    Failed - PS Execution
 *   No candidate host answers its probe                    4    Failed - PS Execution
 *   A candidate host does not answer its probe             4    warned, skipped → continues
 *   Zero direct enabled computer members                   5    Failed - Bad Inputs
 *   whatIf not 'yes'/'no'; bad age; bad/refused folder     5    Failed - Bad Inputs
 *   'delete folder' without fileFilter '*'/'*.*' + force  5+7  warned; folders NOT deleted, files still cleaned
 *   empty fileFilter                                       5    Failed - Bad Inputs
 *   Email on with no recipient                             5    Failed - Bad Inputs
 *   Resource Element empty                                 6    Failed - Script Staging
 *   Host copy could not be probed / written / verified     6    Failed - Script Staging
 *   Script parameter rejected, session cut, no result      7    Failed - PS Execution
 *   A server's admin share cannot be opened                8    End, executionSuccess=false
 *   A folder target missing on some servers                8    End (warning only)
 *   A folder target missing on EVERY reachable server      8    End, executionSuccess=false
 *   An item could not be deleted / a folder not read       8    End, executionSuccess=false
 *   Report could not be emailed (element 10 threw)        11    End, executionSuccess=false
 *   Everything handled cleanly                            11    End, executionSuccess=true
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * BEFORE THE FIRST PRODUCTION RUN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   ACCESS. The PowerShell host object's account needs LOCAL ADMINISTRATOR on every target
 *   (the admin share requires it) and SMB/445 to each. This is the second hop -- the same
 *   Kerberos delegation requirement as every other workflow in the programme
 *   (Script-Staging-Design.md §6.3). Test it with a report-only run: an 'Unreachable'
 *   server saying 'Access is denied' is a delegation or rights problem, not a network one.
 *
 *   MAIL -- A NETWORK REQUIREMENT, NOT JUST A SETTING. The report is sent by ORCHESTRATOR
 *   (Mail plug-in), so every Orchestrator appliance node must reach the SMTP relay:
 *   TCP 25 (or the configured port), DNS resolution of the relay name, and the relay must
 *   accept mail from the appliance addresses. The PowerShell host's relay access does NOT
 *   cover this -- request the firewall rule / relay allow-list for the appliance addresses.
 *   Then run 'Configure mail' (Library > Mail > Configuration) once, or fill smtpHost and
 *   fromAddress on the inputs; leave its username/password empty for an anonymous relay.
 *   'Send notification (TLSv1.2)' logs the host and user it actually used; prove the path
 *   with a report-only run with email on before the first live run. Details:
 *   _Shared/Documentation/Email-Notification-Standard.md.
 *
 *   TIMEOUTS. The clean is ONE synchronous PowerShell invocation; deleting a large cache
 *   over SMB is slow (per item, not per byte). WinRM MaxTimeoutms on the host and the
 *   PowerShell plug-in timeout must both exceed the longest run. A report-only run's
 *   duration is a lower bound for the live run against the same group.
 *
 *   PROVE IT IN THIS ORDER. Report-only against the real group. Then live against a group
 *   holding ONE server. Only then the full group. For the profile templates (c:\users,
 *   0 days, force on) read the "READ THIS" note in the .ps1 first: a folder older than the
 *   cutoff is removed with everything inside it, which is exactly how those templates
 *   remove whole profiles.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   THE THREE SCRIPTABLE TASKS FOLLOW. Each block is one element's code, complete.
 *   Copy from the banner down to the next banner. Nothing outside a block is code.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */


/* ═════════════════════════════════════════════════════════════════════════════
 * ELEMENT 5 -- "Create Script Parameters"          (scriptable task)
 *
 * IN   computerNames   Array/string    attr    from element 3
 *      adGroup         AD:UserGroup    attr    from element 2
 *      folderTarget    Array/string    input
 *      olderThanDays   number          input
 *      folderIncluded  boolean         input
 *      forceEnable     boolean         input
 *      whatIf          string          input
 *      fileFilter      string          input   (default '*.*')
 *      maxItemsListed  number          attr    (25)
 *      emailReport     boolean         input
 *      mailTo          Array/string    input
 * OUT  scriptParameters  Properties    attr    → element 7 'parameters'
 *      mailToString      string        attr    → element 10 'toAddress'
 *
 * Does no work of its own. Checks the request, turns it into the Properties bag
 * Invoke-ServerDiskClean.ps1 expects, and says in the log what it decided. Nothing has
 * touched the PowerShell host or any server yet, so every refusal here is free.
 * ═════════════════════════════════════════════════════════════════════════════ */

function trim(value) {
    return (value === null || value === undefined) ? "" : String(value).replace(/^\s+|\s+$/g, "");
}

// -- 1. Refuse to run against nothing -----------------------------------------
if (computerNames === null || computerNames === undefined || computerNames.length === 0) {
    throw new Error(
        "Create Script Parameters: no servers were resolved. The AD group has no enabled computer " +
        "accounts as DIRECT members -- nested groups are deliberately not expanded for a destructive " +
        "action. Check the 'Get Computers in AD Group' log: if it named nested groups, that is where " +
        "the servers are."
    );
}
var groupName = String(adGroup.name);
System.log("Servers (" + computerNames.length + ") in '" + groupName + "': " + computerNames.join(", "));

// -- 2. The safety gate -------------------------------------------------------
// Only the exact value 'no' deletes. The script's -ReportOnly has ValidateSet('yes','no'),
// so it would refuse anything else too -- but refusing here gives the operator a message
// naming the input instead of a PowerShell parameter-binding error.
var gate = trim(whatIf).toLowerCase();
if (gate !== "yes" && gate !== "no") {
    throw new Error(
        "Create Script Parameters: whatIf must be 'yes' (report only - delete nothing) or 'no' " +
        "(delete for real). Received: '" + whatIf + "'."
    );
}

// -- 3. Age --------------------------------------------------------------------
var days = Number(olderThanDays);
if (olderThanDays === null || olderThanDays === undefined || isNaN(days) || days < 0 || Math.floor(days) !== days) {
    throw new Error(
        "Create Script Parameters: olderThanDays must be a whole number, 0 or greater " +
        "(1 = older than a day, 0 = everything up to now). Received: " + olderThanDays
    );
}

// -- 4. Folder targets ----------------------------------------------------------
// The same refusals the script makes (Test-FolderTarget, S-36), made here first so a bad
// path never reaches the host: a drive root, or anything that IS or is INSIDE a protected
// operating-system tree -- except the known-safe cache folders below (and anything inside
// them). c:\users is deliberately allowed -- two production templates clean it.
//
// KEEP THESE TWO LISTS IDENTICAL TO THE SCRIPT'S. To allow another folder inside a
// protected tree, add it here AND to $AllowedInsideProtected in Invoke-ServerDiskClean.ps1.
var protectedTrees = ["\\windows", "\\program files", "\\program files (x86)", "\\programdata",
                      "\\boot", "\\recovery", "\\system volume information"];
var allowedInsideProtected = ["\\windows\\ccmcache", "\\windows\\temp", "\\windows\\softwaredistribution\\download"];

function isOrInside(candidate, tree) {
    return candidate === tree || candidate.indexOf(tree + "\\") === 0;
}
var folders = [];
if (folderTarget !== null && folderTarget !== undefined) {
    for (var f = 0; f < folderTarget.length; f++) {
        var path = trim(folderTarget[f]).replace(/\//g, "\\");
        if (path === "") { continue; }
        if (!/^[a-zA-Z]:\\/.test(path)) {
            throw new Error("Create Script Parameters: folderTarget '" + path + "' must be an absolute local path with a drive letter, as seen on the server (e.g. c:\\Windows\\ccmcache).");
        }
        if (/[*?"<>|]/.test(path) || /(^|\\)\.\.(\\|$)/.test(path)) {
            throw new Error("Create Script Parameters: folderTarget '" + path + "' contains a wildcard, '..', or a character not valid in a path.");
        }
        var rest = path.substring(2).replace(/\\+$/, "").toLowerCase();
        if (rest === "") {
            throw new Error("Create Script Parameters: folderTarget '" + path + "' is the root of a drive. That is never a disk-clean target.");
        }
        var allowed = false;
        for (var a = 0; a < allowedInsideProtected.length; a++) {
            if (isOrInside(rest, allowedInsideProtected[a])) { allowed = true; break; }
        }
        if (!allowed) {
            for (var r = 0; r < protectedTrees.length; r++) {
                if (isOrInside(rest, protectedTrees[r])) {
                    var drive = path.substring(0, 2);
                    throw new Error(
                        "Create Script Parameters: folderTarget '" + path + "' is inside the protected operating-system folder " +
                        drive + protectedTrees[r] + " and is refused. The only folders allowed there are " +
                        allowedInsideProtected.map(function (x) { return drive + x; }).join(", ") + " (and anything inside them)."
                    );
                }
            }
        }
        folders.push(path);
    }
}
if (folders.length === 0) {
    throw new Error("Create Script Parameters: folderTarget is empty. Give at least one folder, e.g. c:\\Windows\\ccmcache.");
}

// -- 5. Tick-boxes to the 'yes'/'no' the script expects -------------------------
// Read, not tested for truth: if one of these inputs were ever declared as a string,
// "no" is truthy in JavaScript and  value ? "yes" : "no"  would silently turn it on.
// For forceEnable that would delete read-only files the operator chose to protect.
function yesNo(value) {
    if (value === true)  { return "yes"; }
    if (value === false) { return "no"; }
    var text = trim(value).toLowerCase();
    return (text === "yes" || text === "true" || text === "1") ? "yes" : "no";
}
var folderFlag = yesNo(folderIncluded);
var forceFlag  = yesNo(forceEnable);

// -- 6. Email must be deliverable BEFORE anything is deleted --------------------
// The OOTB 'Send notification (TLSv1.2)' workflow takes ONE toAddress string, so the
// recipients are flattened here into a comma-separated list. An entry may itself hold
// several addresses separated by , or ; -- each is trimmed and blanks are dropped.
var recipients = [];
if (mailTo !== null && mailTo !== undefined) {
    for (var m = 0; m < mailTo.length; m++) {
        var pieces = String(mailTo[m] === null || mailTo[m] === undefined ? "" : mailTo[m]).split(/[,;]/);
        for (var q = 0; q < pieces.length; q++) {
            var address = trim(pieces[q]);
            if (address === "") { continue; }
            // Catches the classic binding mistake: a scalar string bound where an array was
            // expected arrives split into single characters, none of which contain '@'.
            if (address.indexOf("@") < 1) {
                throw new Error("Create Script Parameters: '" + address + "' in mailTo is not an email address. Enter one address per row.");
            }
            recipients.push(address);
        }
    }
}
mailToString = recipients.join(",");

if (yesNo(emailReport) === "yes" && recipients.length === 0) {
    throw new Error("Create Script Parameters: emailReport is ticked but mailTo has no recipient. Add one, or untick emailReport.");
}

// -- 7. Say plainly what this run will do ----------------------------------------
if (gate === "no") {
    System.warn(
        "whatIf='no' -- this run WILL DELETE items older than " + days + " day(s) from " + folders.join(", ") +
        " on " + computerNames.length + " server(s) in '" + groupName + "'" +
        (forceFlag === "yes" ? ", INCLUDING read-only items (forceEnable)" : "") +
        (folderFlag === "yes" ? ", and whole folders older than the cutoff" : "") + "."
    );
}
else {
    System.log("whatIf='yes' -- report-only run; nothing will be deleted.");
}

// -- 7b. The folder rule (S-35 / P-71) -------------------------------------------
// fileFilter applies to FILES only; folders are chosen by age, whatever their name. But a
// folder is deleted WHOLE, with everything in it -- so folders are deleted only when the
// request says so in full: a filter matching every file AND permission to delete read-only
// items. With anything less, folder deletion is DECLINED but the run continues and matching
// files are still cleaned. The decision is made by the SCRIPT (so its log and the report
// record it); this task only says so up front. It never widens a request.
var filter = trim(fileFilter);
if (filter === "") {
    throw new Error("Create Script Parameters: fileFilter is empty. Use '*.*' for every file, or a pattern such as '*.tmp'.");
}
if (folderFlag === "yes") {
    var problems = [];
    if (filter !== "*" && filter !== "*.*") {
        problems.push("fileFilter is '" + filter + "', which does not match every file (use '*' or '*.*')");
    }
    if (forceFlag !== "yes") {
        problems.push("'delete read-only items' (forceEnable) is not ticked");
    }
    if (problems.length > 0) {
        System.warn(
            "'Delete folder' is ticked, but " + problems.join(" and ") + ". Deleting a folder deletes everything in it, " +
            "so FOLDERS WILL NOT BE DELETED on this run. Files matching '" + filter + "' are still processed. " +
            "To delete folders as well, set fileFilter to '*.*' AND tick 'delete read-only items'."
        );
    }
}

var listed = Number(maxItemsListed);
if (isNaN(listed) || listed < 0) { listed = 25; }

// -- 8. Build the bag -----------------------------------------------------------
// Keys are the script's parameter names; invokeStagedScript turns each into -Key 'value'.
scriptParameters = new Properties();
scriptParameters.put("ComputerNames",  computerNames.join(","));
scriptParameters.put("FolderTarget",   folders.join("|"));      // '|' can never appear in a path
scriptParameters.put("OlderThanDays",  String(days));
scriptParameters.put("FilterOn",       filter);
scriptParameters.put("FolderIncluded", folderFlag);
scriptParameters.put("ForceEnable",    forceFlag);
scriptParameters.put("ReportOnly",     gate);                   // whatIf 'yes' == ReportOnly 'yes'
scriptParameters.put("MaxItemsListed", String(Math.floor(listed)));

System.log(
    "servers=" + computerNames.length + ", folders=" + folders.join(" | ") + ", olderThanDays=" + days +
    ", folderIncluded=" + folderFlag + ", forceEnable=" + forceFlag + ", whatIf=" + gate
);


/* ═════════════════════════════════════════════════════════════════════════════
 * ELEMENT 8 -- "Parse Results & Build Report"      (scriptable task)
 *
 * IN   scriptRunResult   Properties                 attr    from element 7
 *      adGroup           AD:UserGroup               attr    from element 2
 *      resolvedHost      PowerShell:PowerShellHost  attr    from element 4
 *      scriptPath        string                     attr    from element 6
 *      folderIncluded    boolean                    input
 *      forceEnable       boolean                    input
 *      mailSubject       string                     input
 * OUT  executionSuccess  boolean     output
 *      executionOutput   string      output
 *      serversProcessed  number      output
 *      itemsDeleted      number      output
 *      bytesFreed        number      output
 *      transcript        string      output
 *      reportSubject     string      attr    → element 10
 *      reportHtml        string      attr    → element 10
 *      -- BIND ALL EIGHT
 *
 * Takes the script's result apart into the workflow outputs, logs the outcome, and builds
 * the HTML report. It always builds the report, even when email is off: it costs nothing,
 * and it keeps this task the same on both branches of the decision that follows.
 * ═════════════════════════════════════════════════════════════════════════════ */

if (scriptRunResult === null || scriptRunResult === undefined) {
    throw new Error(
        "Parse Results & Build Report: scriptRunResult is empty. Bind this task's scriptRunResult input to " +
        "the output of the 'Run Disk Clean' element."
    );
}

var reported = scriptRunResult.get("result");
executionSuccess = scriptRunResult.get("success");
transcript       = scriptRunResult.get("transcript");

var wasReportOnly = (reported.get("reportOnly") === true);
var requested     = reported.get("serversRequested");
var unreachable   = reported.get("serversUnreachable");
var withErrors    = reported.get("serversWithErrors");
var matched       = reported.get("itemsMatched");
var failedItems   = reported.get("itemsFailed");
var errorCount    = reported.get("errorCount");

serversProcessed = reported.get("serversReachable");
itemsDeleted     = reported.get("itemsRemoved");
bytesFreed       = reported.get("bytes");

// invokeStagedScript hands structured values over as JSON TEXT, but an EMPTY list is an
// array of strings as far as it can tell, so it arrives as a real (empty) array. Accept both.
var servers = [];
var rawServers = reported.get("servers");
if (rawServers !== null && rawServers !== undefined) {
    if (typeof rawServers === "string") {
        if (rawServers.replace(/^\s+|\s+$/g, "") !== "") {
            try { servers = JSON.parse(rawServers); } catch (eS) { System.warn("Could not read the per-server list: " + eS); }
        }
    }
    else if (rawServers.length !== undefined) {
        servers = [];
        for (var sv0 = 0; sv0 < rawServers.length; sv0++) { servers.push(rawServers[sv0]); }
    }
}
if (servers === null || servers === undefined) { servers = []; }
if (!(servers instanceof Array)) { servers = [servers]; }   // one server may arrive as a bare object

// Folder deletion requested but declined by the script's guard (S-35). Empty otherwise.
var foldersDeclined = reported.get("foldersDeclined");
foldersDeclined = (foldersDeclined === null || foldersDeclined === undefined) ? "" : String(foldersDeclined);

var targets = reported.get("targets") || [];

function formatBytes(n) {
    if (n === null || n === undefined || isNaN(Number(n))) { return "-"; }
    n = Number(n);
    var units = ["bytes", "KB", "MB", "GB", "TB"], u = 0;
    while (n >= 1024 && u < units.length - 1) { n = n / 1024; u++; }
    return (u === 0 ? String(n) : n.toFixed(u >= 3 ? 2 : 1)) + " " + units[u];
}

// -- The one-line summary -----------------------------------------------------
if (wasReportOnly) {
    executionOutput = "REPORT ONLY -- " + matched + " item(s), about " + formatBytes(bytesFreed) +
        ", would be deleted across " + serversProcessed + " of " + requested + " server(s). Nothing was deleted.";
}
else {
    executionOutput = itemsDeleted + " item(s), " + formatBytes(bytesFreed) + ", deleted across " +
        serversProcessed + " of " + requested + " server(s)" +
        (failedItems > 0 ? "; " + failedItems + " item(s) could not be deleted" : "") + ".";
}
if (unreachable > 0) {
    executionOutput += " " + unreachable + " server(s) unreachable.";
}
if (foldersDeclined !== "") {
    executionOutput += " Folder deletion was requested but declined (files only).";
    System.warn(foldersDeclined);
}

// -- Log it ---------------------------------------------------------------------
if (executionSuccess) {
    System.log("Finished. " + executionOutput);
}
else {
    System.warn("Finished with " + errorCount + " error(s) on " + (withErrors + unreachable) + " server(s). " + executionOutput);
    var errors = reported.get("errors");
    if (errors !== null && errors !== undefined && errors.length > 0) {
        System.warn("The first errors were:");
        for (var i = 0; i < errors.length; i++) { System.warn("  " + errors[i]); }
    }
    for (var s = 0; s < servers.length; s++) {
        if (servers[s].status === "Unreachable" || servers[s].status === "Failed" || servers[s].status === "CleanedWithErrors") {
            System.warn("  " + servers[s].name + " -- " + servers[s].status + ": " + servers[s].detail);
        }
    }
}

// -- The HTML report --------------------------------------------------------------
function esc(text) {
    return String(text === null || text === undefined ? "" : text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

var statusStyle = {
    "Cleaned":           ["#1E7B34", "Cleaned"],
    "CleanedWithErrors": ["#B00020", "Cleaned with errors"],
    "ReportOnly":        ["#8A6D00", "Report only"],
    "Unreachable":       ["#B00020", "UNREACHABLE"],
    "Failed":            ["#B00020", "FAILED"]
};

// Problems first, then alphabetical: the rows someone has to act on are at the top.
var rank = { "Unreachable": 0, "Failed": 0, "CleanedWithErrors": 1, "ReportOnly": 2, "Cleaned": 3 };
servers.sort(function (a, b) {
    var d = (rank[a.status] === undefined ? 9 : rank[a.status]) - (rank[b.status] === undefined ? 9 : rank[b.status]);
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
});

var font  = "font-family:Segoe UI,Arial,sans-serif;font-size:12px;";
var th    = "border:1px solid #B4B4B4;padding:5px 7px;background-color:#44546A;color:#FFFFFF;text-align:left;font-weight:600;";
var td    = "border:1px solid #B4B4B4;padding:4px 7px;vertical-align:top;";
var tdNum = td + "text-align:right;";

var rows = "";
for (var k = 0; k < servers.length; k++) {
    var sv = servers[k];
    var st = statusStyle[sv.status] || ["#000000", sv.status];
    rows +=
        "<tr>" +
        "<td style=\"" + td + "\">" + esc(sv.name) + "</td>" +
        "<td style=\"" + td + "color:" + st[0] + ";font-weight:600;\">" + esc(st[1]) + "</td>" +
        "<td style=\"" + tdNum + "\">" + esc(sv.matched) + "</td>" +
        "<td style=\"" + tdNum + "\">" + (wasReportOnly ? "-" : esc(sv.removed)) + "</td>" +
        "<td style=\"" + tdNum + "\">" + (wasReportOnly ? "-" : esc(sv.failed)) + "</td>" +
        "<td style=\"" + tdNum + "\">" + esc(formatBytes(sv.bytes)) + "</td>" +
        "<td style=\"" + tdNum + "\">" + esc(formatBytes(sv.freeBefore)) + "</td>" +
        "<td style=\"" + tdNum + "\">" + esc(formatBytes(sv.freeAfter)) + "</td>" +
        "<td style=\"" + td + "\">" + esc(sv.detail) + "</td>" +
        "</tr>";
}

var sizeHeader = wasReportOnly ? "Would free (est.)" : "Freed";

reportHtml =
    "<div style=\"" + font + "\">" +
    "<p style=\"" + font + "font-size:14px;font-weight:600;\">" + esc(executionOutput) + "</p>" +
    (wasReportOnly
        ? "<p style=\"" + font + "color:#8A6D00;font-weight:600;\">REPORT ONLY -- nothing was deleted. The counts show what a live run (whatIf = no) would remove.</p>"
        : "") +
    (foldersDeclined !== ""
        ? "<p style=\"" + font + "color:#B00020;font-weight:600;\">" + esc(foldersDeclined) + "</p>"
        : "") +
    "<table style=\"border-collapse:collapse;" + font + "margin-bottom:10px;\">" +
    "<tr><td style=\"" + td + "font-weight:600;\">AD group</td><td style=\"" + td + "\">" + esc(adGroup.name) + " (direct, enabled computer members)</td></tr>" +
    "<tr><td style=\"" + td + "font-weight:600;\">Folders</td><td style=\"" + td + "\">" + esc(targets.join("  |  ")) + "</td></tr>" +
    "<tr><td style=\"" + td + "font-weight:600;\">Older than</td><td style=\"" + td + "\">" + esc(reported.get("olderThanDays")) + " day(s) -- last written before " + esc(reported.get("cutoff")) + "</td></tr>" +
    "<tr><td style=\"" + td + "font-weight:600;\">Options</td><td style=\"" + td + "\">delete folders: " + (folderIncluded === true ? (foldersDeclined !== "" ? "requested, DECLINED (see above)" : "yes") : "no") + ", read-only items (force): " + (forceEnable === true ? "yes" : "no") + "</td></tr>" +
    "<tr><td style=\"" + td + "font-weight:600;\">Script</td><td style=\"" + td + "\">" + esc(scriptPath) + " on " + esc(resolvedHost.name) + "</td></tr>" +
    "</table>" +
    "<table style=\"border-collapse:collapse;border:1px solid #B4B4B4;" + font + "width:100%;\">" +
    "<tr>" +
    "<th style=\"" + th + "\">Server</th><th style=\"" + th + "\">Status</th><th style=\"" + th + "\">Matched</th>" +
    "<th style=\"" + th + "\">Deleted</th><th style=\"" + th + "\">Failed</th><th style=\"" + th + "\">" + sizeHeader + "</th>" +
    "<th style=\"" + th + "\">Free before</th><th style=\"" + th + "\">Free after</th><th style=\"" + th + "\">Detail</th>" +
    "</tr>" + rows +
    "</table>" +
    "<p style=\"" + font + "color:#555555;\">Always preserved: vmware-vmsvc-SYSTEM.log (exact name), items newer than the cutoff, " +
    "hidden and system files directly in a folder, the folders named above themselves" +
    (forceEnable === true ? "" : ", and read-only items") + ". A folder older than the cutoff is removed with everything in it. " +
    "Free space is for the drive(s) holding the folders and can be affected by other activity on the server during the run. " +
    "The full per-item log is in the Orchestrator run.</p>" +
    "</div>";

var stem = trim(mailSubject) === "" ? "VCF Orchestrator: Windows Server Disk Clean" : trim(mailSubject);
reportSubject = stem + " - " + adGroup.name + " - " +
    (wasReportOnly
        ? "REPORT ONLY, " + formatBytes(bytesFreed) + " would be freed"
        : formatBytes(bytesFreed) + " freed on " + serversProcessed + " server(s)") +
    (executionSuccess ? "" : " (WITH ERRORS)");

// Local helper used above; declared at the end because Rhino hoists function declarations.
function trim(value) {
    return (value === null || value === undefined) ? "" : String(value).replace(/^\s+|\s+$/g, "");
}


/* ═════════════════════════════════════════════════════════════════════════════
 * ELEMENT 11 -- "Closing Summary"                  (scriptable task)
 *
 * IN   executionSuccess  boolean       output (from element 8)
 *      executionOutput   string        output (from element 8)
 *      emailReport       boolean       input
 *      emailError        string        attr   (element 10's exception binding; empty if it
 *                                             did not throw or did not run)
 *      adGroup           AD:UserGroup  attr
 *      whatIf            string        input
 *      scriptPath        string        attr
 * OUT  executionSuccess  boolean       output
 *
 * Every path after element 8 ends here -- email sent, email failed, email off -- so the run
 * record always finishes with the same line: outcome, group, mode and script together.
 * Someone opening the log weeks later reads the last line and knows what this run did, to
 * what, and with which script.
 *
 * "Sent" is inferred: with email on, this task is reached either from element 10's normal
 * exit (sent) or from its exception (emailError set). The OOTB workflow has no output to
 * say so directly.
 * ═════════════════════════════════════════════════════════════════════════════ */

var success = (executionSuccess === true);
var emailFailed = (emailError !== null && emailError !== undefined && String(emailError).replace(/^\s+|\s+$/g, "") !== "");

if (emailReport === true && emailFailed) {
    // The clean already happened; failing the workflow now would make a completed run
    // look as if nothing was done. It is recorded as not fully successful instead.
    success = false;
    System.warn("The report email was NOT sent: " + emailError +
        " -- check that this Orchestrator can reach the SMTP relay (see BEFORE THE FIRST PRODUCTION RUN). " +
        "The per-server detail is in this run's log.");
}
executionSuccess = success;

var closing =
    "Clean Server Disks | group=" + adGroup.name +
    " | whatIf=" + whatIf +
    " | script=" + scriptPath +
    " | " + executionOutput +
    (emailReport === true ? (emailFailed ? " | report NOT emailed" : " | report emailed") : " | email off");

if (success) {
    System.log(closing);
}
else {
    System.warn(closing + " | Completed WITH ERRORS -- see the warnings above.");
}
