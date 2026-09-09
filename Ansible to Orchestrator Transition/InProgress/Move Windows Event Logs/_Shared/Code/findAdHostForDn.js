/**
 * Action:  findAdHostForDn
 * Module:  com.broadcom.pso.windows.logs
 *
 * WHAT IT DOES
 *   Works out which Active Directory endpoint to talk to, from a distinguishedName --
 *   so nobody has to be asked "which domain?".
 *
 *   Every AD object carries its domain in its own name. This:
 *
 *       CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab
 *                                        ^^^^^^^^^^^^^^^^^
 *
 *   can only mean the connect.lab domain. So the DC= parts are read off the end of the
 *   name and matched against the AD hosts registered in Orchestrator. In a multi-domain
 *   estate this is the whole trick: the operator names one object and the right endpoint
 *   follows from it. There is no domain prompt, and no way for the two to disagree.
 *
 * INPUTS (in this order)
 *   distinguishedName  string   e.g. "CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab"
 *
 * RETURNS
 *   AD:AdHost -- the registered endpoint for that domain
 *
 * NOTE
 *   When an operator picks a group from the tree in the request form, Orchestrator already
 *   knows its endpoint and this action is not needed. It is used for scheduled and
 *   API-triggered runs, which pass the group as text because there is no one to click.
 */

/**
 * Reads a property off a plug-in object without failing if it is absent or throws.
 * Returns it lower-case and trimmed, which is the form every comparison below wants.
 */
function readProperty(object, propertyName) {
    try {
        var value = object[propertyName];
        if (value === null || value === undefined) {
            return "";
        }
        return String(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    }
    catch (e) {
        return "";
    }
}

/**
 * Same, for a property holding a list (alternativeHosts). Always returns an array.
 */
function readList(object, propertyName) {
    var out = [];
    try {
        var value = object[propertyName];
        if (value === null || value === undefined) {
            return out;
        }
        // The plug-in may hand back an array or a comma-separated string.
        var items = (typeof value !== "string" && typeof value.length === "number")
            ? value
            : String(value).split(",");
        for (var i = 0; i < items.length; i++) {
            var item = String(items[i]).replace(/^\s+|\s+$/g, "").toLowerCase();
            if (item !== "") {
                out.push(item);
            }
        }
    }
    catch (e) {
        return out;
    }
    return out;
}

/**
 * True when hostName is a domain controller FOR domain -- either the domain name
 * itself (round-robin DNS), or exactly one label inside it, which is what a DC's
 * FQDN always is: dc01.connect.lab serves connect.lab.
 *
 * The single-label rule is what keeps a child domain out of its parent's result.
 * dc01.connect.lab ends with '.lab', but it is a DC for connect.lab and not for
 * lab, and a plain suffix test could not tell those apart.
 */
function hostIsInDomain(hostName, domain) {
    if (hostName === "" || domain === "") {
        return false;
    }
    if (hostName === domain) {
        return true;
    }
    var suffix = "." + domain;
    if (hostName.length <= suffix.length ||
        hostName.substring(hostName.length - suffix.length) !== suffix) {
        return false;
    }
    var label = hostName.substring(0, hostName.length - suffix.length);
    return label.indexOf(".") === -1;
}

/**
 * Pulls the host out of an LDAP url -- ldap://dc01.connect.lab:389 -> dc01.connect.lab.
 */
function hostFromUrl(url) {
    if (url === "") {
        return "";
    }
    return url.replace(/^[a-z]+:\/\//, "").split("/")[0].split(":")[0];
}

// ---------------------------------------------------------------------------
// 1. Read the domain off the end of the distinguishedName
// ---------------------------------------------------------------------------
if (distinguishedName === null || distinguishedName === undefined || String(distinguishedName).indexOf("=") === -1) {
    throw new Error(
        "findAdHostForDn: '" + distinguishedName + "' is not a distinguishedName. It should look " +
        "like CN=Monitoring-Servers,OU=Servers,DC=connect,DC=lab"
    );
}

var parts = String(distinguishedName).split(",");
var domainParts = [];

for (var i = 0; i < parts.length; i++) {
    var part = parts[i].replace(/^\s+|\s+$/g, "");
    if (part.toUpperCase().indexOf("DC=") === 0) {
        domainParts.push(part.substring(3));
    }
}

if (domainParts.length === 0) {
    throw new Error(
        "findAdHostForDn: '" + distinguishedName + "' has no DC= parts, so there is no way to tell " +
        "which domain it belongs to."
    );
}

// DC=connect,DC=lab  ->  connect.lab   and   dc=connect,dc=lab
var domainName = domainParts.join(".").toLowerCase();
var domainPath = "dc=" + domainParts.join(",dc=").toLowerCase();

System.log("Looking for the Active Directory endpoint for domain: " + domainName);

// ---------------------------------------------------------------------------
// 2. Find the registered endpoint for that domain
// ---------------------------------------------------------------------------
// Matching is done in three passes, and the order matters in a multi-domain estate.
//
//   Pass 1 -- the properties that STATE the domain, compared exactly:
//               ldapBase       DC=connect,DC=lab   the search base the endpoint is bound to
//               defaultDomain  connect.lab         the domain it authenticates against
//             If either equals what was read off the distinguishedName, that is the
//             endpoint, with no room for argument.
//
//   Pass 2 -- only if pass 1 found nothing, the properties that merely IMPLY it:
//               host              dc01.connect.lab
//               url               ldap://dc01.connect.lab:389
//               alternativeHosts  dc02.connect.lab, ...
//             A server inside the domain is good evidence of the endpoint for it, but
//             it is weaker: a child domain's DC lives inside its parent's namespace
//             too. Running it second means an exact ldapBase/defaultDomain match on
//             any host always wins over a name-shaped guess at another.
//
//   Pass 3 -- last resort: a PARENT domain's endpoint with subDomainAutoConnect set,
//             which the plug-in will follow down into this domain. Only reached when
//             no endpoint names this domain and none of its own DCs are registered.
//
// The AD:AdHost 'name' is deliberately NOT matched on. It is a free-text label an
// operator typed when registering the endpoint; it is used for reporting only.

var adHosts = Server.findAllForType("AD:AdHost");

if (adHosts === null || adHosts.length === 0) {
    throw new Error(
        "findAdHostForDn: no Active Directory hosts are registered in Orchestrator. Add one per " +
        "domain using the 'Add an Active Directory server' workflow."
    );
}

var registeredNames = [];
var h;

// -- Pass 1: ldapBase / defaultDomain, exact --------------------------------
for (h = 0; h < adHosts.length; h++) {
    var adHost = adHosts[h];
    registeredNames.push(adHost.name);

    // "DC=connect, DC=lab" and "DC=connect,DC=lab" are the same base.
    var ldapBase = readProperty(adHost, "ldapBase").replace(/\s/g, "");
    // A defaultDomain is sometimes stored fully qualified, with a trailing dot.
    var defaultDomain = readProperty(adHost, "defaultDomain").replace(/\.$/, "");

    if (ldapBase === domainPath || defaultDomain === domainName) {
        System.log(
            "Using Active Directory endpoint: " + adHost.name +
            " (matched on " + (ldapBase === domainPath ? "ldapBase" : "defaultDomain") + ")"
        );
        return adHost;
    }
}

// -- Pass 2: host / url / alternativeHosts, by DC name ----------------------
for (h = 0; h < adHosts.length; h++) {
    var candidate = adHosts[h];

    var serverNames = [readProperty(candidate, "host"), hostFromUrl(readProperty(candidate, "url"))];
    var alternatives = readList(candidate, "alternativeHosts");
    for (var a = 0; a < alternatives.length; a++) {
        serverNames.push(hostFromUrl(alternatives[a]));
    }

    for (var s = 0; s < serverNames.length; s++) {
        if (hostIsInDomain(serverNames[s], domainName)) {
            System.log(
                "Using Active Directory endpoint: " + candidate.name +
                " (no ldapBase or defaultDomain names " + domainName + "; matched on server " +
                serverNames[s] + ", which is inside it)"
            );
            return candidate;
        }
    }
}

// -- Pass 3: a parent endpoint that is allowed to follow its children --------
// subDomainAutoConnect is the plug-in's own switch for "this endpoint also serves the
// domains beneath it". Where it is set, corp.lab's endpoint is a legitimate answer for
// a DN in eu.corp.lab. It is tried last so that eu.corp.lab's OWN endpoint, if one is
// registered, is always preferred over reaching it through its parent.
for (h = 0; h < adHosts.length; h++) {
    var parentHost = adHosts[h];

    if (readProperty(parentHost, "subDomainAutoConnect") !== "true") {
        continue;
    }

    var parentBase = readProperty(parentHost, "ldapBase").replace(/\s/g, "");
    var parentDomain = readProperty(parentHost, "defaultDomain").replace(/\.$/, "");

    // Turn the base back into a domain so both properties compare the same way:
    // dc=corp,dc=lab -> corp.lab
    if (parentDomain === "" && parentBase !== "") {
        parentDomain = parentBase.replace(/dc=/g, "").replace(/,/g, ".");
    }

    // domainIsBelow: eu.corp.lab is below corp.lab, at any depth.
    if (parentDomain !== "" && domainName.length > parentDomain.length &&
        domainName.substring(domainName.length - parentDomain.length - 1) === ("." + parentDomain)) {
        System.log(
            "Using Active Directory endpoint: " + parentHost.name +
            " (no endpoint is registered for " + domainName + " itself; reaching it through its " +
            "parent " + parentDomain + ", which has subDomainAutoConnect set)"
        );
        return parentHost;
    }
}

throw new Error(
    "findAdHostForDn: none of the registered Active Directory hosts serve the domain '" + domainName +
    "'. Registered hosts are: " + registeredNames.join(", ") + ". Add an endpoint for that domain, " +
    "or run the probeAdPlugin action to see how each registered host identifies itself."
);
