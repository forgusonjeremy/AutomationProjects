/**
 * Action: sendHtmlEmail
 * Module:  com.broadcom.pso.vcf.notification   (SHARED - reference, do not copy)
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (toAddresses, ccAddresses, subject, htmlBody, smtpHost, smtpPort, fromAddress)
 *
 * WHAT IT DOES
 *   Sends one HTML email through the Orchestrator Mail plug-in (EmailMessage). Returns true
 *   if the relay accepted it, false if it did not -- it does NOT throw on a send failure.
 *
 *   It replaces the Send-MailMessage calls the PowerShell scripts in this family used to
 *   make from the PowerShell host. Mail now leaves from Orchestrator, so:
 *     - the scripts no longer need SMTP parameters, relay access, or a From address built
 *       from $env:COMPUTERNAME
 *     - the report is built from the structured result the script returned, not scraped
 *       from its console output
 *     - Send-MailMessage (obsolete since PowerShell 7.0) drops out of the scripts
 *
 * WHY A SEND FAILURE RETURNS false INSTEAD OF THROWING
 *   By the time the report is emailed, the work has already happened -- files were deleted,
 *   servers were rebooted. A relay outage must not turn that run into a "Failed" workflow
 *   that looks as if nothing was done. The caller folds the false into its own success
 *   output and says so in the log; the per-server detail is still in the run log.
 *
 *   Input problems that CAN be caught before any work is done (no recipients) should be
 *   caught by the workflow's parameter task, before the script runs. This action re-checks
 *   them and returns false rather than trusting that.
 *
 * INPUTS (in this order -- vRO passes action inputs positionally)
 *   toAddresses  Array/string  recipients; at least one
 *   ccAddresses  Array/string  CC recipients; may be empty or null
 *   subject      string        subject line
 *   htmlBody     string        complete HTML body
 *   smtpHost     string        SMTP relay. Leave BLANK to use the Mail plug-in's default
 *                              configuration (Library > Mail > Configuration > 'Configure mail').
 *   smtpPort     number        SMTP port. 0 or blank = the plug-in default (usually 25).
 *   fromAddress  string        sender. Leave BLANK to use the plug-in default.
 *
 * RETURNS
 *   boolean -- true if the message was handed to the relay, false otherwise
 *
 * LAB CHECK (once, before relying on the defaults)
 *   Run with smtpHost blank. If the log says "no SMTP host", this Orchestrator has no mail
 *   defaults configured: either run 'Configure mail', or supply smtpHost/fromAddress on the
 *   calling workflow's inputs. The behaviour of blank fields on EmailMessage has varied
 *   between plug-in versions, which is why this action reports the host it actually used.
 */

function trim(value) {
    return (value === null || value === undefined) ? "" : String(value).replace(/^\s+|\s+$/g, "");
}

function cleanList(list) {
    var out = [];
    if (list === null || list === undefined) { return out; }
    for (var i = 0; i < list.length; i++) {
        // A single entry may itself hold several addresses separated by , or ;
        var pieces = String(list[i]).split(/[,;]/);
        for (var j = 0; j < pieces.length; j++) {
            var address = trim(pieces[j]);
            if (address !== "") { out.push(address); }
        }
    }
    return out;
}

var to = cleanList(toAddresses);
var cc = cleanList(ccAddresses);

if (to.length === 0) {
    System.warn("sendHtmlEmail | no recipients were supplied; the report was NOT sent.");
    return false;
}
if (trim(htmlBody) === "") {
    System.warn("sendHtmlEmail | the message body is empty; the report was NOT sent.");
    return false;
}

try {
    var message = new EmailMessage();

    if (trim(smtpHost) !== "") { message.smtpHost = trim(smtpHost); }
    if (smtpPort !== null && smtpPort !== undefined && Number(smtpPort) > 0) { message.smtpPort = Number(smtpPort); }
    if (trim(fromAddress) !== "") { message.fromAddress = trim(fromAddress); }

    var hostUsed = trim(message.smtpHost);
    if (hostUsed === "") {
        System.warn(
            "sendHtmlEmail | no SMTP host: none was supplied and the Mail plug-in has no default configured. " +
            "Run Library > Mail > Configuration > 'Configure mail', or set smtpHost on the workflow. The report was NOT sent."
        );
        return false;
    }

    message.toAddress = to.join(",");
    if (cc.length > 0) { message.ccAddress = cc.join(","); }
    message.subject = trim(subject);
    message.addMimePart(String(htmlBody), "text/html; charset=UTF-8");

    System.log(
        "sendHtmlEmail | sending '" + message.subject + "' via " + hostUsed +
        (message.smtpPort ? ":" + message.smtpPort : "") + " to " + to.join(", ") +
        (cc.length > 0 ? " (cc " + cc.join(", ") + ")" : "")
    );
    message.sendMessage();
    System.log("sendHtmlEmail | sent.");
    return true;
}
catch (e) {
    System.warn("sendHtmlEmail | the report could not be emailed: " + e);
    return false;
}
