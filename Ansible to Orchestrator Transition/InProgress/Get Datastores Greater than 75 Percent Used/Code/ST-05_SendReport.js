/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ST-05 SEND THE REPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * Delivers the HTML report to the operations distribution list using the vRO
 * Mail plug-in (EmailMessage). This replaces Send-MailMessage inside the
 * PowerShell SendMail function, so no SMTP configuration and no relay hostname
 * remain on the PowerShell host.
 *
 * A delivery failure is recorded and re-raised. That is deliberate: this
 * workflow's entire purpose is to put the report in front of a human, so a run
 * that collected perfectly but delivered nothing has not succeeded and must not
 * end green. The exception routes to the exception handler, which logs the full
 * report to the workflow transcript so the content is never lost.
 *
 * CC IS OPTIONAL. Blank and whitespace-only entries are stripped before the
 * address list is built — the same defect that had to be fixed in the
 * PowerShell SendMail, where $MailCcString.split(',') on an empty string
 * yielded @('') and Send-MailMessage rejected it as null or empty.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 *   Name          vRO Type      Source
 *   ─────────────────────────────────────────────────────────────────────────────
 *   sendEmail     boolean       Workflow Input
 *   smtpHost      string        Workflow Input
 *   smtpPort      number        Workflow Input (default 25)
 *   smtpUseSsl    boolean       Workflow Input (default false)
 *   smtpUsername  string        Workflow Input (optional; blank = anonymous relay)
 *   smtpPassword  SecureString  Workflow Input (optional)
 *   mailFrom      string        Workflow Input
 *   mailTo        Array/string  Workflow Input
 *   mailCc        Array/string  Workflow Input (optional)
 *   mailSubject   string        Attribute, set by ST-03
 *   reportHtml    string        Attribute, set by ST-04
 *
 * ── OUTPUTS ──────────────────────────────────────────────────────────────────
 *   Name       vRO Type  Description
 *   ─────────────────────────────────────────────────────────────────────────────
 *   mailSent   boolean   True only if sendMessage() returned without throwing.
 */

var LOG = {
    ok:   function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [OK]     "+m); },
    skip: function(p,m){ System.log(  "[DATASTORE-REPORT] ["+p+"] [SKIP]   "+m); },
    fail: function(p,m){ System.error("[DATASTORE-REPORT] ["+p+"] [FAIL]   "+m); }
};

mailSent = false;

if (sendEmail !== true) {
    LOG.skip("NOTIFY", "sendEmail is false — report not emailed. It is available as the " +
                       "reportHtml workflow output.");
} else {

    // ── Build the address lists ──────────────────────────────────────────────
    function cleanAddresses(arr) {
        var out = [];
        if (!arr) return out;
        for (var i = 0; i < arr.length; i++) {
            var a = (arr[i] === null || arr[i] === undefined) ? "" : String(arr[i]).replace(/^\s+|\s+$/g, "");
            if (a.length > 0 && a.indexOf("@") > 0) out.push(a);
        }
        return out;
    }

    var toList = cleanAddresses(mailTo);
    var ccList = cleanAddresses(mailCc);

    if (toList.length === 0) {
        throw "sendEmail is true but no valid recipient address remains in mailTo after validation.";
    }

    // ── Compose ──────────────────────────────────────────────────────────────
    var msg = new EmailMessage();
    msg.smtpHost = smtpHost;
    msg.smtpPort = (smtpPort && Number(smtpPort) > 0) ? Number(smtpPort) : 25;

    if (smtpUseSsl === true) msg.useSsl = true;

    // Only authenticate when a username was supplied. The customer's existing
    // relay accepts anonymous submission, so this stays unset by default.
    if (smtpUsername && String(smtpUsername).length > 0) {
        msg.username = smtpUsername;
        msg.password = smtpPassword;
        LOG.ok("NOTIFY", "Authenticating to " + smtpHost + " as " + smtpUsername + ".");
    }

    msg.fromAddress = mailFrom;
    msg.fromName    = "VCF Orchestrator Datastore Report";
    msg.toAddress   = toList.join(",");
    if (ccList.length > 0) msg.ccAddress = ccList.join(",");
    msg.subject     = mailSubject;
    msg.addMimePart(reportHtml, "text/html");

    LOG.ok("NOTIFY", "Sending via " + msg.smtpHost + ":" + msg.smtpPort +
                     " | From: " + mailFrom +
                     " | To: " + toList.join(",") +
                     (ccList.length > 0 ? " | Cc: " + ccList.join(",") : " | Cc: (none)") +
                     " | Subject: " + mailSubject);

    try {
        msg.sendMessage();
        mailSent = true;
        LOG.ok("NOTIFY", "Report delivered to " + (toList.length + ccList.length) + " recipient(s).");
    } catch (e) {
        LOG.fail("NOTIFY", "Delivery FAILED via " + msg.smtpHost + ":" + msg.smtpPort +
                           " — " + e.message + ". The collected data is valid; only delivery " +
                           "failed. The full report is written to the transcript by the " +
                           "exception handler.");
        throw "Datastore report could not be delivered via " + msg.smtpHost + ": " + e.message;
    }
}
