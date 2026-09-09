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
 * Reads a property that may or may not exist on a plug-in object, without failing.
 * Different versions of the AD plug-in expose endpoint details under different names,
 * so several are tried and whichever are present get used.
 */
function readProperty(object, propertyName) {
    try {
        var value = object[propertyName];
        if (value === null || value === undefined) {
            return "";
        }
        return String(value);
    }
    catch (e) {
        return "";
    }
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
var adHosts = Server.findAllForType("AD:AdHost");

if (adHosts === null || adHosts.length === 0) {
    throw new Error(
        "findAdHostForDn: no Active Directory hosts are registered in Orchestrator. Add one per " +
        "domain using the 'Add an Active Directory server' workflow."
    );
}

var registeredNames = [];

for (var h = 0; h < adHosts.length; h++) {
    var adHost = adHosts[h];

    // Whichever of these the plug-in version happens to expose, one of them will
    // name the domain. Squash out spaces so "DC=connect, DC=lab" also matches.
    var description = [
        readProperty(adHost, "name"),
        readProperty(adHost, "hostName"),
        readProperty(adHost, "ldapHostName"),
        readProperty(adHost, "domainName"),
        readProperty(adHost, "rootDn"),
        readProperty(adHost, "ldapBase"),
        readProperty(adHost, "defaultRootDn")
    ].join(" ").toLowerCase().replace(/\s/g, "");

    registeredNames.push(adHost.name);

    if (description.indexOf(domainName) !== -1 || description.indexOf(domainPath) !== -1) {
        System.log("Using Active Directory endpoint: " + adHost.name);
        return adHost;
    }
}

throw new Error(
    "findAdHostForDn: none of the registered Active Directory hosts serve the domain '" + domainName +
    "'. Registered hosts are: " + registeredNames.join(", ") + ". Add an endpoint for that domain, " +
    "or run the probeAdPlugin action to see how each registered host identifies itself."
);
