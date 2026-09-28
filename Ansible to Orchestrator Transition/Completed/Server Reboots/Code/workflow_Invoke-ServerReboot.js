/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW:  Invoke Server Reboot
 * Folder:    Production >> Servers >> Windows >> Server Reboot Management
 *            (lab/dev: Workflows >> Customer >> <Customer Name> >> Production >>
 *             Servers >> Windows >> Server Reboot Management)
 * Module:    com.broadcom.pso.windows.servers.reboot
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE IS THE BUILD SHEET FOR THE CANVAS.
 *   Everything needed to build the workflow in Orchestrator is here: the elements in
 *   order, every IN and OUT binding, the inputs and their presentation, the attributes,
 *   the outputs, the exception routing, and the two scriptable tasks in full at the
 *   bottom, ready to paste.
 *
 *   Seven elements do the work. FIVE of them are actions that already exist as .js
 *   files -- you bind them, you do not write them. Only elements 5 and 7 are scriptable
 *   tasks, and their code is at the bottom of this file.
 *
 * WHAT THE WORKFLOW DOES
 *   Reboots the Windows servers that are direct members of an Active Directory group AND
 *   are reporting a pending reboot: one at a time, with a delay between each, then
 *   verifies they came back.
 *
 *   It replaces servers_reboot.yml. See Documentation/Change-Register.md for what
 *   changed and why.
 *
 *   Physical and virtual are treated identically. Every operation in the script is
 *   OS-level -- remote WMI/registry for the pending check, shutdown.exe for the reboot,
 *   LastBootUpTime for the return check. Nothing touches vCenter.
 *
 * WHERE THE WORK HAPPENS
 *   Elements 1-3 are Active Directory plug-in calls, so no PowerShell runs to resolve
 *   the group and no credential is typed anywhere. Element 6 is the only one that
 *   touches a Windows host. The script it runs is held in Orchestrator, copied to the
 *   host for the run, and deleted afterwards.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * BEFORE YOU BUILD: run probeAdPlugin once
 * ───────────────────────────────────────────────────────────────────────────────
 *   It changes nothing and prints exactly what this Orchestrator offers -- which AD
 *   endpoints are registered and how each identifies its domain, how this plug-in
 *   version reports group membership, how many PowerShell hosts exist, and whether
 *   Invoke-ServerReboot.ps1 has been imported. Every assumption below is one it checks.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * BEFORE YOU BUILD: do not create the shared actions twice
 * ───────────────────────────────────────────────────────────────────────────────
 *   FIVE of the actions here are shared with the Move Archived Logs / Remove Old
 *   Archived Logs packages and live in com.broadcom.pso.windows.logs:
 *
 *       findAdHostForDn      resolveAdGroup      selectPowerShellHost
 *       runPowerShellScript  probeAdPlugin
 *
 *   They are delivered inside this package so it can be installed on its own. If either
 *   of those packages is already in this Orchestrator, THESE ACTIONS ALREADY EXIST --
 *   create each ONCE and let all three workflows call it. A second copy under a
 *   different name drifts silently from the first.
 *
 *   Only getGroupComputersDirect is this package's own, in
 *   com.broadcom.pso.windows.servers.reboot.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE CANVAS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   [Start]
 *      │
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 1. Find AD Host for Group DN      │  Action  findAdHostForDn          (shared)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - AD Resolution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 2. Resolve AD Group from DN       │  Action  resolveAdGroup           (shared)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - AD Resolution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 3. Get Computers in AD Group      │  Action  getGroupComputersDirect  (this pkg)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - AD Resolution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 4. Select PowerShell Host         │  Action  selectPowerShellHost     (shared)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - PS Execution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 5. Create Script Parameters       │  Scriptable task  (code below)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - Bad Inputs]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 6. Run PowerShell Script          │  Action  runPowerShellScript      (shared)
 *   └───────────────────────────────────┘
 *      │                └─[Exception]──────────────► [End: Failed - PS Execution]
 *      ▼
 *   ┌───────────────────────────────────┐
 *   │ 7. Parse Results                  │  Scriptable task  (code below)
 *   └───────────────────────────────────┘
 *      │
 *      ▼
 *   [End]
 *
 *   ONE completion end state, and three failure end states hung off the exception
 *   bindings. There is deliberately NO decision element and no pass/fail branch:
 *   element 7 does all the reporting itself and the run always finishes the same way.
 *
 *     Failed - AD Resolution    nothing was attempted; the target list was never built
 *     Failed - Bad Inputs       nothing was attempted; the request itself was wrong
 *     Failed - PS Execution     the script did not run, or did not run to completion
 *     End                       it RAN -- cleanly or with per-server problems
 *
 *   WHY PER-SERVER PROBLEMS DO NOT FAIL THE WORKFLOW
 *   A run where 18 of 20 servers rebooted cleanly and 2 could not be read is not a
 *   failed workflow. The work that could be done was done and the report was still
 *   produced, so it ends normally and says what happened. Only a TERMINATING problem
 *   -- bad inputs, AD resolution, or the script never completing -- lands on a Failed
 *   end state.
 *
 *   HOW A CALLER TELLS THE TWO APART
 *   The executionSuccess output (boolean) is false when the script reported any
 *   error, and executionOutput carries the one-line summary. A parent workflow or a
 *   schedule branches on executionSuccess; a person reads the log, where element 7
 *   has already written the outcome and every error line.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ELEMENT-BY-ELEMENT BINDINGS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Every IN and OUT below carries its Orchestrator type. Where an action parameter
 *   and the thing it binds to are the same type -- which they must be -- the type is
 *   shown once, on the parameter.
 *
 *   "input" means a workflow input, "attr" means a workflow attribute.
 *
 * ── 1. Find AD Host for Group DN ───────────────────────────────────────────────
 *    Type:      Action
 *    Action:    com.broadcom.pso.windows.logs / findAdHostForDn
 *
 *    IN    distinguishedName   string                      ← input  adGroupDn
 *    OUT   actionResult        AD:AdHost                   → attr   adHost
 *
 *    Exception → [End: Failed - AD Resolution]
 *
 *    Reads the DC= parts off the end of the DN and matches them against the AD
 *    endpoints registered in Orchestrator. This is why there is no "which domain?"
 *    prompt on the form: the group's own name already says which domain it is in, so
 *    the endpoint follows from it and the two cannot disagree.
 *
 * ── 2. Resolve AD Group from DN ────────────────────────────────────────────────
 *    Type:      Action
 *    Action:    com.broadcom.pso.windows.logs / resolveAdGroup
 *
 *    IN    adGroupDn           string                      ← input  adGroupDn
 *          adHost              AD:AdHost                   ← attr   adHost
 *    OUT   actionResult        AD:UserGroup                → attr   adGroup
 *
 *    Exception → [End: Failed - AD Resolution]
 *
 *    Turns the DN into the group object, looked up ON THAT ENDPOINT. Nothing here
 *    searches "all of Active Directory" and hopes -- in a multi-domain estate the same
 *    group name can exist in several domains, and an unscoped search is a coin toss.
 *
 * ── 3. Get Computers in AD Group ───────────────────────────────────────────────
 *    Type:      Action
 *    Action:    com.broadcom.pso.windows.servers.reboot / getGroupComputersDirect
 *
 *    IN    adGroup             AD:UserGroup                ← attr   adGroup
 *    OUT   actionResult        Array/string                → attr   computerNames
 *
 *    Exception → [End: Failed - AD Resolution]
 *
 *    DIRECT members only -- nested sub-groups are NOT expanded. That is change S-7 and
 *    it is deliberate: rebooting is destructive, so the target list is what somebody
 *    actually put in the group and nothing else.
 *
 *    DO NOT substitute getGroupComputers from the Move Archived Logs package. It is
 *    recursive. Moving a log file off a machine that should not have been in scope
 *    wastes a little time; rebooting one takes a production service down.
 *
 *    Any nested group found is named in a warning, so an omission is visible on the run
 *    that made it rather than discovered months later.
 *
 * ── 4. Select PowerShell Host ──────────────────────────────────────────────────
 *    Type:      Action
 *    Action:    com.broadcom.pso.windows.logs / selectPowerShellHost
 *
 *    IN    psHost              PowerShell:PowerShellHost   ← input  psHost  (may be null)
 *    OUT   actionResult        PowerShell:PowerShellHost   → attr   resolvedHost
 *
 *    Exception → [End: Failed - PS Execution]
 *
 *    Only asks when it genuinely cannot tell. One host registered and the operator is
 *    never made to choose it; more than one and their choice is used; more than one and
 *    no choice made and the run stops with the list rather than picking at random.
 *
 * ── 5. Create Script Parameters ────────────────────────────────────────────────
 *    Type:      Scriptable task        ← code at the bottom of this file
 *
 *    IN    computerNames           Array/string             ← attr   computerNames
 *          adGroup                 AD:UserGroup             ← attr   adGroup
 *          rebootMode              string                   ← input  rebootMode
 *          delayBetweenServersSec  number                   ← input  delayBetweenServersSec
 *          verifyTimeoutSec        number                   ← input  verifyTimeoutSec
 *          verifyPollSec           number                   ← input  verifyPollSec
 *          runPreRebootScript      boolean                  ← input  runPreRebootScript
 *          emailReport             boolean                  ← input  emailReport
 *          smtpServer              string                   ← input  smtpServer
 *          mailTo                  Array/string             ← input  mailTo
 *          mailCc                  Array/string             ← input  mailCc
 *          mailSubject             string                   ← input  mailSubject
 *    OUT   scriptParameters        Properties               → attr   scriptParameters
 *
 *    Exception → [End: Failed - Bad Inputs]
 *
 *    group is bound as the AD:UserGroup OBJECT, not as a string. The task reads
 *    adGroup.name off it for the report header, so the header can only ever name the
 *    group that was actually resolved.
 *
 * ── 6. Run PowerShell Script ───────────────────────────────────────────────────
 *    Type:      Action
 *    Action:    com.broadcom.pso.windows.logs / runPowerShellScript
 *
 *    IN    psHost              PowerShell:PowerShellHost   ← attr   resolvedHost
 *          script              ResourceElement             ← attr   rebootScript
 *          parameters          Properties                  ← attr   scriptParameters
 *    OUT   actionResult        Properties                  → attr   scriptRunResult
 *
 *    Exception → [End: Failed - PS Execution]
 *
 *    Copies Invoke-ServerReboot.ps1 to the host, runs it, deletes it, and reads the
 *    single PSO_RESULT line back.
 *
 *    The Properties it returns holds three keys:
 *        success     boolean     true when the script reported no errors
 *        result      Properties  the counts the script reported -- see element 7
 *        transcript  string      everything the script printed
 *
 *    The Resource Element's NAME becomes the filename on the host, so it must be
 *    exactly "Invoke-ServerReboot.ps1" -- the action refuses a name containing \ / or :.
 *
 * ── 7. Parse Results ───────────────────────────────────────────────────────────
 *    Type:      Scriptable task        ← code at the bottom of this file
 *
 *    IN    scriptRunResult     Properties                  ← attr   scriptRunResult
 *          adGroup             AD:UserGroup                ← attr   adGroup
 *          rebootMode          string                      ← input  rebootMode
 *    OUT   executionSuccess    boolean                     → output executionSuccess
 *          executionOutput     string                      → output executionOutput
 *          serversChecked      number                      → output serversChecked
 *          serversRebooted     number                      → output serversRebooted
 *          serversPending      number                      → output serversPending
 *          transcript          string                      → output transcript
 *
 *    BIND ALL SIX ON THE OUT TAB. An unbound OUT tab is not an error and produces no
 *    warning: the values are assigned and discarded, and the workflow finishes looking
 *    successful with nothing to show for it.
 *
 *    The numbers come out of scriptRunResult.get("result"), whose keys are written by
 *    the .ps1 as one PSO_RESULT line:
 *        serversRequested  number        how many servers were interrogated
 *        pendingReboot     number        how many reported a pending reboot
 *        rebooted          number        rebooted AND verified back online
 *        notReturned       number        rebooted but did not come back in time
 *        rebootFailed      number        shutdown command rejected
 *        skipped           number        not rebooted (no reboot needed, or unreadable)
 *        reportOnly        boolean       what the script ACTUALLY did
 *        errorCount        number        how many ERROR lines the script logged
 *        errors            Array/string  the first 10, shortened
 *
 *    Element 7 also writes the run's closing line -- outcome, group and mode
 *    together. There is no decision element and no pass/fail branch after it: it
 *    reports both outcomes itself, so element 7 connects straight to [End].
 *
 *    It needs rebootMode for that closing line, which is why rebootMode is on its
 *    IN tab as well as element 5's.
 *
 * ── End ────────────────────────────────────────────────────────────────────────
 *    Type:      End element (normal completion)
 *
 *    Element 7 → here, unconditionally. Nothing else to bind.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW INPUTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Defaults are set DIRECTLY on each input (process change P-8) -- there is no
 *   Configuration Element to install first.
 *
 *   Name                    Type                       Default                                 Mand.
 *   ─────────────────────── ────────────────────────── ─────────────────────────────────────── ─────
 *   adGroupDn               string                     (none)                                  Yes
 *   psHost                  PowerShell:PowerShellHost  (none)                                  No
 *   rebootMode              string                     report-only                             Yes
 *   delayBetweenServersSec  number                     10                                      Yes
 *   verifyTimeoutSec        number                     600                                     Yes
 *   verifyPollSec           number                     15                                      Yes
 *   runPreRebootScript      boolean                    false                                   Yes
 *   emailReport             boolean                    true                                    Yes
 *   smtpServer              string                     mailrelay.vcf.lab                       No
 *   mailTo                  Array/string               (set to real recipients)                No
 *   mailCc                  Array/string               (set to real recipients)                No
 *   mailSubject             string                     VCF Orchestrator: Server Reboot status  No
 *
 *   PRESENTATION -- three of these matter more than the rest:
 *
 *   rebootMode   ** THE SAFETY GATE. ** Make it a PREDEFINED ANSWERS list holding
 *                exactly two values: 'report-only' and 'reboot'. Do not leave it a free-text
 *                box. It is CASE-SENSITIVE, and anything that is not exactly
 *                'reboot' is treated as report-only -- so a typo silently means "do
 *                nothing" while the run still finishes green. Element 5 warns on a
 *                near-miss, but the list is what removes the trap. Default 'report-only', so an
 *                accidental run cannot reboot production.
 *
 *   adGroupDn    The group's distinguishedName, e.g.
 *                CN=Security-Reboot-Servers,OU=Groups,DC=vcf,DC=lab
 *                Everything follows from it -- the domain, the endpoint, the target
 *                list, and the report header.
 *
 *   runPreRebootScript
 *                Leave FALSE. See the note under "The pre-reboot script" below.
 *
 *   Group the rest: put the mail inputs behind an "Email report" section gated on
 *   emailReport, and the two verify* inputs in an "Advanced" section. An operator
 *   running this day to day should see a DN, a mode, and nothing else.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW ATTRIBUTES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Name              Type                       Set by            Value
 *   ───────────────── ────────────────────────── ───────────────── ──────────────────────
 *   rebootScript      ResourceElement            YOU, at build     Invoke-ServerReboot.ps1
 *   adHost            AD:AdHost                  element 1
 *   adGroup           AD:UserGroup               element 2
 *   computerNames     Array/string               element 3
 *   resolvedHost      PowerShell:PowerShellHost  element 4
 *   scriptParameters  Properties                 element 5
 *   scriptRunResult   Properties                 element 6
 *
 *   rebootScript is the only one you set by hand. Bind it to the Resource Element
 *   holding Invoke-ServerReboot.ps1. It is an ATTRIBUTE, not a name looked up at run
 *   time, so the run record shows which script actually ran.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WORKFLOW OUTPUTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   executionSuccess  boolean  true when the script reported no errors at all
 *   executionOutput   string   one-line summary, for a caller or a notification
 *   serversChecked    number   how many servers were interrogated
 *   serversRebooted   number   rebooted AND verified back online
 *   serversPending    number   how many reported a pending reboot
 *   transcript        string   the full run log, for the record
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAILURE HANDLING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Condition                                        Element  End state
 *   ──────────────────────────────────────────────── ───────  ──────────────────────────
 *   adGroupDn is not a DN / has no DC= parts            1     Failed - AD Resolution
 *   No AD endpoint registered for that domain           1     Failed - AD Resolution
 *   Group not found on that endpoint                    2     Failed - AD Resolution
 *   Plug-in will not report group membership            3     Failed - AD Resolution
 *   Nested sub-group in the group                       3     ignored + Warn → continues
 *   Disabled computer account                           3     skipped + logged → continues
 *   No PowerShell host registered                       4     Failed - PS Execution
 *   Several hosts, none chosen                          4     Failed - PS Execution
 *   Zero enabled DIRECT computer members                5     Failed - Bad Inputs
 *   Bad number, or poll interval > timeout              5     Failed - Bad Inputs
 *   Email on with no recipient or no SMTP server        5     Failed - Bad Inputs
 *   Host unreachable, or script never completed         6     Failed - PS Execution
 *   Server with no pending reboot                       7     End, executionSuccess=true
 *   Server whose pending state cannot be read           7     End, executionSuccess=FALSE
 *   shutdown command rejected                           7     End, executionSuccess=FALSE
 *   Server did not return within verifyTimeoutSec       7     End, executionSuccess=FALSE
 *   Pre-reboot step failed on a server                  7     End, executionSuccess=FALSE
 *   Report could not be emailed                         7     End, executionSuccess=FALSE
 *   Everything handled cleanly                          7     End, executionSuccess=true
 *
 *   The pre-reboot step needs no path and cannot be missing -- it is embedded in the
 *   .ps1 (change S-14), so there is no "script not found" failure to route.
 *
 *   EVERY ROW REACHING ELEMENT 7 ENDS THE SAME WAY. The workflow completes; the
 *   executionSuccess output says whether the script hit anything. There is no
 *   decision element, so nothing branches -- element 7 logs the difference and a
 *   caller reads it off the output.
 *
 *   ZERO DIRECT MEMBERS IS A FAILURE, NOT A CLEAN EXIT. Under the old design it was a
 *   warning and a green run -- which is the same thing an operator sees when every
 *   server is already up to date. Picking the wrong group looked exactly like having
 *   nothing to do. It now stops and says so.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * BEFORE THE FIRST PRODUCTION RUN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   TIMEOUTS. The whole thing is ONE synchronous PowerShell invocation lasting roughly
 *
 *       (pending servers × delayBetweenServersSec) + up to verifyTimeoutSec
 *
 *   20 pending servers at 10s with a 600s verify is about 13 minutes. The PS host's
 *   WinRM MaxTimeoutms and the PowerShell plug-in timeout must BOTH exceed the worst
 *   case. Element 5 logs that figure on every run and warns past 30 minutes.
 *
 *   If runs are cut off mid-transcript, RAISE the timeouts. Do not shorten
 *   verifyTimeoutSec to fit -- that does not make the run shorter, it just gives up on
 *   servers that were going to come back. A session cut after reboots are issued but
 *   before anything is reported is the one failure mode that leaves you not knowing
 *   what state the estate is in.
 *
 *   SECOND HOP. The PS host reaches AD, and reaches every target over RPC/WMI/SMB.
 *   Same Kerberos constrained-delegation requirement as the Move package -- see
 *   "How to Build a PowerShell Host" §6.
 *
 *   THE PRE-REBOOT STEP (S-13, S-14). runPreRebootScript defaults to FALSE and should stay
 *   there until security has reviewed it. The step is EMBEDDED in Invoke-ServerReboot.ps1
 *   (there is no path to supply). It is the former ownership_w2k.ps1: it takes ownership
 *   of and loosens the ACLs on usbstor.inf (the USB mass-storage driver INF -- a common
 *   hardening DENY target) and termsrv.dll (Terminal Services). Because of defect S-6
 *   this step has NEVER actually executed, so turning it on is a security-posture
 *   CHANGE, not a restoration of previous behaviour.
 *
 *   PROVE IT IN THIS ORDER. Report-only against a real group first. Then a live run
 *   against a group containing ONE server. Only then a group-wide live run. The paths
 *   that need real infrastructure -- genuine pending-reboot detection, shutdown.exe
 *   acceptance, LastBootUpTime verification -- cannot be exercised any other way.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * OPTIONAL VARIANT: letting an operator pick the group from a tree
 * ───────────────────────────────────────────────────────────────────────────────
 *   The canvas above is driven by a typed distinguishedName, which is what scheduled
 *   and API runs have to use. If you also want the AD tree picker:
 *
 *     - add a workflow input  adGroup  of type AD:UserGroup
 *     - put a Decision before element 1 testing  adGroup != null
 *     - true  → bind adGroup straight to the 'group' attribute and jump to element 3
 *     - false → elements 1 and 2 as above
 *
 *   A group picked from the tree arrives already resolved and already attached to its
 *   own endpoint, so elements 1 and 2 are pure overhead on that path. Worth the extra
 *   decision box only if people will run this interactively; a scheduled reboot window
 *   never touches it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   THE TWO SCRIPTABLE TASKS FOLLOW. Each block below is one element's code, complete.
 *   Copy from the banner down to the next banner. Nothing outside a block is code.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ═══════════════════════════════════════════════════════════════════════════════
 */


/* ═════════════════════════════════════════════════════════════════════════════
 * ELEMENT 5 -- "Create Script Parameters"          (scriptable task)
 *
 * IN   computerNames           Array/string    attr    from element 3
 *      adGroup                   AD:UserGroup    attr    from element 2
 *      rebootMode              string          input
 *      delayBetweenServersSec  number          input
 *      verifyTimeoutSec        number          input
 *      verifyPollSec           number          input
 *      runPreRebootScript      boolean         input
 *      emailReport             boolean         input
 *      smtpServer              string          input
 *      mailTo                  Array/string    input
 *      mailCc                  Array/string    input
 *      mailSubject             string          input
 * OUT  scriptParameters        Properties      attr    → element 6 'parameters'
 *
 * Does no work of its own. Turns the request form and the resolved server list into
 * the Properties bag Invoke-ServerReboot.ps1 expects, and says in the log what it
 * decided. Everything arrives as a binding, so the schema shows where each value came
 * from -- nothing is fetched with System.getModule().
 * ═════════════════════════════════════════════════════════════════════════════ */

// -- 1. Refuse to run a script against nothing -------------------------------
// A run that rebooted nothing because the group was empty must not look the same as a
// run that rebooted nothing because no server had a reboot pending.
if (computerNames === null || computerNames === undefined || computerNames.length === 0) {
    throw new Error(
        "Create Script Parameters: no servers were resolved. The AD group has no enabled " +
        "computer accounts as DIRECT members -- note that nested groups are deliberately not " +
        "expanded for reboots (change S-7). Check the 'Get Computers in AD Group' element's " +
        "log: if it reported nested groups, that is where the servers are."
    );
}

var groupName = String(adGroup.name);

System.log("Servers to check (" + computerNames.length + "): " + computerNames.join(", "));

// -- 2. The safety gate ------------------------------------------------------
// rebootMode maps to the script's -RebootMode. The two recognised values are:
//
//     'reboot'       actually reboots      ($willReboot in the .ps1 tests for exactly this)
//     'report-only'  detects and reports, changes nothing        (the default)
//
// The .ps1 treats ANYTHING that is not 'reboot' as report-only, so the gate fails
// safe. That is also the failure mode worth guarding against: a typo -- 'Reboot',
// 'reboot ', 'rebooot' -- silently means "do nothing" while the run still finishes
// looking entirely successful.
//
// THESE TWO STRINGS MUST MATCH THE .ps1. The comparison there is
//     $willReboot = ($RebootMode -eq 'reboot')
// If you rename the values, rename them in BOTH files. A mismatch does not error --
// it just means no server is ever rebooted, which is invisible until someone checks
// why patching never lands.
var mode = String(rebootMode === null || rebootMode === undefined ? "" : rebootMode).replace(/^\s+|\s+$/g, "");

if (mode === "") {
    throw new Error(
        "Create Script Parameters: rebootMode is empty. Use 'reboot' to reboot, or " +
        "'report-only' to detect and report without changing anything."
    );
}

if (mode === "reboot") {
    System.warn(
        "rebootMode='reboot' -- this run WILL REBOOT every direct, enabled member of '" +
        groupName + "' that reports a pending reboot. " + computerNames.length + " server(s) " +
        "will be checked."
    );
}
else {
    if (mode !== "report-only") {
        System.warn(
            "rebootMode='" + mode + "' is neither 'reboot' nor 'report-only'. The script treats " +
            "any non-'reboot' value as report-only, so NO servers will be rebooted. If a reboot " +
            "was intended, the value must be exactly 'reboot' -- it is case-sensitive."
        );
    }
    System.log("rebootMode='" + mode + "' -- report-only run; pending servers will be reported but not rebooted.");
}

// -- 3. Check the numbers before the script has to ---------------------------
// These are cast with [int] inside the script, where a bad value becomes 0 rather than
// an error -- a verifyPollSec of 0 would spin the verification loop with no wait at all.
// Refuse them here, where the message can name the input the operator has to fix.
function requireWholeNumber(value, name, minimum) {
    if (value === null || value === undefined || String(value).replace(/^\s+|\s+$/g, "") === "") {
        throw new Error("Create Script Parameters: " + name + " is required.");
    }

    var n = parseInt(value, 10);

    if (isNaN(n) || String(n) !== String(value).replace(/^\s+|\s+$/g, "")) {
        throw new Error(
            "Create Script Parameters: " + name + " must be a whole number. Received: " + value
        );
    }
    if (n < minimum) {
        throw new Error(
            "Create Script Parameters: " + name + " must be " + minimum + " or greater. Received: " + n
        );
    }
    return n;
}

var delaySec  = requireWholeNumber(delayBetweenServersSec, "delayBetweenServersSec", 0);
var verifySec = requireWholeNumber(verifyTimeoutSec, "verifyTimeoutSec", 1);
var pollSec   = requireWholeNumber(verifyPollSec, "verifyPollSec", 1);

if (pollSec > verifySec) {
    throw new Error(
        "Create Script Parameters: verifyPollSec (" + pollSec + ") must not exceed verifyTimeoutSec (" +
        verifySec + ") -- a server would never be polled before its deadline passed."
    );
}

// The whole run is ONE synchronous PowerShell invocation. If it outlasts the WinRM/PSRP
// operation timeout on the host, the session is cut and the transcript is lost
// mid-reboot -- with servers already rebooting and no record of which.
// (N-1) delays, not N: the script waits BETWEEN servers, so there is no delay
// after the last one. With a large delay that difference is most of the run.
var worstCaseSec = ((computerNames.length - 1) * delaySec) + verifySec;
System.log(
    "Worst-case run time: " + Math.ceil(worstCaseSec / 60) + " minute(s) (" + computerNames.length +
    " server(s) x " + delaySec + "s delay, plus up to " + verifySec + "s of verification)."
);
if (worstCaseSec > 1800) {
    System.warn(
        "This run could take up to " + Math.ceil(worstCaseSec / 60) + " minutes in a single " +
        "PowerShell invocation. Confirm the PS host's WinRM MaxTimeoutms and the PowerShell " +
        "plug-in timeout both exceed that, or the session will be cut off mid-run -- after " +
        "reboots have been issued but before anything is reported."
    );
}

// -- 4. Turn the tick-boxes into the 'yes' and 'no' the script expects -------
/**
 * These are booleans, so  value ? "yes" : "no"  would do the job today. It is written
 * out longhand because inputs like these have been declared as strings at times, and
 * that one-liner fails silently when they are: every non-empty string is truthy in
 * JavaScript, so "no" comes out as "yes". Here that would turn ON the pre-reboot script
 * for a run whose operator had turned it off -- a security-posture change nobody asked
 * for. The value is read, not tested for truth.
 */
function yesNo(value) {
    if (value === true)  { return "yes"; }
    if (value === false) { return "no"; }

    var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    return (text === "yes" || text === "true" || text === "1") ? "yes" : "no";
}

var preScriptFlag = yesNo(runPreRebootScript);
var emailFlag     = yesNo(emailReport);

// S-13: the pre-reboot step is opt-in and defaults OFF. S-14: it lives INSIDE
// Invoke-ServerReboot.ps1 as a script block, so there is no path to supply and no
// file that can go missing -- which is what defect S-6 was.
//
// It takes ownership of and loosens the ACLs on usbstor.inf (USB mass-storage driver
// INF) and termsrv.dll (Terminal Services). Because of S-6 it never actually ran, so
// enabling it is a security-posture CHANGE rather than a restoration of working
// behaviour. Make it loud when it is on.
if (preScriptFlag === "yes") {
    System.warn(
        "runPreRebootScript is ON -- the embedded pre-reboot step WILL run on every server " +
        "that is rebooted. It takes ownership of and loosens ACLs on usbstor.inf (USB mass " +
        "storage) and termsrv.dll (Terminal Services). This step has never run in production " +
        "(defect S-6), so enabling it changes security posture. Confirm it is security-approved."
    );
}

// -- 5. Email is opt-in; when it is on, there has to be somewhere to send it --
var toList = (mailTo && mailTo.length) ? mailTo.join(",") : "";
var ccList = (mailCc && mailCc.length) ? mailCc.join(",") : "";

if (emailFlag === "yes") {
    if (smtpServer === null || smtpServer === undefined ||
        String(smtpServer).replace(/^\s+|\s+$/g, "") === "") {
        throw new Error(
            "Create Script Parameters: smtpServer is required when emailReport is ticked."
        );
    }
    if (toList === "") {
        throw new Error(
            "Create Script Parameters: mailTo must hold at least one recipient when emailReport " +
            "is ticked."
        );
    }
}

// -- 6. Build the bag --------------------------------------------------------
// The keys are the script's parameter names. runPowerShellScript turns each one into
// -Name 'value' on the command line, so they have to match the param() block in
// Invoke-ServerReboot.ps1 exactly.
scriptParameters = new Properties();
scriptParameters.put("ComputerNames",          computerNames.join(","));
scriptParameters.put("RebootMode",             mode);
scriptParameters.put("DelayBetweenServersSec", String(delaySec));
scriptParameters.put("VerifyTimeoutSec",       String(verifySec));
scriptParameters.put("VerifyPollSec",          String(pollSec));
scriptParameters.put("RunPreRebootScript",     preScriptFlag);
scriptParameters.put("EmailReport",            emailFlag);
scriptParameters.put("SMTPServer",             smtpServer ? String(smtpServer).replace(/^\s+|\s+$/g, "") : "");
scriptParameters.put("MailToString",           toList);
scriptParameters.put("MailCcString",           ccList);
scriptParameters.put("MailSubject",            mailSubject ? String(mailSubject).replace(/^\s+|\s+$/g, "") : "");

// -HeaderNote is the group name printed in the report header. It is a display label
// only, so it is taken from the group that was actually RESOLVED rather than asked for
// separately -- which makes it impossible for the header to name a different group than
// the one whose servers were rebooted. (Change P-13.)
scriptParameters.put("HeaderNote", groupName);

System.log(
    "rebootMode=" + mode + ", servers=" + computerNames.length +
    ", delay=" + delaySec + "s, verifyTimeout=" + verifySec + "s, verifyPoll=" + pollSec + "s" +
    ", preRebootScript=" + preScriptFlag + ", emailReport=" + emailFlag +
    (emailFlag === "yes" ? ", mailTo=" + toList : "")
);


/* ═════════════════════════════════════════════════════════════════════════════
 * ELEMENT 7 -- "Parse Results"                     (scriptable task)
 *
 * IN   scriptRunResult   Properties      attr     from element 6
 *      adGroup           AD:UserGroup    attr     from element 2
 *      rebootMode        string          input
 * OUT  executionSuccess  boolean         output
 *      executionOutput   string          output
 *      serversChecked    number          output
 *      serversRebooted   number          output
 *      serversPending    number          output
 *      transcript        string          output
 *      -- BIND ALL SIX TO THE WORKFLOW OUTPUTS
 *
 * Element 6 hands back one Properties object holding everything the script reported.
 * This takes it apart into the workflow's own outputs, so a caller -- a parent
 * workflow, a schedule, or the API -- can read the numbers without knowing anything
 * about PSO_RESULT or about how the script logs.
 *
 * THIS TASK DOES ALL THE REPORTING. There is no decision element after it and no
 * pass/fail branch: it reports both outcomes and the workflow then ends. That keeps
 * the whole account of a run in one place and in one order, which is what someone
 * reading the log afterwards actually needs -- rather than split across two branches
 * where half of it is only ever reached on one of them.
 * ═════════════════════════════════════════════════════════════════════════════ */

// runPowerShellScript throws rather than returning nothing, so an empty result here
// means element 6 was skipped or its output was never bound. Say which, because the
// alternative is six null outputs and no clue where they came from.
if (scriptRunResult === null || scriptRunResult === undefined) {
    throw new Error(
        "Parse Results: scriptRunResult is empty. Bind this task's scriptRunResult input to " +
        "the output of the 'Run PowerShell Script' element."
    );
}

var reported = scriptRunResult.get("result");

executionSuccess = scriptRunResult.get("success");
transcript       = scriptRunResult.get("transcript");

serversChecked  = reported.get("serversRequested");
serversPending  = reported.get("pendingReboot");
serversRebooted = reported.get("rebooted");

var notReturned  = reported.get("notReturned");
var rebootFailed = reported.get("rebootFailed");
var skipped      = reported.get("skipped");
var errorCount   = reported.get("errorCount");

// reportOnly comes back from the SCRIPT rather than from the request form, so this
// reports what actually ran. If the two ever disagree, the script's answer is the true
// one -- and the disagreement is itself the thing worth knowing.
var wasReportOnly = (reported.get("reportOnly") === true);

if (wasReportOnly) {
    executionOutput =
        serversPending + " of " + serversChecked + " server(s) require a reboot. " +
        "REPORT ONLY -- nothing was rebooted.";
}
else {
    executionOutput =
        serversRebooted + " of " + serversPending + " pending server(s) rebooted and verified, " +
        "across " + serversChecked + " server(s) checked.";
}

if (executionSuccess) {
    System.log("Finished. " + executionOutput);

    if (wasReportOnly && serversPending > 0) {
        // Worth saying plainly. A clean report-only run proves the servers could be
        // interrogated -- not that any of them can actually be rebooted. The reboot
        // path (shutdown rights, RPC) is never exercised until a live run.
        System.log(
            "This was a report-only run. No reboot was issued, so it does not confirm the " +
            "servers can be rebooted -- only that their pending state could be read. " +
            "Re-run with rebootMode set to 'reboot' to reboot these " + serversPending +
            " server(s)."
        );
    }
}
else {
    // Some servers worked and some did not. That is not a failed workflow -- the work
    // that could be done was done, and the report was still produced -- but it must be
    // visible rather than buried in a transcript nobody opens.
    System.warn(
        "Finished with " + errorCount + " error(s) against group '" + adGroup.name + "'. " +
        executionOutput
    );

    // Each count names a DIFFERENT kind of problem with a different owner, so they are
    // reported separately rather than as one total. Collapsing them is what makes a
    // reboot run hard to read: "3 errors" could be three unreachable servers (a
    // firewall or WMI problem) or three servers that never came back (a real outage),
    // and those two call for opposite responses.
    if (skipped > 0 && serversPending < serversChecked) {
        System.warn(
            "  " + skipped + " server(s) were skipped. A server whose pending-reboot state " +
            "could not be read is NEVER rebooted (change S-8) -- check remote WMI/RPC access " +
            "to those servers from the PowerShell host."
        );
    }
    if (rebootFailed > 0) {
        System.warn(
            "  " + rebootFailed + " server(s) rejected the shutdown command. These are still " +
            "running and still require a reboot. Check the PowerShell host's shutdown rights " +
            "on them."
        );
    }
    if (notReturned > 0) {
        System.warn(
            "  " + notReturned + " server(s) did NOT come back within the verification timeout. " +
            "THESE NEED ATTENTION NOW -- a reboot was issued and the machine has not answered " +
            "since. Check them before re-running anything."
        );
    }

    var errors = reported.get("errors");
    if (errors !== null && errors !== undefined) {
        System.warn("The errors were:");
        for (var i = 0; i < errors.length; i++) {
            System.warn("  " + errors[i]);
        }
    }

    System.warn("The full transcript, and the emailed report, hold the per-server detail.");
}

// ---------------------------------------------------------------------------
// The closing line
//
// Written here rather than in an end-state task on a branch, so the run record
// always ends with outcome, group and mode stated together -- whatever happened.
// Someone opening the log six weeks later reads the last line and knows what this
// run did and to what, without reconstructing it from which path was taken.
// ---------------------------------------------------------------------------
var closing =
    "Invoke Server Reboot | group=" + adGroup.name +
    " | rebootMode=" + rebootMode +
    " | " + executionOutput;

if (executionSuccess) {
    System.log(closing);
}
else {
    System.warn(closing + " | Completed WITH ERRORS -- see the warnings above and the emailed report.");
}

