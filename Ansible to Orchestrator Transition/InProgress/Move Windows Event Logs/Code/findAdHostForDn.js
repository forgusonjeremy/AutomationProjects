/* ===========================================================================
 * SHARED COMPONENT -- also used by: Remove Old Archived Logs
 *
 * This file is delivered inside this package so that the automation can be
 * installed on its own. It is NOT specific to it.
 *
 * If the other automation above is already installed in this Orchestrator,
 * the action it belongs to already exists. Create it ONCE and let both
 * workflows call it -- do not create a second copy under a different name.
 * A fix made to one copy does not reach the other, and the two drift apart
 * silently.
 *
 * Source of truth: _Shared/Code/ in the combined development repository.
 * See Documentation/06_Shared-Components.md.
 * =========================================================================== */

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
 * WHERE THE PROPERTIES ACTUALLY LIVE
 *
 * An AD:AdHost carries only three things of its own:
 *
 *     name               the configuration's name
 *     Url                the connection URL actually in use
 *     hostConfiguration  an AD_ServerConfiguration -- everything else
 *
 * The connection details are all on that nested object: ldapBase (labelled 'Root' on the
 * Add an Active Directory server workflow), defaultDomain, host, port, alternativeHosts,
 * useSSL and the rest. Reading them straight off the AdHost returns nothing, which looks
 * exactly like an endpoint that was registered without them.
 *
 * So every read below goes to hostConfiguration first and falls back to the AdHost, which
 * keeps this working if a plug-in version flattens the two.
 */

/** Reads one property off one object, lower-cased and trimmed, never throwing. */
function readFrom(object, propertyName) {
    try {
        if (object === null || object === undefined) {
            return "";
        }
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

/** The nested AD_ServerConfiguration, or null when this version does not have one. */
function configOf(endpoint) {
    try {
        var config = endpoint.hostConfiguration;
        return (config === null || config === undefined) ? null : config;
    }
    catch (e) {
        return null;
    }
}

/**
 * Reads a property from the endpoint's configuration, falling back to the endpoint.
 */
function readProperty(endpoint, propertyName) {
    var fromConfig = readFrom(configOf(endpoint), propertyName);
    return (fromConfig !== "") ? fromConfig : readFrom(endpoint, propertyName);
}

/**
 * Same, for a property holding a list (alternativeHosts). Always returns an array.
 */
function readList(endpoint, propertyName) {
    var out = [];
    var source = configOf(endpoint);
    var value = null;

    try {
        if (source !== null) {
            value = source[propertyName];
        }
        if (value === null || value === undefined) {
            value = endpoint[propertyName];
        }
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

/**
 * The endpoint's LDAP search base -- dc=vcf,dc=lab -- and which property it came from.
 *
 * This is hostConfiguration.ldapBase, shown as 'Root' on the Add an Active Directory
 * server workflow, so a correctly registered endpoint always has it. 'base' is read as
 * well for any version that names it that way.
 *
 * The property name is returned alongside the value so the log can say what actually
 * matched rather than guessing at it.
 */
function readSearchBase(endpoint) {
    var candidates = ["ldapBase", "base"];

    for (var i = 0; i < candidates.length; i++) {
        // "DC=vcf, DC=lab" and "DC=vcf,DC=lab" are the same base.
        var value = readProperty(endpoint, candidates[i]).replace(/\s/g, "");
        if (value !== "") {
            return { value: value, property: candidates[i] };
        }
    }

    return { value: "", property: "" };
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
// Matching is done in five passes, and the order matters in a multi-domain estate.
// Each is a weaker kind of evidence than the one before it, so the first to answer wins.
//
//   Pass 1 -- the properties that STATE the domain, compared exactly:
//               base           DC=connect,DC=lab   the endpoint's LDAP search base. This
//                                                  is the 'root' field on the Add an
//                                                  Active Directory server workflow, so a
//                                                  properly registered endpoint has it.
//                                                  ('ldapBase' on versions that use that
//                                                  name instead.)
//               defaultDomain  connect.lab         the domain it authenticates against
//             If either equals what was read off the distinguishedName, that is the
//             endpoint, with no room for argument.
//
//             Every comparison here is case-insensitive: readProperty lower-cases what it
//             reads and the domain is lower-cased when it comes off the name, so DC=VCF
//             and dc=vcf are the same thing. Spaces after the commas are ignored too.
//
//   Pass 2 -- the endpoint's name, when it IS the domain:
//               name           connect.lab
//             Whether an endpoint carries any of the properties above depends entirely on
//             the plug-in version and on how it was registered. A registration made by
//             the 'Add an Active Directory server' workflow can arrive with ldapBase,
//             defaultDomain and host all empty and a bare IP in its url -- and then the
//             name is the only thing on it that names a domain. It is operator-typed and
//             so it is not proof, but an exact match against the whole domain is a great
//             deal better than failing while an endpoint called 'connect.lab' sits in
//             the list.
//
//   Pass 3 -- the properties that merely IMPLY the domain:
//               host              dc01.connect.lab
//               url               ldap://dc01.connect.lab:389
//               alternativeHosts  dc02.connect.lab, ...
//             A server inside the domain is good evidence of the endpoint for it, but it
//             is weaker: a child domain's DC lives inside its parent's namespace too.
//             (A url holding an IP, as several do, matches nothing here and is skipped.)
//
//   Pass 4 -- a PARENT domain's endpoint with subDomainAutoConnect set, which the plug-in
//             will follow down into this domain.
//
//   Pass 5 -- the endpoint's name merely CONTAINING the domain, for labels written like
//             'AD - connect.lab' or 'connect.lab (production)'. Last because it is the
//             loosest thing here: it is a substring test on free text.

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

    var searchBase = readSearchBase(adHost);
    // A defaultDomain is sometimes stored fully qualified, with a trailing dot.
    var defaultDomain = readProperty(adHost, "defaultDomain").replace(/\.$/, "");

    if (searchBase.value === domainPath || defaultDomain === domainName) {
        System.log(
            "Using Active Directory endpoint: " + adHost.name +
            " (matched on " + (searchBase.value === domainPath ? searchBase.property : "defaultDomain") + ")"
        );
        return adHost;
    }
}

// -- Pass 2: the endpoint's name, when it IS the domain ---------------------
for (h = 0; h < adHosts.length; h++) {
    var named = adHosts[h];

    if (readProperty(named, "name") === domainName) {
        System.log("Using Active Directory endpoint: " + named.name + " (matched on name)");
        return named;
    }
}

// -- Pass 3: host / url / alternativeHosts, by DC name ----------------------
for (h = 0; h < adHosts.length; h++) {
    var candidate = adHosts[h];

    // The AdHost's own connection URL is documented as 'Url' with a capital U, while the
    // configuration underneath spells it 'url'. Take whichever this version answers to.
    var connectionUrl = readProperty(candidate, "url");
    if (connectionUrl === "") {
        connectionUrl = readProperty(candidate, "Url");
    }

    var serverNames = [readProperty(candidate, "host"), hostFromUrl(connectionUrl)];
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

// -- Pass 4: a parent endpoint that is allowed to follow its children --------
// subDomainAutoConnect is the plug-in's own switch for "this endpoint also serves the
// domains beneath it". Where it is set, corp.lab's endpoint is a legitimate answer for
// a DN in eu.corp.lab. It runs this late so that eu.corp.lab's OWN endpoint, if one is
// registered, is always preferred over reaching it through its parent.
for (h = 0; h < adHosts.length; h++) {
    var parentHost = adHosts[h];

    if (readProperty(parentHost, "subDomainAutoConnect") !== "true") {
        continue;
    }

    var parentBase = readSearchBase(parentHost).value;
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

// -- Pass 5: the endpoint's name merely containing the domain ---------------
// For labels written like 'AD - connect.lab'. Bounded so that 'connect.lab' is not found
// inside 'notconnect.lab' or 'connect.lab.uk'.
for (h = 0; h < adHosts.length; h++) {
    var labelled = adHosts[h];
    var label = readProperty(labelled, "name");
    var at = label.indexOf(domainName);

    if (at !== -1) {
        var before = (at === 0) ? "" : label.charAt(at - 1);
        var after = label.charAt(at + domainName.length);
        var boundedBefore = (before === "" || /[^a-z0-9.-]/.test(before));
        var boundedAfter = (after === "" || /[^a-z0-9.-]/.test(after));

        if (boundedBefore && boundedAfter) {
            System.warn(
                "Using Active Directory endpoint: " + labelled.name + " -- matched only because its " +
                "name mentions " + domainName + ". Nothing on it states the domain, so set its " +
                "ldapBase (DC=...) or defaultDomain to make this certain rather than a guess."
            );
            return labelled;
        }
    }
}

throw new Error(
    "findAdHostForDn: none of the registered Active Directory hosts serve the domain '" + domainName +
    "'. Registered hosts are: " + registeredNames.join(", ") + ". Add an endpoint for that domain, " +
    "or run the probeAdPlugin action to see how each registered host identifies itself. An endpoint " +
    "whose ldapBase and defaultDomain are both empty can only be matched by its name."
);
