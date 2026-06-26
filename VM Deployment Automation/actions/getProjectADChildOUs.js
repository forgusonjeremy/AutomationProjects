/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Action:  getProjectADChildOUs
 * Module:  com.broadcom.pso.vcfa.customforms
 * Return:  Array/string   — child OU RELATIVE DNs, for a custom-form dropdown
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OVERVIEW
 *   Value-source action for a VCF Automation catalog-item custom form. Using only
 *   officially supported APIs, it:
 *     1. Reads the VCF Automation refresh token from a vRO Configuration Element.
 *     2. Exchanges it for a bearer access token (VCFA 9 tenant OAuth) via a
 *        TRANSIENT REST host.
 *     3. Reads the AD integration's Base DN (GET /iaas/api/integrations).
 *     4. Reads the project's OU from an admin-set project CUSTOM PROPERTY
 *        (GET /iaas/api/projects/{id}); combines it with the Base DN if relative.
 *     5. Enumerates the OUs directly beneath the project OU via the vRO Active
 *        Directory plugin (scopes the requester's choices to the project subtree).
 *     6. Returns those child OUs as FULL DNs. The selected OU is consumed by a vRO
 *        workflow (Compute Allocation) that pre-creates the computer account; the OS
 *        domain join is handled by a vCenter customization spec. Fails closed if the
 *        project OU is unresolved — never lists the whole domain.
 *
 * WHY A CUSTOM PROPERTY
 *   The per-project AD OU shown on the project's Integrations tab is NOT exposed by
 *   any documented/supported API (confirmed against live payloads: absent from
 *   /iaas/api/projects/{id}, /iaas/api/integrations/{id}, and /policy/api/policies).
 *   The supported, stable approach is for the infrastructure admin to set the OU as
 *   a project custom property; the integration Base DN stays single-source on the
 *   integration and is appended here.
 *
 * ADMIN SETUP (per project, one-time)
 *   On the project, add custom property:
 *     Key:   ad.baseOU   (see AD_OU_PROJECT_PROPERTY below)
 *     Value: the project's OU RELATIVE to the integration Base DN
 *            e.g. "OU=Jeremy-Project,OU=VCFA-Workloads"
 *            (a full DN ending in the Base DN is also accepted)
 *
 * PREREQUISITES
 *   - REST plugin (transient host — no pre-registered endpoint required).
 *   - Active Directory plugin installed AND an AD server added to vRO
 *     (run the OOTB "Add an Active Directory server" workflow first). The host is
 *     targeted explicitly via Server.findAllForType("AD:AdHost"), so it does NOT
 *     need to be the plugin default. The project OU must exist in that host's domain.
 *   - A Configuration Element holding the refresh token as a (SecureString) attribute.
 *   - An Active Directory integration configured (provides the Base DN).
 *   - Network/auth: the vRO appliance must reach the VCF Automation base URL.
 *
 * INPUTS
 *   vcfaBaseUrl            string  VCF Automation base URL, e.g. https://vcfa.site-a.vcf.lab
 *   orgName                string  VCF Automation 9 VM Apps org name (token URL path)
 *   configElementName      string  Name of the Config Element holding the refresh token
 *   configElementAttribute string  Attribute KEY within that Config Element
 *   projectId              string  Project id whose AD OU scopes the picker
 *   apiVersion             string  IaaS API version date, e.g. "2021-07-15" (optional)
 *
 * OUTPUT
 *   Array/string — FULL DNs of the OUs directly beneath the project's configured AD OU,
 *   sorted. The selected value is passed to the create-computer workflow (AD plugin) to
 *   pre-stage the computer account in that OU. Empty if the project OU has no child OUs.
 *   THROWS if the project OU cannot be resolved (never lists the whole domain).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * REST DETAILS (all officially supported)
 *   [1] Token exchange — VCF Automation 9 (VM Apps org, tenant OAuth2)
 *       POST  {base}/oauth/tenant/<orgName>/token
 *       Headers: Content-Type: application/x-www-form-urlencoded, Accept: application/json
 *       Body:   grant_type=refresh_token&refresh_token=<token>   (form-urlencoded, NOT JSON)
 *       200 ->  { "access_token": "<bearer>", "refresh_token": "<new>", "token_type": "Bearer" }
 *       NOTE: Use a token with "Require Rotation" DISABLED (single-use tokens break a
 *             stateless form value-source).
 *   [2] Integrations (AD Base DN)
 *       GET   {base}/iaas/api/integrations?apiVersion=<ver>
 *       Headers: Authorization: Bearer <bearer>, Accept: application/json
 *       200 ->  { "content": [ <integration>, ... ] }; AD = integrationType "activedirectory",
 *               Base DN = integrationProperties.defaultOU (e.g. "dc=vcf,dc=lab")
 *   [3] Project (custom property holding the OU)
 *       GET   {base}/iaas/api/projects/<projectId>?apiVersion=<ver>
 *       Headers: Authorization: Bearer <bearer>, Accept: application/json
 *       200 ->  { ..., "customProperties": { "ad.baseOU": "OU=...,OU=..." } }
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── Defaults / tunables ──────────────────────────────────────────────────────
var DEFAULT_API_VERSION = "2021-07-15";   // confirm a supported apiVersion for your build
var HTTP_OK_MIN = 200, HTTP_OK_MAX = 299;
// Project custom-property key the infra admin sets to the project's OU.
// Value is RELATIVE to the AD integration Base DN ("OU=...,OU=...") or a full DN.
var AD_OU_PROJECT_PROPERTY = "ad.baseOU";

// ── Input validation ─────────────────────────────────────────────────────────
if (!vcfaBaseUrl || vcfaBaseUrl.trim() === "")
    throw new Error("getProjectADChildOUs: vcfaBaseUrl is required.");
if (!orgName || orgName.trim() === "")
    throw new Error("getProjectADChildOUs: orgName is required.");
if (!configElementName || configElementName.trim() === "")
    throw new Error("getProjectADChildOUs: configElementName is required.");
if (!configElementAttribute || configElementAttribute.trim() === "")
    throw new Error("getProjectADChildOUs: configElementAttribute is required.");
if (!projectId || projectId.trim() === "")
    throw new Error("getProjectADChildOUs: projectId is required.");

var baseUrl   = vcfaBaseUrl.trim().replace(/\/+$/, "");   // strip trailing slash
var apiVer    = (typeof apiVersion === "string" && apiVersion.trim() !== "")
                  ? apiVersion.trim() : DEFAULT_API_VERSION;

// ── Helper: read refresh token from a Configuration Element ───────────────────
function getRefreshToken(ceName, attrKey) {
    var elements = Server.findAllForType("ConfigurationElement") || [];
    var matches = [];
    for (var ei = 0; ei < elements.length; ei++) {
        if (elements[ei].name === ceName) { matches.push(elements[ei]); }
    }
    if (matches.length === 0)
        throw new Error("Configuration Element '" + ceName + "' not found.");
    if (matches.length > 1)
        System.warn("getProjectADChildOUs: " + matches.length +
            " Config Elements named '" + ceName + "' found; using the first match.");

    var attr = matches[0].getAttributeWithKey(attrKey);
    if (!attr || attr.value === null || attr.value === undefined)
        throw new Error("Attribute '" + attrKey + "' not found on Config Element '" + ceName + "'.");

    var token = "" + attr.value;               // SecureString resolves to plaintext at runtime
    if (token.trim() === "")
        throw new Error("Attribute '" + attrKey + "' on '" + ceName + "' is empty.");
    return token;
}

// ── Helper: transient REST host ──────────────────────────────────────────────
function createTransientHost(url) {
    var restHost = RESTHostManager.createHost("dynamicRequest");
    var transientHost = RESTHostManager.createTransientHostFrom(restHost);
    transientHost.url = url;
    return transientHost;
}

// ── Helper: execute + status guard ───────────────────────────────────────────
function execChecked(request, label) {
    var response = request.execute();
    var code = response.statusCode;
    if (code < HTTP_OK_MIN || code > HTTP_OK_MAX) {
        throw new Error(label + " failed. HTTP " + code + " - " + response.contentAsString);
    }
    return response.contentAsString;
}

// ── Helper: VCF Automation 9 token exchange (refresh token -> bearer) ─────────
function login(host, org, refreshToken) {
    var path = "/oauth/tenant/" + encodeURIComponent(org) + "/token";
    var formBody = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshToken);
    var request = host.createRequest("POST", path, formBody);
    request.setHeader("Content-Type", "application/x-www-form-urlencoded");
    request.setHeader("Accept", "application/json");
    var body = execChecked(request, "VCFA token exchange");
    var token = JSON.parse(body).access_token;
    if (!token) throw new Error("Token exchange returned no 'access_token'.");
    return token;
}

// ── Helper: list integrations (for the AD Base DN) ───────────────────────────
function getIntegrations(host, bearer) {
    var request = host.createRequest("GET",
        "/iaas/api/integrations?apiVersion=" + encodeURIComponent(apiVer), null);
    request.setHeader("Authorization", "Bearer " + bearer);
    request.setHeader("Accept", "application/json");
    var body = execChecked(request, "GET integrations");
    var payload = JSON.parse(body);
    return payload.content || payload.documents || payload || [];
}

function isAdIntegration(integ) {
    var t = ("" + (integ.integrationType || integ.endpointType ||
                   integ.type || integ.name || "")).toLowerCase();
    return t.indexOf("activedirectory") >= 0 || t.indexOf("active directory") >= 0 || t === "ad";
}

// VCF Automation 9: the integration Base DN is integrationProperties.defaultOU.
function extractBaseDN(integ) {
    var p = integ.integrationProperties || {};
    var c = integ.customProperties || {};
    return p.defaultOU || c.defaultOU ||
           p.baseDN || p.baseDn || p.base_dn || c.baseDN || integ.baseDN || null;
}

// ── Helper: get the project (its custom property holds the OU) ────────────────
function getProject(host, bearer, projectId) {
    var request = host.createRequest("GET",
        "/iaas/api/projects/" + encodeURIComponent(projectId) +
        "?apiVersion=" + encodeURIComponent(apiVer), null);
    request.setHeader("Authorization", "Bearer " + bearer);
    request.setHeader("Accept", "application/json");
    var body = execChecked(request, "GET project");
    return JSON.parse(body);
}

// ── Helper: normalize a DN for comparison (strip spaces, lowercase) ───────────
function normDN(dn) { return ("" + dn).replace(/\s+/g, "").toLowerCase(); }

// ── Helper: classify an OU DN: "full" (ends at dc=), "relative" (OU chain), or null ─
function ouKind(s) {
    s = "" + s;
    if (/ou=[^,]+,(?:ou=[^,]+,)*dc=/i.test(s)) return "full";               // OU chain ending at dc=
    if (/^\s*ou=[^,]+(?:\s*,\s*ou=[^,]+)*\s*$/i.test(s)) return "relative";  // OU chain only
    return null;
}

// ── Helper: combine a relative OU DN with the Base DN -> full DN ──────────────
function combineDN(relative, base) {
    var rel = ("" + relative).trim().replace(/,+$/, "");
    var b = ("" + (base || "")).trim();
    if (b === "" || normDN(rel).indexOf(normDN(b)) >= 0) return rel;   // already absolute
    return rel + "," + b;
}

// ── Helper: get a configured AD host (passed explicitly -> no "default" needed) ─
function getAdHost() {
    var hosts = Server.findAllForType("AD:AdHost") || [];
    if (hosts.length === 0) hosts = Server.findAllForType("AD:Adhost") || [];  // case fallback
    if (hosts.length === 0)
        throw new Error("No Active Directory host found via the vRO AD plugin. Add one with the " +
            "OOTB 'Add an Active Directory server' workflow.");
    if (hosts.length > 1)
        System.warn("getProjectADChildOUs: " + hosts.length + " AD hosts configured; using the first ('" +
            (hosts[0].name || hosts[0]) + "'). Add domain matching if you target multiple domains.");
    return hosts[0];
}

// ── Helper: enumerate DIRECT child OUs of a base DN via the AD plugin ─────────
// (a) base is an OU -> resolve the OU object, read .organizationalUnits
// (b) base is the domain root -> list OUs, keep direct children by DN
// All searches pass the AD host explicitly: ActiveDirectory.search(type, query, adHost).
function getChildOUs(baseDN, adHost) {
    var result = [];

    if (/^\s*ou=/i.test(baseDN)) {
        var rdn = baseDN.split(",")[0].replace(/^\s*ou=/i, "").trim();
        var matches = ActiveDirectory.search("OrganizationalUnit", rdn, adHost) || [];
        for (var mi = 0; mi < matches.length; mi++) {
            var m = matches[mi];
            if (m.distinguishedName && normDN(m.distinguishedName) === normDN(baseDN)) {
                var kids = m.organizationalUnits || [];
                for (var ki = 0; ki < kids.length; ki++) {
                    if (kids[ki].distinguishedName) result.push(kids[ki].distinguishedName);
                }
                result.sort();
                return result;
            }
        }
        // fall through to (b) if the exact OU object could not be resolved
    }

    var suffix = "," + normDN(baseDN);
    var all = ActiveDirectory.search("OrganizationalUnit", "", adHost) || [];  // empty query => all OUs
    if (all.length === 0)
        System.warn("getProjectADChildOUs: AD plugin returned no OUs. Verify the AD host is " +
            "reachable and that an empty-query OU search returns objects in your plugin version.");
    for (var oi = 0; oi < all.length; oi++) {
        var dn = all[oi].distinguishedName;
        if (!dn) continue;
        var dnl = normDN(dn);
        if (dnl.length > suffix.length && dnl.substring(dnl.length - suffix.length) === suffix) {
            var prefix = dnl.substring(0, dnl.length - suffix.length);  // part before ",base"
            if (prefix.indexOf(",") === -1 && prefix.indexOf("ou=") === 0) result.push(dn);
        }
    }
    result.sort();
    return result;
}

// ═══ Main ════════════════════════════════════════════════════════════════════
try {
    System.log("getProjectADChildOUs | base=" + baseUrl + " | org=" + orgName +
               " | project=" + projectId + " | configElement=" + configElementName +
               " | apiVersion=" + apiVer);

    var refreshToken = getRefreshToken(configElementName.trim(), configElementAttribute.trim());
    var host    = createTransientHost(baseUrl);
    var bearer  = login(host, orgName.trim(), refreshToken);

    // Project OU from the admin-set custom property (supported, single source of truth).
    // Prefer a FULL DN; a relative DN is also accepted and combined with the AD
    // integration Base DN (looked up only when needed).
    var project = getProject(host, bearer, projectId.trim());
    var cp = project.customProperties || {};
    var ouValue = cp[AD_OU_PROJECT_PROPERTY];
    var kind = ouValue ? ouKind("" + ouValue) : null;
    if (!kind)
        throw new Error("Project custom property '" + AD_OU_PROJECT_PROPERTY + "' is not set to a " +
            "valid OU DN. Set it on the project to the project's OU as a full DN (e.g. " +
            "'OU=Jeremy-Project,OU=VCFA-Workloads,dc=vcf,dc=lab') or a relative DN. " +
            "(Refusing to list the whole domain.)");

    var projectOuDN;
    if (kind === "full") {
        projectOuDN = "" + ouValue;
    } else {
        // Relative DN -> append the AD integration Base DN (supported lookup, only when needed).
        var integrations = getIntegrations(host, bearer);
        var adInteg = null;
        for (var ii = 0; ii < integrations.length; ii++) {
            if (isAdIntegration(integrations[ii])) { adInteg = integrations[ii]; break; }
        }
        var integBaseDN = adInteg ? extractBaseDN(adInteg) : null;
        if (!integBaseDN)
            throw new Error("Custom property '" + AD_OU_PROJECT_PROPERTY + "' is a relative DN but no " +
                "AD integration Base DN was found. Set a FULL DN on the custom property instead.");
        projectOuDN = combineDN("" + ouValue, integBaseDN);
    }
    System.log("getProjectADChildOUs | project OU (" + kind + "): " + projectOuDN);

    // Enumerate ONLY the OUs beneath the project OU (scopes the requester's choices).
    var adHost   = getAdHost();
    var childOUs = getChildOUs(projectOuDN, adHost);   // FULL DNs (consumed by the create-computer workflow)
    childOUs.sort();
    System.log("getProjectADChildOUs | returning " + childOUs.length + " OU DN(s).");
    return childOUs;

} catch (e) {
    System.error("getProjectADChildOUs | " + e);
    throw e;   // surface to the form so the field shows an error rather than silent empty
}
