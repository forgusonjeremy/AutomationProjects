/**
 * ACTION: buildDatastoreReportHtml
 * Module : com.broadcom.pso.vc.storage.reporting
 *
 * Renders the banded HTML datastore capacity report that is emailed to the
 * operations distribution list and returned as a workflow output.
 *
 * PURE RENDERER. This action does no bucketing, no sorting and no filtering —
 * it draws exactly what ST-03 hands it. That is deliberate: the counts in the
 * mail subject are produced by ST-03, so if this action re-derived the bands
 * the subject line and the body could disagree after any future edit to either.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EVERY STYLE IS INLINE. THIS IS NOT A PREFERENCE — IT IS AN OUTLOOK
 * REQUIREMENT.
 * ───────────────────────────────────────────────────────────────────────────
 *   Outlook renders mail with the WORD engine, which ignores most CSS declared
 *   in a <style> block — including background-color on table cells, which is
 *   what every band header and every zebra stripe in this report depends on.
 *   A <style>-block report renders as unstyled text in the client the majority
 *   of the recipients actually use.
 *
 *   So: inline style="" on every element, PLUS the legacy bgcolor="" attribute
 *   on cells that carry a background, because the Word engine honours bgcolor
 *   more reliably than it honours inline background-color. Layout is
 *   table-based with role="presentation" for the same reason — the Word engine
 *   has no useful support for modern layout.
 *
 *   This approach is adopted from the customer's own cvs_50_100.ps1
 *   (Format-DsTableHtml), which had already solved this correctly. An earlier
 *   revision of this action used a <style> block and would have regressed the
 *   report's appearance in Outlook relative to what the customer has today.
 *   See change P-39 in the Change Register.
 *
 *   IF YOU EDIT THIS FILE: do not "tidy" the inline styles into a stylesheet.
 *   Verify any change by sending the report to a real Outlook client, not by
 *   opening the HTML in a browser — a browser will render both approaches
 *   identically and will therefore not catch the regression.
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
 *   string  A complete HTML document, self-contained and email-safe.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Palette — matches the customer's existing datastore report so the transition
// does not also change the colours the recipients are used to.
// ─────────────────────────────────────────────────────────────────────────────
var ACCENT_CRITICAL = "#b91c1c";
var ACCENT_WARNING  = "#c2410c";
var ACCENT_ADVISORY = "#a16207";
var ACCENT_NEUTRAL  = "#64748b";

var FONT     = "Segoe UI,Arial,sans-serif";
var BORDER   = "#e5e7eb";
var INK      = "#111827";
var INK_SOFT = "#374151";
var INK_MUTE = "#6b7280";
var ZEBRA    = "#f9fafb";

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
// Inline style fragments
// ─────────────────────────────────────────────────────────────────────────────
var S = {
    body:      "margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;",
    shell:     "background:#f3f4f6;",
    card:      "max-width:1120px;width:100%;background:#ffffff;border:1px solid " + BORDER + ";" +
               "border-radius:8px;overflow:hidden;",
    banner:    "background:#1f2937;padding:20px 28px;font-family:" + FONT + ";color:#ffffff;" +
               "font-size:19px;font-weight:700;",
    intro:     "padding:18px 28px 4px;font-family:" + FONT + ";color:" + INK_SOFT + ";" +
               "font-size:13px;line-height:1.5;",
    section:   "padding:8px 28px 4px;",
    metaCell:  "padding:1px 14px 1px 0;font-family:" + FONT + ";font-size:13px;color:" + INK_SOFT + ";",
    table:     "border-collapse:collapse;width:100%;margin:6px 0 20px;font-family:" + FONT + ";font-size:13px;",
    tdBase:    "padding:7px 11px;border:1px solid " + BORDER + ";color:" + INK + ";",
    empty:     "margin:6px 0 20px;padding:10px 12px;background:" + ZEBRA + ";border:1px dashed #d1d5db;" +
               "border-radius:4px;color:" + INK_MUTE + ";font-size:13px;font-family:" + FONT + ";",
    footer:    "background:" + ZEBRA + ";border-top:1px solid " + BORDER + ";padding:14px 28px;" +
               "font-family:" + FONT + ";color:" + INK_MUTE + ";font-size:11px;line-height:1.5;"
};

function headingStyle(accent) {
    return "font-family:" + FONT + ";font-size:13px;font-weight:700;color:" + accent + ";" +
           "margin:14px 0 0;padding-bottom:6px;border-bottom:2px solid " + accent + ";";
}

function thStyle(accent) {
    return "background:" + accent + ";color:#ffffff;text-align:left;padding:9px 11px;" +
           "font-weight:600;font-size:12px;white-space:nowrap;border:1px solid " + accent + ";";
}

function tdStyle(align, zebra) {
    return S.tdBase +
           "background:" + (zebra ? ZEBRA : "#ffffff") + ";" +
           "text-align:" + align + ";white-space:nowrap;";
}

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
            if (r.uncommittedKnown === false) {
                return "<span style=\"color:" + INK_MUTE + ";font-style:italic;\">unknown</span>";
            }
            return (r.overcommitted === true)
                 ? "<span style=\"color:" + ACCENT_CRITICAL + ";font-weight:bold;\">Yes</span>"
                 : "No";
        } }
];

function renderTable(rows, accent, emptyMsg) {
    if (!rows || rows.length === 0) {
        return "<p style=\"" + S.empty + "\">" + esc(emptyMsg) + "</p>";
    }

    var h = ["<table cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"" + S.table + "\">"];

    h.push("<thead><tr>");
    for (var c = 0; c < COLS.length; c++) {
        // bgcolor as well as the inline style: the Word engine used by Outlook
        // honours the attribute more reliably than the CSS property.
        h.push("<th align=\"left\" bgcolor=\"" + accent + "\" style=\"" + thStyle(accent) + "\">" +
               esc(COLS[c].h) + "</th>");
    }
    h.push("</tr></thead><tbody>");

    for (var r = 0; r < rows.length; r++) {
        var zebra = (r % 2 === 1);
        h.push(zebra ? "<tr bgcolor=\"" + ZEBRA + "\">" : "<tr>");
        for (var c2 = 0; c2 < COLS.length; c2++) {
            var cell;
            try {
                cell = COLS[c2].f(rows[r]);
            } catch (eCell) {
                cell = "&mdash;";   // a malformed row must not blank the whole report
            }
            h.push("<td style=\"" + tdStyle(COLS[c2].align, zebra) + "\">" + cell + "</td>");
        }
        h.push("</tr>");
    }

    h.push("</tbody></table>");
    return h.join("");
}

function bandSection(label, accent, rangeText, rows) {
    return "<div style=\"" + headingStyle(accent) + "\">&#9679; " + esc(label) +
           " &nbsp;&ndash;&nbsp; " + esc(rangeText) + " (" + rows.length + ")</div>" +
           renderTable(rows, accent, "None in this range.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────
var H = [];

H.push("<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
       "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>");
H.push("<body style=\"" + S.body + "\">");
H.push("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"" + S.shell + "\">");
H.push("<tr><td align=\"center\" style=\"padding:24px 12px;\">");
H.push("<table role=\"presentation\" width=\"1120\" cellpadding=\"0\" cellspacing=\"0\" style=\"" + S.card + "\">");

// ── Banner ───────────────────────────────────────────────────────────────────
H.push("<tr><td style=\"" + S.banner + "\">Datastore Capacity Report</td></tr>");

// ── Legend ───────────────────────────────────────────────────────────────────
H.push("<tr><td style=\"" + S.intro + "\">");
H.push("Every datastore at or above <b>" + esc(lowFloor) + "%</b> used is listed below, grouped by " +
       "severity, fullest first. <b>Overcommitted</b> marks a datastore whose uncommitted " +
       "(thin-provisioned) space exceeds its remaining free space &mdash; it is shown as a column, " +
       "not used as a filter, so a datastore that is simply full is still reported.");
H.push("</td></tr>");

// ── Run metadata ─────────────────────────────────────────────────────────────
H.push("<tr><td style=\"" + S.section + "\">");
H.push("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse;\">");
H.push("<tr><td style=\"" + S.metaCell + "\"><b>Generated</b></td><td style=\"" + S.metaCell + "\">" +
       esc(summary.startedAtIso || "") + "</td></tr>");
H.push("<tr><td style=\"" + S.metaCell + "\"><b>Run ID</b></td><td style=\"" + S.metaCell + "\">" +
       esc(summary.runId || "") + "</td></tr>");
H.push("<tr><td style=\"" + S.metaCell + "\"><b>vCenters scanned</b></td><td style=\"" + S.metaCell + "\">" +
       esc(summary.vcentersScanned === undefined ? "?" : summary.vcentersScanned) + " of " +
       esc(summary.vcentersRequested === undefined ? "?" : summary.vcentersRequested) + "</td></tr>");
H.push("<tr><td style=\"" + S.metaCell + "\"><b>Datastores inspected</b></td><td style=\"" + S.metaCell + "\">" +
       esc(summary.totalDatastoresSeen === undefined ? "?" : summary.totalDatastoresSeen) + "</td></tr>");
H.push("<tr><td style=\"" + S.metaCell + "\"><b>Reported</b></td><td style=\"" + S.metaCell + "\">" +
       totalReported + " datastore(s), of which " +
       esc(meta.overcommitted === undefined ? "?" : meta.overcommitted) + " overcommitted" +
       ((meta.uncommittedUnknown > 0)
            ? " (" + esc(meta.uncommittedUnknown) + " with no uncommitted value published)"
            : "") + "</td></tr>");
H.push("</table></td></tr>");

// ── Incomplete-scan banner (P-38) ────────────────────────────────────────────
if (failures.length > 0) {
    H.push("<tr><td style=\"" + S.section + "\">");
    H.push("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" " +
           "style=\"border-collapse:collapse;margin:10px 0 4px;\">");
    H.push("<tr><td bgcolor=\"#fdf3f4\" style=\"background:#fdf3f4;border-left:4px solid " +
           ACCENT_CRITICAL + ";padding:10px 14px;font-family:" + FONT + ";font-size:13px;color:" +
           INK_SOFT + ";line-height:1.5;\">");
    H.push("<b style=\"color:" + ACCENT_CRITICAL + ";\">This report is incomplete.</b> " +
           failures.length + " vCenter(s) could not be scanned, so any datastore hosted on them is " +
           "absent from the tables below. Treat the counts as a floor, not a total.");
    H.push("</td></tr></table>");

    H.push("<table cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"" + S.table + "\">");
    H.push("<thead><tr>" +
           "<th align=\"left\" bgcolor=\"" + ACCENT_CRITICAL + "\" style=\"" + thStyle(ACCENT_CRITICAL) + "\">vCenter</th>" +
           "<th align=\"left\" bgcolor=\"" + ACCENT_CRITICAL + "\" style=\"" + thStyle(ACCENT_CRITICAL) + "\">Reason</th>" +
           "</tr></thead><tbody>");
    for (var f = 0; f < failures.length; f++) {
        var fz = (f % 2 === 1);
        H.push((fz ? "<tr bgcolor=\"" + ZEBRA + "\">" : "<tr>") +
               "<td style=\"" + tdStyle("left", fz) + "\">" + esc(failures[f].vcenterName) + "</td>" +
               "<td style=\"" + S.tdBase + "background:" + (fz ? ZEBRA : "#ffffff") +
               ";text-align:left;\">" + esc(failures[f].error) + "</td></tr>");
    }
    H.push("</tbody></table></td></tr>");
}

// ── Bands ────────────────────────────────────────────────────────────────────
H.push("<tr><td style=\"" + S.section + "\">");
H.push(bandSection("Critical", ACCENT_CRITICAL, "&ge; " + high + "% used", critical));
H.push(bandSection("Warning",  ACCENT_WARNING,  medFloor + "% to under " + high + "% used", warning));
H.push(bandSection("Advisory", ACCENT_ADVISORY, lowFloor + "% to under " + medFloor + "% used", advisory));

if (totalReported === 0 && failures.length === 0) {
    H.push("<p style=\"" + S.empty + "\">No datastore in the scanned estate is at or above " +
           esc(lowFloor) + "% used.</p>");
}
H.push("</td></tr>");

// ── Datastores that could not be read ────────────────────────────────────────
if (skipped.length > 0) {
    H.push("<tr><td style=\"" + S.section + "\">");
    H.push("<div style=\"" + headingStyle(ACCENT_NEUTRAL) + "\">&#9679; Could not be evaluated (" +
           skipped.length + ")</div>");
    H.push("<table cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"" + S.table + "\">");
    H.push("<thead><tr>" +
           "<th align=\"left\" bgcolor=\"" + ACCENT_NEUTRAL + "\" style=\"" + thStyle(ACCENT_NEUTRAL) + "\">Datastore</th>" +
           "<th align=\"left\" bgcolor=\"" + ACCENT_NEUTRAL + "\" style=\"" + thStyle(ACCENT_NEUTRAL) + "\">vCenter</th>" +
           "<th align=\"left\" bgcolor=\"" + ACCENT_NEUTRAL + "\" style=\"" + thStyle(ACCENT_NEUTRAL) + "\">Reason</th>" +
           "</tr></thead><tbody>");
    for (var s = 0; s < skipped.length; s++) {
        var sz = (s % 2 === 1);
        H.push((sz ? "<tr bgcolor=\"" + ZEBRA + "\">" : "<tr>") +
               "<td style=\"" + tdStyle("left", sz) + "\">" + esc(skipped[s].name) + "</td>" +
               "<td style=\"" + tdStyle("left", sz) + "\">" + esc(shortVc(skipped[s].vcenterName)) + "</td>" +
               "<td style=\"" + S.tdBase + "background:" + (sz ? ZEBRA : "#ffffff") +
               ";text-align:left;\">" + esc(skipped[s].reason) + "</td></tr>");
    }
    H.push("</tbody></table></td></tr>");
}

// ── Footer ───────────────────────────────────────────────────────────────────
H.push("<tr><td style=\"" + S.footer + "\">");
H.push("Bands are contiguous and every reported datastore appears in exactly one of them. " +
       "<i>unknown</i> in the Overcommitted column means vCenter published no uncommitted value " +
       "for that datastore type.<br>");
H.push("Generated by VCF Operations Orchestrator, workflow <i>Get Datastore Capacity Report</i> " +
       "&bull; " + esc(summary.startedAtIso || "") + " &bull; filter the Orchestrator log on " +
       "<i>[DATASTORE-REPORT]</i> for the full run transcript.");
H.push("</td></tr>");

H.push("</table></td></tr></table></body></html>");

var html = H.join("");

System.log("[DATASTORE-REPORT] [REPORT] [OK]     Report rendered — " +
           critical.length + " critical, " + warning.length + " warning, " +
           advisory.length + " advisory, " + failures.length + " vCenter failure(s), " +
           skipped.length + " unreadable datastore(s). HTML length " + html.length + " chars.");

return html;
