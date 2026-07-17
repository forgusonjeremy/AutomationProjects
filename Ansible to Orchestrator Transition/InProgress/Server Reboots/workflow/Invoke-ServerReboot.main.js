/**
 * Workflow scriptable task: Invoke-ServerReboot (PARENT / orchestrator)
 * Module: com.corp.serverreboot
 *
 * Pattern: sequential staggered LAUNCH of an async child workflow per server,
 * then MONITOR every child run state until all are terminal, then REPORT + MAIL.
 *
 *   1. Resolve each AD member -> VM (Tools DNS, multi-vCenter; lazy name fallback).
 *   2. For each resolvable server: launch child ASYNC, delay between each launch.
 *      Unresolvable members are recorded SKIPPED directly (no child).
 *   3. Poll each child token's run state until ALL are terminal
 *      (completed / failed / canceled).
 *   4. Aggregate child results, build the HTML report, email recipients[].
 *
 * ---- WORKFLOW INPUTS ----
 *   adGroupName            : string
 *   rebootWorkflow         : Workflow            // reference to Reboot-And-Track-Server
 *   interServerDelaySec    : number   (default 10)   // delay BETWEEN launches
 *   postRebootTimeoutSec   : number   (default 600)  // passed to child
 *   pollIntervalSec        : number   (default 15)   // child down/up poll
 *   monitorPollSec         : number   (default 15)   // parent state-poll cadence
 *   overallTimeoutSec      : number   (default 0)    // 0 = wait indefinitely
 *   emailReport            : boolean  (default true)
 *   smtpServer             : string
 *   mailFrom               : string
 *   mailTo                 : Array/string           // recipients (array of strings)
 *   mailCc                 : Array/string           // optional
 *   mailSubject            : string
 *   headerNote             : string
 *
 * ---- WORKFLOW OUTPUT ATTRIBUTES ----
 *   results    : Array/Properties
 *   reportHtml : string
 *   summary    : string
 *
 * Actions used: getAdGroupComputers, resolveVm, buildVmNameIndex, buildHtmlReport
 */

var MOD = "com.corp.serverreboot";
function nowIso() { return new Date().toISOString(); }

// Defaults
interServerDelaySec  = (interServerDelaySec  != null) ? interServerDelaySec  : 10;
postRebootTimeoutSec = (postRebootTimeoutSec != null) ? postRebootTimeoutSec : 600;
pollIntervalSec      = (pollIntervalSec      != null) ? pollIntervalSec      : 15;
monitorPollSec       = (monitorPollSec       != null) ? monitorPollSec       : 15;
overallTimeoutSec    = (overallTimeoutSec    != null) ? overallTimeoutSec    : 0;
if (emailReport == null) { emailReport = true; }

if (!rebootWorkflow) {
    throw "Invoke-ServerReboot: 'rebootWorkflow' (Reboot-And-Track-Server) is required.";
}

System.log("========== Server Reboot run START ==========");
System.log("[reboot] group=" + adGroupName + " launchDelay=" + interServerDelaySec +
    "s childTimeout=" + postRebootTimeoutSec + "s email=" + (emailReport === true));

results = [];

// --- 1) Authoritative list from AD ------------------------------------------
var members = System.getModule(MOD).getAction("getAdGroupComputers").call(adGroupName) || [];
System.log("[reboot] " + members.length + " computer member(s) to process.");

// Lazy fallback name index (built once, only if a primary DNS resolve misses).
var nameIndex = null;
function ensureNameIndex() {
    if (nameIndex === null) {
        nameIndex = System.getModule(MOD).getAction("buildVmNameIndex").call();
    }
    return nameIndex;
}

// --- 2) Sequential staggered LAUNCH of async children -----------------------
var launches = []; // { token, adName, fqdn, vmName }
for (var i = 0; i < members.length; i++) {
    var m = members[i];
    var adName = m.cn || m.dnsHostName;

    var res = System.getModule(MOD).getAction("resolveVm").call(m.dnsHostName, m.cn, null);
    if (!res.vm) {
        res = System.getModule(MOD).getAction("resolveVm")
            .call(m.dnsHostName, m.cn, ensureNameIndex());
    }

    if (!res.vm) {
        // No child launched - record the skip directly.
        results.push({
            adName: adName, fqdn: m.dnsHostName, matchedVmName: null,
            status: "SKIPPED",
            reason: res.ambiguous ? "AMBIGUOUS_MATCH" : "NO_VM",
            message: res.ambiguous
                ? "Multiple VMs matched the name; skipped to avoid rebooting the wrong host."
                : "No VM found by Tools DNS or name in any registered vCenter.",
            elapsedSec: 0, timestamp: nowIso()
        });
        System.warn("[reboot] " + adName + " -> SKIPPED (" +
            (res.ambiguous ? "AMBIGUOUS_MATCH" : "NO_VM") + "), no child launched.");
        continue;
    }

    // Launch child asynchronously (execute() returns immediately with a token).
    var childInputs = new Properties();
    childInputs.put("vm", res.vm);
    childInputs.put("adName", adName);
    childInputs.put("fqdn", m.dnsHostName);
    childInputs.put("postRebootTimeoutSec", postRebootTimeoutSec);
    childInputs.put("pollIntervalSec", pollIntervalSec);

    var token = rebootWorkflow.execute(childInputs);
    launches.push({ token: token, adName: adName, fqdn: m.dnsHostName, vmName: res.vm.name });
    System.log("[reboot] Launched child for " + adName + " (VM '" + res.vm.name +
        "') token=" + token.id);

    // Delay BETWEEN launches (stagger), skip after the last member.
    if (i < members.length - 1 && interServerDelaySec > 0) {
        System.sleep(interServerDelaySec * 1000);
    }
}
System.log("[reboot] " + launches.length + " child run(s) launched; monitoring to completion.");

// --- 3) MONITOR child run states until all terminal -------------------------
function isTerminal(state) {
    return state == "completed" || state == "failed" || state == "canceled";
}
function readChildResult(token) {
    // Prefer the child's structured 'result' output; tolerate API return shapes.
    try {
        var out = token.getOutputParameters(); // VALIDATE: Properties or Attribute[]
        if (out) {
            if (typeof out.get === "function") {
                var r = out.get("result");
                if (r) { return r; }
            }
            if (out.length) {
                for (var k = 0; k < out.length; k++) {
                    if (out[k].name === "result") { return out[k].value; }
                }
            }
        }
    } catch (e) {
        System.warn("[reboot] readChildResult error: " + e);
    }
    return null;
}
function synthResult(L, state) {
    var reason = (state == "canceled") ? "CHILD_CANCELED" : "CHILD_FAILED";
    var msg = "Child run ended '" + state + "'";
    try { if (L.token.exception) { msg += ": " + L.token.exception; } } catch (e) {}
    return {
        adName: L.adName, fqdn: L.fqdn, matchedVmName: L.vmName,
        status: "FAILED", reason: reason, message: msg,
        elapsedSec: 0, timestamp: nowIso()
    };
}

var monitorStart = System.getCurrentTime();
var pending = launches.slice();
while (pending.length > 0) {
    var stillPending = [];
    for (var p = 0; p < pending.length; p++) {
        var L = pending[p];
        var state;
        try { state = L.token.state; } catch (e) { state = "failed"; }

        if (isTerminal(state)) {
            var rec = (state == "completed") ? readChildResult(L.token) : null;
            if (!rec) { rec = synthResult(L, state); }
            results.push(rec);
            System.log("[reboot] child " + L.adName + " ended '" + state + "' -> " +
                rec.status + " (" + rec.reason + ")");
        } else {
            stillPending.push(L);
        }
    }
    pending = stillPending;
    if (pending.length === 0) { break; }

    // Optional overall safety cap.
    if (overallTimeoutSec > 0 &&
        (System.getCurrentTime() - monitorStart) > overallTimeoutSec * 1000) {
        System.error("[reboot] Overall monitor timeout (" + overallTimeoutSec +
            "s) hit with " + pending.length + " child run(s) still active.");
        for (var q = 0; q < pending.length; q++) {
            var lp = pending[q];
            results.push({
                adName: lp.adName, fqdn: lp.fqdn, matchedVmName: lp.vmName,
                status: "FAILED", reason: "MONITOR_TIMEOUT",
                message: "Parent stopped waiting after " + overallTimeoutSec +
                    "s; child run '" + lp.token.id + "' still active.",
                elapsedSec: 0, timestamp: nowIso()
            });
        }
        break;
    }
    System.sleep(monitorPollSec * 1000);
}

// --- 4) Summary + report + mail ---------------------------------------------
var c = { SUCCESS: 0, FAILED: 0, SKIPPED: 0 };
for (var s = 0; s < results.length; s++) {
    c[results[s].status] = (c[results[s].status] || 0) + 1;
}
summary = "Total " + results.length + " | Success " + c.SUCCESS +
    " | Failed " + c.FAILED + " | Skipped " + c.SKIPPED;
System.log("[reboot] SUMMARY: " + summary);

reportHtml = System.getModule(MOD).getAction("buildHtmlReport").call(results, headerNote);

if (emailReport === true) {
    try {
        var toStr = (mailTo && mailTo.length) ? mailTo.join(",") : "";
        var ccStr = (mailCc && mailCc.length) ? mailCc.join(",") : "";
        if (!toStr) {
            System.warn("[reboot] emailReport=true but no recipients in mailTo - skipping send.");
        } else {
            var mail = new EmailMessage();
            mail.smtpHost = smtpServer;
            mail.fromAddress = mailFrom;
            mail.toAddress = toStr;
            if (ccStr) { mail.ccAddress = ccStr; }
            mail.subject = mailSubject || "VCF Orchestrator: Server Reboot Report";
            mail.addMimePart(reportHtml, "text/html");
            mail.sendMessage();
            System.log("[reboot] Report emailed to: " + toStr + (ccStr ? " cc " + ccStr : ""));
        }
    } catch (e) {
        System.error("[reboot] Failed to send email report: " + e);
    }
} else {
    System.log("[reboot] emailReport=false - report available in variable 'reportHtml'.");
}

System.log("========== Server Reboot run END ==========");
