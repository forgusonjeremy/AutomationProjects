/**
 * Action: resolvePowerShellHostForAccount
 * Module:  com.broadcom.pso.vcf.powershell.identity   (SHARED - reference, do not copy)
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (accountCategoryPath, runAsAccount)
 *
 * Purpose:
 *   Resolves the PowerShell host object that carries a given service account, and returns
 *   it for binding to the OOTB 'Invoke a PowerShell script' workflow.
 *
 *   SUPERSEDES resolvePowerShellHostForDomain (Service Account Password Rotation/Code/).
 *   Same mechanism, keyed on the ACCOUNT rather than the domain - see below. That action
 *   should be deleted rather than left beside this one: two resolvers reading two maps is
 *   the half-updated-mapping defect it was written to prevent.
 *
 * ── Why keyed on the account ──────────────────────────────────────────────────
 *
 *   In AAP, the identity a job ran as was decided by the CREDENTIAL attached to the job
 *   template. Not the domain - the credential. That distinction is not cosmetic:
 *
 *     - The Admin PKI report sweeps EIGHT domains in one invocation. There is no single
 *       "domain" to key on; there is exactly one account the sweep runs as. Keying on
 *       domain has nothing to offer it.
 *     - A domain can legitimately have more than one service account - a read-only one for
 *       reports and a privileged one for password resets is the obvious pair, and the
 *       rotation design already requires that the host's own account is never one of the
 *       accounts being rotated. Domain -> host cannot express that; account -> host can.
 *     - It matches what an operator already understands. "Which credential does this run
 *       use" is the question the AAP job template answered, and the workflow input now
 *       answers it in the same words.
 *
 *   Everything else is unchanged from the domain-keyed version, including the reasoning
 *   below, which is the important part.
 *
 * ── Why this exists at all ────────────────────────────────────────────────────
 *
 *   Nothing in cvs_functions*.ps1 or cvs_admin.ps1 passes -Credential for the ambient case.
 *   Every Get-ADUser, Get-ADGroupMember and Invoke-Command runs as the identity of the
 *   PowerShell session, so the account logging into the pool silently decides which domains
 *   the script can reach.
 *
 *   AAP varied that account per job template against the same server pool. vRO moved the
 *   choice to the host object and bound one host object everywhere - recorded in
 *   'Ansible-to-vRO-MappingTable.md:105' as "All workflows use a single psHost plugin object
 *   (intended)" - which collapsed the variation with nowhere for it to go. The fix is not
 *   more servers: it is more HOST OBJECTS pointing at the same servers, each carrying a
 *   different account, selected at run time.
 *
 * ── Registering the host objects ──────────────────────────────────────────────
 *
 *   Library > PowerShell > Configuration > Add a PowerShell host, once per account, all
 *   pointing at the SAME pool FQDN:
 *
 *     name:     pshost-subdom6              <- the 'name' input, NOT the host FQDN
 *     host:     pool01.subdom6.company.net
 *     port:     5986 / HTTPS / Kerberos / Shared Session
 *     username: svc-vro-subdom6@SUBDOM6.COMPANY.NET     (UPN form)
 *
 *     name:     pshost-subdom8
 *     host:     pool01.subdom6.company.net  <- same server
 *     username: svc-vro-subdom8@SUBDOMAIN8.NET          (different domain's account)
 *
 *   NAME THEM FOR THE IDENTITY, NOT THE SERVER. The registration workflow takes 'name'
 *   separately from 'host', and two host objects sharing one FQDN are indistinguishable in
 *   the inventory if both are named after the server. An operator picking the wrong one gets
 *   authentication failures against the target domain that look nothing like a naming
 *   problem.
 *
 *   SHARED SESSION IS REQUIRED. Per-user session mode authenticates as the vRO user, which
 *   defeats the entire mechanism.
 *
 *   KERBEROS DELEGATION IS REQUIRED for any script that queries AD (P-65). Every
 *   'Get-ADUser -Server <domain>' is a second hop from a network logon. AAP configures this
 *   with 'ansible_winrm_kerberos_delegation: yes'; the host object must request the
 *   equivalent, or it will connect happily and fail on the first AD call. See
 *   Script-Staging-Design.md §6.3.
 *
 * ── Configuration Element schema ──────────────────────────────────────────────
 *
 *     Category:  <accountCategoryPath>   e.g. 'PSO/Identity/RunAsAccounts'
 *     Element:   the SELECTOR, and the value an operator picks from the dropdown,
 *                e.g. 'svc-vro-subdom6@subdom6.company.net'
 *
 *       psHostName   string  REQUIRED  name of the PowerShell:PowerShellHost object
 *       domain       string  optional  the account's AD domain, for workflows that also
 *                                      need it as a script parameter
 *       description  string  optional  free text shown to operators
 *
 *   NOTE the category is 'RunAsAccounts', deliberately NOT 'PSO/Identity/ServiceAccounts'.
 *   That path is taken by the password-rotation store, whose elements hold SecureString
 *   passwords under a completely different schema. Two schemas in one category is a
 *   configuration error waiting to be made at 2am.
 *
 * Inputs:
 *   accountCategoryPath (string) - Configuration Element category, e.g. 'PSO/Identity/RunAsAccounts'
 *   runAsAccount        (string) - the selector; bind to the workflow's dropdown input,
 *                                  populated by getRunAsAccountSelectors
 *
 * Returns: PowerShell:PowerShellHost - bind to the OOTB invoke workflow's host input
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!accountCategoryPath || String(accountCategoryPath).trim() === "") {
    throw new Error("resolvePowerShellHostForAccount: accountCategoryPath is required, e.g. 'PSO/Identity/RunAsAccounts'.");
}
if (!runAsAccount || String(runAsAccount).trim() === "") {
    throw new Error(
        "resolvePowerShellHostForAccount: runAsAccount is required. It is the identity the SCRIPT will run " +
        "as, which decides which domains it can read - not necessarily the domain of the servers being acted " +
        "on, since the pool is joined to one domain regardless of which directory is queried."
    );
}

var wantCategory = String(accountCategoryPath).trim().replace(/^\/+|\/+$/g, "");
var wantAccount  = String(runAsAccount).trim();

// ── Look up the account's mapping element ─────────────────────────────────────

var category = Server.getConfigurationElementCategoryWithPath(wantCategory);
if (category === null || category === undefined) {
    throw new Error(
        "resolvePowerShellHostForAccount: no Configuration Element category at '" + wantCategory + "'. Create " +
        "one element per run-as account, each naming the PowerShell host object registered with that account."
    );
}

var accountElement = null;
var knownAccounts  = [];
var elements = category.configurationElements || [];
for (var i = 0; i < elements.length; i++) {
    knownAccounts.push(elements[i].name);
    // Account names, like domain names, are case-insensitive in AD.
    if (String(elements[i].name).toLowerCase() === wantAccount.toLowerCase()) {
        accountElement = elements[i];
    }
}

if (accountElement === null) {
    throw new Error(
        "resolvePowerShellHostForAccount: '" + wantAccount + "' has no Configuration Element in '" +
        wantCategory + "'. Mapped accounts: " + (knownAccounts.length > 0 ? knownAccounts.join(", ") : "(none)") +
        ". An unmapped account is a deliberate hard failure: falling back to a default host would run the " +
        "request as whatever identity that host holds, which either fails against the target domain or - " +
        "worse - succeeds against the wrong one."
    );
}

var hostNameAttr = accountElement.getAttributeWithKey("psHostName");
if (hostNameAttr === null || hostNameAttr === undefined ||
    hostNameAttr.value === null || hostNameAttr.value === undefined ||
    String(hostNameAttr.value).trim() === "") {
    throw new Error(
        "resolvePowerShellHostForAccount: Configuration Element '" + accountElement.name + "' has no " +
        "'psHostName' value. It must name the PowerShell host OBJECT (the 'name' given when the host was " +
        "registered), not the server FQDN - several host objects share one FQDN by design."
    );
}

var wantHostName = String(hostNameAttr.value).trim();

// ── Resolve the plug-in object ────────────────────────────────────────────────

var allHosts = Server.findAllForType("PowerShell:PowerShellHost");
if (allHosts === null || allHosts === undefined || allHosts.length === 0) {
    throw new Error(
        "resolvePowerShellHostForAccount: no PowerShell host objects are registered in Orchestrator. Register " +
        "one per account via Library > PowerShell > Configuration > Add a PowerShell host."
    );
}

var matches        = [];
var availableHosts = [];
for (var h = 0; h < allHosts.length; h++) {
    availableHosts.push(allHosts[h].name);
    if (String(allHosts[h].name).toLowerCase() === wantHostName.toLowerCase()) {
        matches.push(allHosts[h]);
    }
}

if (matches.length === 0) {
    throw new Error(
        "resolvePowerShellHostForAccount: '" + accountElement.name + "' maps to PowerShell host '" +
        wantHostName + "', which is not registered. Registered hosts: " + availableHosts.join(", ") + "."
    );
}

// Two host objects with the same NAME cannot be told apart, and picking either would be a
// coin-flip between two identities. That is precisely the failure this action exists to
// prevent, so it is fatal rather than a warning.
if (matches.length > 1) {
    throw new Error(
        "resolvePowerShellHostForAccount: " + matches.length + " PowerShell host objects are named '" +
        wantHostName + "'. Orchestrator cannot distinguish them and this action will not guess which identity " +
        "to run as. Rename them so each name identifies its SERVICE ACCOUNT - 'pshost-subdom6', " +
        "'pshost-subdom8' - rather than the shared server FQDN."
    );
}

var psHost = matches[0];

var domainAttr = accountElement.getAttributeWithKey("domain");
var accountDomain = (domainAttr && domainAttr.value) ? String(domainAttr.value).trim() : "(not recorded)";

System.log(
    "resolvePowerShellHostForAccount | runAsAccount=" + accountElement.name +
    " | domain=" + accountDomain +
    " -> psHost='" + psHost.name + "'" +
    " | registered hosts=" + allHosts.length
);

// The identity is never read back from the plug-in object - vRO holds the stored credential
// and does not expose it. The NAME is the only handle, which is why the naming convention
// above is load-bearing rather than cosmetic.
System.log(
    "resolvePowerShellHostForAccount | NOTE: every AD call in the invoked script runs as this host's stored " +
    "account. An access-denied against a target domain is a RIGHTS problem for that account in that domain, " +
    "not a script problem - a trust authenticates the account but confers no rights. If instead the failure " +
    "is a connection or ADServerDownException, suspect Kerberos delegation (P-65) before anything else."
);

return psHost;
