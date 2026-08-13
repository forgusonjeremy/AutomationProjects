/**
 * ACTION: buildDatastoreReportHtml
 * Module : com.broadcom.pso.vc.storage.reporting
 *
 * Renders the banded HTML datastore capacity report that is emailed to the
 * operations distribution list and returned as a workflow output.
 *
 * Replaces the ConvertTo-Html fragment assembly in the
 * 'get_datastores_75_100_used' case of cvs_functions.ps1.
 *
 * PURE RENDERER. This action does no bucketing, no sorting and no filtering —
 * it draws exactly what ST-03 hands it. That is deliberate: the counts in the
 * mail subject are produced by ST-03, so if this action re-derived the bands
 * the subject line and the body could disagree after any future edit to either.
 *
 * Two changes to the retiring report are implemented here:
 *
 *   P-36  The report shows every datastore over the floor and carries
 *         overcommit as a COLUMN. The PowerShell required
 *         (uncommitted > freeSpace) as an AND condition for collection, so a
 *         datastore at 99% used with little thin-provisioned growth outstanding
 *         never appeared on the report at all.
 *   P-38  vCenters that could not be scanned are rendered into the report body.
 *         The recipient of the email is far more likely to read the email than
 *         to open Orchestrator, so an incomplete report must say so on its face.
 *         (Same reasoning as change S-16 on the Admin Accounts report.)
 *   P-39  A stylesheet is applied. The PowerShell emitted bare
 *         'ConvertTo-Html -Fragment' output with no <style> block for this
 *         action, unlike the VMware_Disable_SSH action in the same script,
 *         which builds one.
 *
 * -- INPUTS -------------------------------------------------------------------
 *   Name              Type    Description
 *   --------------------------------------------------------------------------
 *   bandedJson        string  JSON { critical[], warning[], advisory[], meta{} }
 *                             produced by ST-03. Row order is preserved as given.
 *   failuresJson      string  JSON array of { vcenterName, error } for vCenters
 *                             that could not be scanned. "[]" if all succeeded.
 *   skippedJson       string  JSON array of { vcenterName, name, moRef, reason }
 *                             for individual datastores that were not readable.
 *   scanSummaryJson   string  JSON { runId, startedAtIso, vcentersRequested,
 *                             vcentersScanned, totalDatastoresSeen }.
 *
 * -- RETURN TYPE --------------------------------------------------------------
 *   string  A complete HTML document with an inline stylesheet. Table layout and
 *           inline CSS only — no external assets, no flexbox, no scripts — so it
 *           renders in Outlook as well as in a browser.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Datastore names are operator-supplied free text and reach us straight from
// vCenter. Escape before they are concatenated into markup.
function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Distinguishes "no value" from "zero" in a numeric cell.
function num(v) {
    if (v === null || v === undefined || v === "") return "&mdash;";
    return esc(v);
}

// The retiring script displayed the short hostname only
// ($vcenter | %{$_.Split('.')[0]}). Kept, so the column stays readable.
function shortVc(v) {
    if (!v) return "";
    return String(v).split(".")[0];
}

function safeParse(raw, fallback, label) {
    try {
        var v = JSON.parse(raw || "");
        return (v === null || v === undefined) ? fallback : v;
    } catch (e) {
        System.warn("[DATASTORE-REPORT] [REPORT] [WARN]   buildDatastoreReportHtml: could not " +
                    "parse " + label + " — " + e.message + ". Continuing with an empty set.");
        return fallback;
    }
}

var banded   = safeParse(bandedJson,      {}, "bandedJson");
var failures = safeParse(failuresJson,    [], "failuresJson");
var skipped  = safeParse(skippedJson,     [], "skippedJson");
var summary  = safeParse(scanSummaryJson, {}, "scanSummaryJson");

var critical = banded.critical || [];
var warning  = banded.warning  || [];
var advisory = banded.advisory || [];
var meta     = banded.meta     || {};

var high     = (meta.criticalFloor === undefined) ? 90 : Number(meta.criticalFloor);
var medFloor = (meta.warningFloor  === undefined) ? 80 : Number(meta.warningFloor);
var lowFloor = (meta.advisoryFloor === undefined) ? 70 : Number(meta.advisoryFloor);

var totalReported = critical.length + warning.length + advisory.length;

// ─────────────────────────────────────────────────────────────────────────────
// Column definition — one place to add or reorder a column
// ─────────────────────────────────────────────────────────────────────────────
var COLS = [
    { h: "Datastore",         align: "left",   f: function(r){ return esc(r.name); } },
    { h: "vCenter",           align: "left",   f: function(r){ return esc(shortVc(r.vcenterName)); } },
    { h: "Datacenter",        align: "left",   f: function(r){ return esc(r.datacenter); } },
    { h: "Datastore Cluster", align: "left",   f: function(r){ return esc(r.datastoreCluster); } },
    { h: "Type",              align: "left",   f: function(r){ return esc(r.type); } },
    { h: "Capacity GB",       align: "right",  f: function(r){ return num(r.capacityGB); } },
    { h: "Used GB",           align: "right",  f: function(r){ return num(r.usedGB); } },
    { h: "Free GB",           align: "right",  f: function(r){ return num(r.freeSpaceGB); } },
    { h: "Uncommitted GB",    align: "right",  f: function(r){ return num(r.uncommittedGB); } },
    { h: "% Used",            align: "right",  f: function(r){ return num(r.percentUsed); } },
    { h: "% Free",            align: "right",  f: function(r){ return num(r.percentFree); } },
    { h: "Overcommitted",     align: "center", f: function(r){
            if (r.uncommittedKnown === false) return "<span class=\"unk\">unknown</span>";
            return (r.overcommitted === true)
                 ? "<span class=\"oc\">Yes</span>"
                 : "No";
        } }
];

function renderTable(rows, emptyMsg) {
    if (!rows || rows.length === 0) {
        return "<p class=\"empty\">" + esc(emptyMsg) + "</p>";
    }
    var h = ["<table><thead><tr>"];
    for (var c = 0; c < COLS.length; c++) h.push("<th>" + esc(COLS[c].h) + "</th>");
    h.push("</tr></thead><tbody>");
    for (var r = 0; r < rows.length; r++) {
        h.push("<tr>");
        for (var c2 = 0; c2 < COLS.length; c2++) {
            var cell;
            try {
                cell = COLS[c2].f(rows[r]);
            } catch (eCell) {
                cell = "&mdash;";   // a malformed row must not blank the whole report
            }
            h.push("<td class=\"a-" + COLS[c2].align + "\">" + cell + "</td>");
        }
        h.push("</tr>");
    }
    h.push("</tbody></table>");
    return h.join("");
}

function bandSection(label, cls, rangeText, rows) {
    return "<h3 class=\"band " + cls + "\">" + esc(label) + " &mdash; " + esc(rangeText) +
           " <span class=\"count\">(" + rows.length + ")</span></h3>" +
           renderTable(rows, "No datastores in this band.");
}

var STYLE =
"<style>" +
"body{background-color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1b1b1b;}" +
"h2{font-size:18px;margin:0 0 8px 0;}" +
"h3.band{font-size:14px;margin:22px 0 6px 0;padding:6px 9px;color:#ffffff;}" +
"h3.band.critical{background-color:#a4262c;}" +
"h3.band.warning{background-color:#b45309;}" +
"h3.band.advisory{background-color:#0f6cbd;}" +
"h3.band .count{font-weight:normal;}" +
"h4{font-size:13px;margin:22px 0 6px 0;}" +
"table{border-collapse:collapse;border:1px solid #8a8a8a;margin-bottom:4px;}" +
"th{border:1px solid #8a8a8a;padding:4px 8px;background-color:#4a4a4a;color:#ffffff;text-align:left;white-space:nowrap;}" +
"td{border:1px solid #8a8a8a;padding:3px 8px;background-color:#f4f4f4;white-space:nowrap;}" +
"td.a-right{text-align:right;}td.a-center{text-align:center;}td.a-left{text-align:left;}" +
"span.oc{color:#a4262c;font-weight:bold;}" +
"span.unk{color:#6a6a6a;font-style:italic;}" +
"p.empty{color:#4a4a4a;font-style:italic;margin:4px 0 0 2px;}" +
"table.meta{border:none;}" +
"table.meta td{background-color:#ffffff;border:none;padding:1px 14px 1px 0;}" +
"div.alert{border-left:4px solid #a4262c;background-color:#fdf3f4;padding:9px 12px;margin:14px 0;}" +
"p.foot{color:#5a5a5a;font-size:11px;margin-top:24px;border-top:1px solid #d0d0d0;padding-top:8px;}" +
"</style>";

var H = [];
H.push("<html><head><meta charset=\"utf-8\">" + STYLE + "</head><body>");

// ── Header / run metadata ────────────────────────────────────────────────────
H.push("<h2>Datastore Capacity Report</h2>");
H.push("<table class=\"meta\">");
H.push("<tr><td><b>Generated</b></td><td>" + esc(summary.startedAtIso || "") + "</td></tr>");
H.push("<tr><td><b>Run ID</b></td><td>" + esc(summary.runId || "") + "</td></tr>");
H.push("<tr><td><b>vCenters scanned</b></td><td>" +
       esc(summary.vcentersScanned === undefined ? "?" : summary.vcentersScanned) + " of " +
       esc(summary.vcentersRequested === undefined ? "?" : summary.vcentersRequested) + "</td></tr>");
H.push("<tr><td><b>Datastores inspected</b></td><td>" +
       esc(summary.totalDatastoresSeen === undefined ? "?" : summary.totalDatastoresSeen) + "</td></tr>");
H.push("<tr><td><b>Reporting floor</b></td><td>" + esc(lowFloor) + "% used</td></tr>");
H.push("<tr><td><b>Reported</b></td><td>" + totalReported + " datastore(s), of which " +
       esc(meta.overcommitted === undefined ? "?" : meta.overcommitted) + " overcommitted" +
       ((meta.uncommittedUnknown > 0)
            ? " (" + esc(meta.uncommittedUnknown) + " with no uncommitted value published)"
            : "") +
       "</td></tr>");
H.push("</table>");

// ── P-38: unscanned vCenters surfaced in the report body ─────────────────────
if (failures.length > 0) {
    H.push("<div class=\"alert\">");
    H.push("<b>This report is incomplete.</b> " + failures.length + " vCenter(s) could not be " +
           "scanned, so any datastore hosted on them is absent from the tables below. " +
           "Treat the counts as a floor, not a total.");
    H.push("<table><thead><tr><th>vCenter</th><th>Reason</th></tr></thead><tbody>");
    for (var f = 0; f < failures.length; f++) {
        H.push("<tr><td class=\"a-left\">" + esc(failures[f].vcenterName) + "</td>" +
               "<td class=\"a-left\">" + esc(failures[f].error) + "</td></tr>");
    }
    H.push("</tbody></table></div>");
}

// ── Bands ────────────────────────────────────────────────────────────────────
H.push(bandSection("Critical", "critical", high + "% and above", critical));
H.push(bandSection("Warning",  "warning",  medFloor + "% to under " + high + "%", warning));
H.push(bandSection("Advisory", "advisory", lowFloor + "% to under " + medFloor + "%", advisory));

if (totalReported === 0 && failures.length === 0) {
    H.push("<p class=\"empty\">No datastore in the scanned estate is at or above " +
           esc(lowFloor) + "% used.</p>");
}

// ── Datastores that could not be read ────────────────────────────────────────
if (skipped.length > 0) {
    H.push("<h4>Datastores that could not be evaluated (" + skipped.length + ")</h4>");
    H.push("<table><thead><tr><th>Datastore</th><th>vCenter</th><th>Reason</th></tr></thead><tbody>");
    for (var s = 0; s < skipped.length; s++) {
        H.push("<tr><td class=\"a-left\">" + esc(skipped[s].name) + "</td>" +
               "<td class=\"a-left\">" + esc(shortVc(skipped[s].vcenterName)) + "</td>" +
               "<td class=\"a-left\">" + esc(skipped[s].reason) + "</td></tr>");
    }
    H.push("</tbody></table>");
}

// ── Footer / legend ──────────────────────────────────────────────────────────
H.push("<p class=\"foot\">");
H.push("<b>Overcommitted</b> means the datastore's uncommitted space &mdash; the space that " +
       "thin-provisioned disks, linked clones and snapshots are entitled to consume &mdash; " +
       "exceeds its remaining free space. Such a datastore can fill without a single new " +
       "virtual machine being deployed. It is shown as a column rather than used as a filter, " +
       "so a datastore that is simply full is still reported. <i>unknown</i> means vCenter " +
       "published no uncommitted value for that datastore type.<br>");
H.push("Bands are contiguous and every reported datastore appears in exactly one of them. " +
       "Generated by VCF Operations Orchestrator, workflow <i>Get Datastore Capacity Report</i>. " +
       "Filter the Orchestrator log on <i>[DATASTORE-REPORT]</i> for the full run transcript.");
H.push("</p>");
H.push("</body></html>");

var html = H.join("");

System.log("[DATASTORE-REPORT] [REPORT] [OK]     Report rendered — " +
           critical.length + " critical, " + warning.length + " warning, " +
           advisory.length + " advisory, " + failures.length + " vCenter failure(s), " +
           skipped.length + " unreadable datastore(s). HTML length " + html.length + " chars.");

return html;
