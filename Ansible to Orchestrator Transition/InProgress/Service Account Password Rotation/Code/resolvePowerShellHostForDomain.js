/**
 * Action: resolvePowerShellHostForDomain
 * Module:  com.broadcom.pso.vcf.identity.ad.accounts.passwordRotation
 *          (CANDIDATE FOR PROMOTION TO A SHARED MODULE - see note below)
 *
 * vRO input-parameter order (positional call from the workflow):
 *   (domainCategoryPath, domainName)
 *
 * Purpose:
 *   Resolves the PowerShell host object whose stored service account can
 *   authenticate to a given Active Directory domain, and returns it for binding to
 *   the OOTB 'Invoke a PowerShell script' workflow.
 *
 *   This is the fix for the single-identity assumption recorded in
 *   'Ansible-to-vRO-MappingTable.md' line 105 - "All workflows use a single psHost
 *   plugin object (intended)".
 *
 * ── Why this action exists ────────────────────────────────────────────────────
 *
 *   Nothing in cvs_functions.ps1 passes -Credential. Every Get-ADUser, every
 *   Get-ADGroupMember, every Invoke-Command runs as the AMBIENT identity of the
 *   PowerShell session. So the account the session runs as silently determines which
 *   domains the script can read and write.
 *
 *   In AAP that account was chosen PER JOB TEMPLATE, by which Machine credential was
 *   attached - against the same server pool. Different templates hitting the same
 *   Windows servers with accounts from different domains was not a quirk; it was the
 *   mechanism by which a template got the rights it needed in the domain it queried.
 *
 *   vRO moved that choice from the workflow to the PowerShell host object, and then
 *   bound one host object everywhere - which collapsed the variation with nowhere
 *   for it to go. The server pool is domain1-joined and the pool membership does not
 *   change; only the identity logging into it does. So the fix is not more servers,
 *   it is more HOST OBJECTS pointing at the same servers, each carrying a different
 *   domain's service account, selected at run time.
 *
 * ── Registering the host objects ──────────────────────────────────────────────
 *
 *   Library > PowerShell > Configuration > Add a PowerShell host, once per domain
 *   identity, all pointing at the SAME pool FQDN:
 *
 *     name:     pshost-dom1        <- the 'name' input, NOT the host FQDN
 *     host:     pool01.dom1.com
 *     port:     5986 / HTTPS / Kerberos / Shared Session
 *     username: svc-vro-dom1@DOM1.COM   (UPN form)
 *
 *     name:     pshost-dom2
 *     host:     pool01.dom1.com    <- same server
 *     username: svc-vro-dom2@DOM2.COM   (different domain's account)
 *
 *   NAME THEM FOR THE IDENTITY, NOT THE SERVER. The OOTB registration workflow takes
 *   'name' separately from 'host', and two host objects sharing one FQDN are
 *   indistinguishable in the Orchestrator inventory if both are named after the
 *   server. An operator picking the wrong one gets authentication failures against
 *   the target domain that look nothing like a naming problem.
 *
 *   Shared Session is required. Per-user session mode would authenticate as the vRO
 *   user, which defeats the entire mechanism.
 *
 * ── Why the mapping lives in a Configuration Element ──────────────────────────
 *
 *   Domain -> host object is deployment configuration, not logic: it differs between
 *   dev and production, and the customer's estates are on separate PowerShell hosts
 *   in both. Hardcoding it here would need a code change to move between them.
 *
 *   The mapping is normalised into its own per-domain element rather than repeated
 *   on every service account, because several accounts share a domain and a
 *   half-updated mapping is the kind of defect that authenticates successfully as
 *   the WRONG account.
 *
 *   Configuration Element schema:
 *
 *     Category:  <domainCategoryPath>       e.g. 'PSO/Identity/Domains'
 *     Element:   <domainName>               e.g. 'dom2.dom1.com'
 *
 *       psHostName    string   REQUIRED  name of the PowerShell:PowerShellHost object
 *       domainServer  string   optional  preferred DC, informational here
 *       description   string   optional  free text for operators
 *
 * ── PROMOTION NOTE ────────────────────────────────────────────────────────────
 *
 *   This action is not specific to password rotation. Server Reboots, Clean Disks,
 *   Move Windows Event Logs and Reboot Report ByCN all bind a single pre-bound psHost
 *   attribute and all carry the same defect. When those are re-bound, this action
 *   should move to a shared module and be referenced by all of them rather than
 *   copied - the domain map must have exactly one definition.
 *
 * Inputs:
 *   domainCategoryPath (string) - Configuration Element category holding domain elements
 *   domainName         (string) - AD domain to authenticate to, e.g. 'dom2.dom1.com'
 *
 * Returns: PowerShell:PowerShellHost - bind to the OOTB invoke workflow's host input
 */

// ── Input validation ──────────────────────────────────────────────────────────

if (!domainCategoryPath || String(domainCategoryPath).trim() === "") {
    throw new Error("resolvePowerShellHostForDomain: domainCategoryPath is required, e.g. 'PSO/Identity/Domains'.");
}
if (!domainName || String(domainName).trim() === "") {
    throw new Error(
        "resolvePowerShellHostForDomain: domainName is required. It is the AD domain the script must " +
        "AUTHENTICATE TO, which is not always the domain of the servers being acted on - the server pool is " +
        "domain1-joined regardless of which domain's directory is being queried."
    );
}

var wantCategory = String(domainCategoryPath).trim().replace(/^\/+|\/+$/g, "");
var wantDomain   = String(domainName).trim();

// ── Look up the domain's mapping element ──────────────────────────────────────

var category = Server.getConfigurationElementCategoryWithPath(wantCategory);
if (category === null || category === undefined) {
    throw new Error(
        "resolvePowerShellHostForDomain: no Configuration Element category at '" + wantCategory + "'. " +
        "Create one element per AD domain, each naming the PowerShell host object whose service account can " +
        "authenticate to that domain."
    );
}

var domainElement = null;
var knownDomains = [];
var elements = category.configurationElements || [];
for (var i = 0; i < elements.length; i++) {
    knownDomains.push(elements[i].name);
    // AD domain names are case-insensitive.
    if (String(elements[i].name).toLowerCase() === wantDomain.toLowerCase()) {
        domainElement = elements[i];
    }
}

if (domainElement === null) {
    throw new Error(
        "resolvePowerShellHostForDomain: domain '" + wantDomain + "' has no Configuration Element in '" +
        wantCategory + "'. Mapped domains: " + (knownDomains.length > 0 ? knownDomains.join(", ") : "(none)") +
        ". An unmapped domain is a deliberate hard failure: falling back to a default host would run the " +
        "request as whatever identity that host holds, which either fails against the target domain or - " +
        "worse - succeeds against the wrong one."
    );
}

var hostNameAttr = domainElement.getAttributeWithKey("psHostName");
if (hostNameAttr === null || hostNameAttr === undefined ||
    hostNameAttr.value === null || hostNameAttr.value === undefined ||
    String(hostNameAttr.value).trim() === "") {
    throw new Error(
        "resolvePowerShellHostForDomain: Configuration Element '" + domainElement.name + "' has no " +
        "'psHostName' value. It must name the PowerShell host object (the 'name' given when the host was " +
        "registered), not the server FQDN - several host objects share one FQDN by design."
    );
}

var wantHostName = String(hostNameAttr.value).trim();

// ── Resolve the plugin object ─────────────────────────────────────────────────

var allHosts = Server.findAllForType("PowerShell:PowerShellHost");
if (allHosts === null || allHosts === undefined || allHosts.length === 0) {
    throw new Error(
        "resolvePowerShellHostForDomain: no PowerShell host objects are registered in Orchestrator. Register " +
        "one per domain identity via Library > PowerShell > Configuration > Add a PowerShell host."
    );
}

var matches = [];
var availableHosts = [];
for (var h = 0; h < allHosts.length; h++) {
    availableHosts.push(allHosts[h].name);
    if (String(allHosts[h].name).toLowerCase() === wantHostName.toLowerCase()) {
        matches.push(allHosts[h]);
    }
}

if (matches.length === 0) {
    throw new Error(
        "resolvePowerShellHostForDomain: domain '" + domainElement.name + "' maps to PowerShell host '" +
        wantHostName + "', which is not registered. Registered hosts: " + availableHosts.join(", ") + "."
    );
}

// Two host objects with the same NAME cannot be told apart, and picking either one
// would be a coin-flip between two identities. That is precisely the failure this
// action exists to prevent, so it is fatal rather than a warning.
if (matches.length > 1) {
    throw new Error(
        "resolvePowerShellHostForDomain: " + matches.length + " PowerShell host objects are named '" +
        wantHostName + "'. Orchestrator cannot distinguish them and this action will not guess which " +
        "identity to run as. Rename them so each name identifies its SERVICE ACCOUNT - e.g. 'pshost-dom1' " +
        "and 'pshost-dom2' - rather than the shared server FQDN."
    );
}

var psHost = matches[0];

System.log(
    "resolvePowerShellHostForDomain | domain=" + domainElement.name +
    " -> psHost='" + psHost.name + "'" +
    " | registered hosts=" + allHosts.length
);

// The identity itself is never read back from the plugin object - vRO holds the
// stored credential and does not expose the password. The name is the only handle,
// which is why the naming convention above is load-bearing rather than cosmetic.
System.log(
    "resolvePowerShellHostForDomain | NOTE: every AD call in cvs_functions.ps1 runs as this host's stored " +
    "service account. If the run fails with access-denied against '" + domainElement.name + "', check that " +
    "account's rights IN THAT DOMAIN before suspecting the script - a trust authenticates the account but " +
    "confers no rights."
);

return psHost;
