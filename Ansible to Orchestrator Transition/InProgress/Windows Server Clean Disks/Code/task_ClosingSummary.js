/* ═════════════════════════════════════════════════════════════════════════════
 * Scriptable task:  Closing Summary
 * Workflow:         Windows Server Disk Cleans
 *
 * IN   executionSuccess  boolean       output   (set by Parse Results)
 *      executionOutput   string        output   (set by Parse Results)
 *      emailReport       boolean       input
 *      emailError        string        attr     (exception binding of 'Send notification
 *                                                (TLSv1.2)'; empty unless the send threw)
 *      adGroup           AD:UserGroup  attr
 *      reportOnly        string        input
 *      stagedScript      string        attr     (the verified script path)
 * OUT  executionSuccess  boolean       output
 *
 * Every path after Parse Results ends here -- email sent, email failed, email off -- so
 * the run record always finishes with the same line: outcome, group, mode and script.
 *
 * "Sent" is inferred: with email on, this task is reached either from the send's normal
 * exit (sent) or from its exception path (emailError holds the reason). The OOTB
 * workflow has no output that says so directly.
 *
 * A failed send does NOT fail the run: by the time mail is sent the files are already
 * deleted, and a Failed end state would make a completed clean look as if nothing
 * happened. It is recorded as not fully successful instead.
 * ═════════════════════════════════════════════════════════════════════════════ */

var success = (executionSuccess === true);
var emailFailed = (emailError !== null && emailError !== undefined &&
                   String(emailError).replace(/^\s+|\s+$/g, "") !== "");

if (emailReport === true && emailFailed) {
    success = false;
    System.warn(
        "The report email was NOT sent: " + emailError +
        " -- check that this Orchestrator can reach the SMTP relay and that the relay settings " +
        "(host, port, STARTTLS, credentials) match the mail server. The per-server detail is in this run's log."
    );
}
executionSuccess = success;

var closing =
    "Windows Server Disk Cleans | group=" + adGroup.name +
    " | reportOnly=" + reportOnly +
    " | script=" + stagedScript +
    " | " + executionOutput +
    (emailReport === true ? (emailFailed ? " | report NOT emailed" : " | report emailed") : " | email off");

if (success) {
    System.log(closing);
}
else {
    System.warn(closing + " | Completed WITH ERRORS -- see the warnings above.");
}
