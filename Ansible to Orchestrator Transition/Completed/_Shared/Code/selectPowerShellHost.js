/* ===========================================================================
 * SHARED COMPONENT -- used by every workflow in the programme that needs it.
 *
 * ONE copy lives here, in InProgress/_Shared/Code/. Project folders do not
 * carry their own copies; a project's build sheet names the action and points
 * here, and the project's .package export bundles it so the package still
 * installs on its own.
 *
 * Create it ONCE per Orchestrator and let every workflow call it -- do not
 * create a second copy under a different name. A fix made to one copy does
 * not reach the others, and they drift apart silently.
 * =========================================================================== */

/**
 * Action:  selectPowerShellHost
 * Module:  com.broadcom.pso.powershell
 *
 * WHAT IT DOES
 *   Given a list of PowerShell hosts, returns the one with the LOWEST resource
 *   utilization right now. Nobody chooses a host on the request form.
 *
 *   Which hosts are candidates is the workflow's decision, not this action's: the
 *   workflow passes in the hosts that are suitable for its work (normally a build-time
 *   attribute listing them), and this action only decides which of those is least busy.
 *
 * HOW UTILIZATION IS MEASURED
 *   Each candidate is probed once. The probe samples, over about two seconds:
 *
 *     cpu             average processor load, %           (Win32_Processor.LoadPercentage)
 *     memUsed         physical memory in use, %           (Win32_OperatingSystem)
 *     activeSessions  OTHER remote PowerShell sessions that did work during the sample
 *                     (wsmprovhost.exe processes, other than the probe's own, whose CPU
 *                     time or I/O count moved)
 *
 *   and the score is
 *
 *     score = cpu  +  0.5 x memUsed  +  SESSION_WEIGHT (20) x activeSessions
 *
 *   Lowest score wins; a tie goes to fewer active sessions, then to the name, so the
 *   choice is repeatable. activeSessions is weighted heavily on purpose: these workflows
 *   run long, single, mostly I/O-bound sessions (deleting a cache over SMB barely moves
 *   the CPU), so "how many other runs is this host already doing" predicts the wait better
 *   than a two-second CPU reading does. Idle sessions -- for example the Shared Session of
 *   another host object registered against the same machine -- are NOT counted.
 *
 *   Everything is read through CIM classes, whose names are the same on every Windows
 *   language (performance-counter paths are translated and would fail on a non-English
 *   host). The weights are constants at the top of the code. Change them there, once.
 *
 * ONE CANDIDATE
 *   A list of one is returned without probing -- there is nothing to compare, and the
 *   staging step that follows proves the host is reachable anyway.
 *
 * WHAT IT CANNOT SEE
 *   Load is a snapshot. Two runs that start in the same second can both see the same host
 *   as least busy and both choose it. That is harmless -- each run is independent -- but it
 *   means the balancing is "good", not "perfect".
 *
 * HOSTS THAT DO NOT ANSWER
 *   A host whose probe fails (unreachable, credentials rejected, WinRM down) is logged as a
 *   warning and left out. The run fails only if NO candidate answers. A host that hangs,
 *   rather than refusing, holds the run until the PowerShell plug-in's own timeout,
 *   because the probes run one after another.
 *
 * INPUTS (in this order -- vRO passes action inputs positionally)
 *   psHosts  Array/PowerShell:PowerShellHost  the candidate hosts; at least one. The same
 *                                             host listed twice is probed once.
 *
 * RETURNS
 *   PowerShell:PowerShellHost -- the candidate with the lowest score. The log shows every
 *   candidate, its figures and its score, and which one was chosen.
 */

// ---------------------------------------------------------------------------
// Tuning -- the only numbers in this action anyone should need to change
// ---------------------------------------------------------------------------
var MEMORY_WEIGHT  = 0.5;   // points per % of physical memory in use
var SESSION_WEIGHT = 20;    // points per OTHER active remote PowerShell session

// ---------------------------------------------------------------------------
// 1. The candidates
// ---------------------------------------------------------------------------
if (psHosts === null || psHosts === undefined || psHosts.length === 0) {
    throw new Error(
        "selectPowerShellHost: psHosts is empty. Bind it to the workflow attribute that lists the " +
        "PowerShell hosts this workflow may run on, and give it at least one host."
    );
}

// Drop empty entries and duplicates (by name), keeping the order given.
var candidates = [];
var seen = {};
for (var c = 0; c < psHosts.length; c++) {
    var entry = psHosts[c];
    if (entry === null || entry === undefined) { continue; }
    var key = String(entry.name);
    if (seen[key] === true) { continue; }
    seen[key] = true;
    candidates.push(entry);
}

if (candidates.length === 0) {
    throw new Error("selectPowerShellHost: psHosts contains no hosts, only empty entries.");
}

if (candidates.length === 1) {
    System.log("selectPowerShellHost | one candidate, " + candidates[0].name + " -- using it without probing.");
    return candidates[0];
}

System.log("selectPowerShellHost | probing " + candidates.length + " candidate host(s) for utilization.");

// ---------------------------------------------------------------------------
// 2. The probe -- one short invocation per host
// ---------------------------------------------------------------------------
// Sessions: in a remote PowerShell session the code runs inside wsmprovhost.exe, so the
// probe's own process is $PID and is excluded. Each other wsmprovhost is another session;
// it counts as ACTIVE only if its CPU time or I/O operation count moved while the CPU was
// being sampled.
var probe = [
    "$ErrorActionPreference = 'Stop'",
    "$cs = Get-CimInstance -ClassName Win32_ComputerSystem",
    "$os = Get-CimInstance -ClassName Win32_OperatingSystem",
    "function Get-Shells {",
    "    $t = @{}",
    "    foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter \"Name='wsmprovhost.exe'\")) {",
    "        if ($p.ProcessId -ne $PID) {",
    "            $t[[int]$p.ProcessId] = @([double]$p.KernelModeTime + [double]$p.UserModeTime,",
    "                                      [double]$p.ReadOperationCount + [double]$p.WriteOperationCount + [double]$p.OtherOperationCount)",
    "        }",
    "    }",
    "    return $t",
    "}",
    "$before = Get-Shells",
    "$loads = @()",
    "for ($i = 0; $i -lt 3; $i++) {",
    "    $loads += @(Get-CimInstance -ClassName Win32_Processor | ForEach-Object { [double]$_.LoadPercentage })",
    "    if ($i -lt 2) { Start-Sleep -Milliseconds 700 }",
    "}",
    "$after = Get-Shells",
    "$active = 0",
    "foreach ($id in $after.Keys) {",
    "    if ($before.ContainsKey($id)) {",
    // 100000 x 100 ns = 10 ms of CPU; 5 I/O operations. Below both, the shell is idle.
    "        if (($after[$id][0] - $before[$id][0]) -ge 100000 -or ($after[$id][1] - $before[$id][1]) -ge 5) { $active++ }",
    "    } else { $active++ }",   // started during the sample: something just connected
    "}",
    "$cpu = 0; if ($loads.Count -gt 0) { $cpu = ($loads | Measure-Object -Average).Average }",
    "$memUsed = 0; if ([double]$os.TotalVisibleMemorySize -gt 0) { $memUsed = 100 * (1 - [double]$os.FreePhysicalMemory / [double]$os.TotalVisibleMemorySize) }",
    "$r = [ordered]@{",
    "    computer       = [string]$cs.Name",
    "    cpu            = [math]::Round($cpu, 1)",
    "    memUsed        = [math]::Round($memUsed, 1)",
    "    sessions       = $after.Count",
    "    activeSessions = $active",
    "}",
    "Write-Output ('PSO_HOSTPROBE=' + ($r | ConvertTo-Json -Compress))"
].join("\r\n");

// Merge every stream into one string, so whichever result accessor this plug-in version
// fills, the marker line is in it.
var wrapped = "& {\r\n" + probe + "\r\n} *>&1 | Out-String -Width 4096";

function probeHost(h) {
    var result;
    if (typeof h.invokeScript === "function") {
        result = h.invokeScript(wrapped);
    }
    else {
        var session = h.openSession();
        try {
            result = session.invokeScript(wrapped);
        }
        finally {
            try { h.closeSession(session.getSessionId()); } catch (eC) { /* nothing useful to do */ }
        }
    }

    var text = "";
    try { text = String(result.getHostOutput() || ""); } catch (e1) { text = ""; }
    if (text.replace(/^\s+|\s+$/g, "") === "") {
        try {
            var returned = result.getInvocationResult();
            var root = (returned === null || returned === undefined) ? null : returned.getRootObject();
            text = (root === null || root === undefined) ? "" : String(root);
        } catch (e2) { text = ""; }
    }
    text = text.replace(/_x([0-9A-Fa-f]{4})_/g, function (match, hex) { return String.fromCharCode(parseInt(hex, 16)); });

    var m = /^[ \t]*PSO_HOSTPROBE=(.*)$/m.exec(text.replace(/\r/g, ""));
    if (m === null) {
        throw new Error("no probe result. Output: " + (text === "" ? "(empty)" : text.substring(0, 300)));
    }
    return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// 3. Probe them all, then pick the lowest score
// ---------------------------------------------------------------------------
var scored = [];
var report = [];     // one line per host, for the log and for the error message

for (var i = 0; i < candidates.length; i++) {
    var h = candidates[i];
    var hostLabel = String(h.name);
    var info;

    try {
        info = probeHost(h);
    }
    catch (e) {
        System.warn("selectPowerShellHost | " + hostLabel + " did not answer the probe and is left out: " + e);
        report.push(hostLabel + " -- no answer");
        continue;
    }

    var score = Number(info.cpu) + MEMORY_WEIGHT * Number(info.memUsed) + SESSION_WEIGHT * Number(info.activeSessions);
    score = Math.round(score * 10) / 10;

    scored.push({ host: h, name: hostLabel, info: info, score: score });
    report.push(
        hostLabel + " (" + info.computer + ") -- cpu " + info.cpu + "%, memory " + info.memUsed +
        "%, active sessions " + info.activeSessions + " of " + info.sessions + ", score " + score
    );
}

System.log("selectPowerShellHost | probe results:\n  " + report.join("\n  "));

if (scored.length === 0) {
    throw new Error(
        "selectPowerShellHost: none of the " + candidates.length + " candidate PowerShell host(s) answered. " +
        "Check that they are reachable over WinRM and that their credentials are valid. " +
        "Candidates: " + report.join("; ")
    );
}

// Lowest score; then fewer active sessions; then name -- so the same figures always give
// the same answer.
scored.sort(function (a, b) {
    if (a.score !== b.score) { return a.score - b.score; }
    if (a.info.activeSessions !== b.info.activeSessions) { return a.info.activeSessions - b.info.activeSessions; }
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
});

var chosen = scored[0];

System.log(
    "selectPowerShellHost | chose " + chosen.name + " (" + chosen.info.computer + "), score " + chosen.score +
    " -- the least busy of " + scored.length + " answering candidate(s)."
);

return chosen.host;
