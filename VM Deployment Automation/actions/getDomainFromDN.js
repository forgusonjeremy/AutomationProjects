/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Action:  getDomainFromDN
 * Module:  com.broadcom.pso.vcfa.customforms
 * Return:  string   — DNS domain (FQDN) built from the dc= components of a DN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OVERVIEW
 *   Derives the Active Directory DNS domain name from any distinguished name by
 *   extracting the dc= (domainComponent) RDNs and joining them with dots.
 *   Useful for feeding the domain name to a domain-join step / customization spec.
 *
 * INPUT
 *   ouDN  (string) - a distinguished name, e.g.
 *                    "OU=Jeremy-Project,OU=VCFA-Workloads,dc=vcf,dc=lab"
 *
 * OUTPUT
 *   string - "vcf.lab"
 *
 * EXAMPLES
 *   "OU=Servers,DC=corp,DC=example,DC=com" -> "corp.example.com"
 *   "dc=vcf,dc=lab"                         -> "vcf.lab"
 */

// ── Input validation ──────────────────────────────────────────────────────────
if (!ouDN || ("" + ouDN).trim() === "")
    throw new Error("getDomainFromDN: ouDN is required.");

// ── Extract the dc= components, in order, and join with dots ───────────────────
// Split on commas (escaped commas "\," are preserved as part of a value); dc=
// values are simple labels in practice, so a plain split is sufficient.
var parts = ("" + ouDN).split(",");
var labels = [];
for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (/^dc=/i.test(p)) {
        var value = p.substring(3).trim();   // strip the leading "dc="
        if (value !== "") labels.push(value);
    }
}

if (labels.length === 0)
    throw new Error("getDomainFromDN: no 'dc=' components found in DN: " + ouDN);

var domain = labels.join(".");
System.log("getDomainFromDN | " + ouDN + " -> " + domain);
return domain;
