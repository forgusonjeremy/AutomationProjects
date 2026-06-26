/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Action:  getProjectADChildOUs
 * Module:  com.broadcom.pso.vcfa.customforms
 * Return:  Array/string   — child OU distinguishedNames, for a custom-form dropdown
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OVERVIEW
 *   Value-source action for a VCF Automation catalog-item custom form. It:
 *     1. Reads the VCF Automation refresh token from a vRO Configuration Element.
 *     2. Exchanges it for a bearer access token (IaaS login) via a TRANSIENT REST host.
 *     3. Reads the project's Active Directory integration to derive the base OU
 *        (relative DN combined with the integration Base DN).
 *     4. Enumerates the child OUs beneath that base OU using the vRO Active
 *        Directory plugin (NOT a REST call).
 *     5. Returns the child OU distinguishedNames as a sorted string array.
 *
 * WHEN TO USE
 *   Bind as the "External source / action" for an OU-picker field on the form.
 *
 * PREREQUISITES
 *   - REST plugin (transient host — no pre-registered endpoint required).
 *   - Active Directory plugin installed AND an AD server added to vRO
 *     (run the OOTB "Add an Active Directory server" workflow first).
 *     The base OU must be reachable within that configured AD host's domain.
 *   - A Configuration Element holding the refresh token as a (SecureString) attribute.
 *   - Network/auth: the vRO appliance must reach the VCF Automation base URL.
 *
 * INPUTS
 *   vcfaBaseUrl            string  VCF Automation base URL, e.g. https://vcfa.corp.local
 *                                  (bound from a form input field)
 *   configElementName      string  Name of the Config Element holding the refresh token
 *                                  (bound from a form input field)
 *   configElementAttribute string  Attribute KEY within that Config Element that holds the token
 *                                  (bound from a form input field)
 *   projectId              string  Project id (or name) whose AD relativeDN defines the base OU
 *                                  (bound from the form's project field)
 *   apiVersion             string  IaaS API version date, e.g. "2021-07-15". Optional;
 *                                  defaults below. Confirm a supported value for your build.
 *
 * OUTPUT
 *   Array/string — child OU distinguishedNames (sorted). Empty array if none.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * REST DETAILS (validated against Broadcom/VMware docs)
 *   [1] Login (token exchange)
 *       POST  {base}/iaas/api/login
 *       Headers: Content-Type: application/json, Accept: application/json
 *       Body:   { "refreshToken": "<token>" }
 *       200 ->  { "token": "<bearer>" }
 *   [2] Integrations
 *       GET   {base}/iaas/api/integrations?apiVersion=<ver>
 *       Headers: Authorization: Bearer <bearer>, Accept: application/json
 *       200 ->  { "content": [ <integration>, ... ] }
 *
 *   ⚠ VERIFY-IN-SWAGGER: The exact field names that hold the AD integration's
 *     Base DN and each project's relative DN are NOT published in vendor docs
 *     (only the UI labels "Base DN" / "relative DN" are documented). This action
 *     parses defensively across plausible names AND logs the raw integration
 *     JSON. Open your instance's API Explorer (Swagger) for GET
 *     /iaas/api/integrations, confirm the real paths, then tighten the
 *     extractBaseDN()/extractProjectRelativeDN() helpers below.
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── Defaults / tunables ──────────────────────────────────────────────────────
var DEFAULT_API_VERSION = "2021-07-15";   // confirm a supported apiVersion for your build
var HTTP_OK_MIN = 200, HTTP_OK_MAX = 299;

// ── Input validation ─────────────────────────────────────────────────────────
if (!vcfaBaseUrl || vcfaBaseUrl.trim() === "")
    throw new Error("getProjectADChildOUs: vcfaBaseUrl is required.");
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
    for each (var ce in elements) {
        if (ce.name === ceName) { matches.push(ce); }
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

// ── Helper: IaaS login (refresh token -> bearer) ─────────────────────────────
function login(host, refreshToken) {
    var request = host.createRequest("POST", "/iaas/api/login",
        JSON.stringify({ refreshToken: refreshToken }));
    request.setHeader("Content-Type", "application/json");
    request.setHeader("Accept", "application/json");
    var body = execChecked(request, "IaaS login");
    var token = JSON.parse(body).token;
    if (!token) throw new Error("IaaS login returned no 'token'.");
    return token;
}

// ── Helper: list integrations ────────────────────────────────────────────────
function getIntegrations(host, bearer) {
    var request = host.createRequest("GET",
        "/iaas/api/integrations?apiVersion=" + encodeURIComponent(apiVer), null);
    request.setHeader("Authorization", "Bearer " + bearer);
    request.setHeader("Accept", "application/json");
    var body = execChecked(request, "GET integrations");
    var payload = JSON.parse(body);
    return payload.content || payload.documents || payload || [];
}

// ── Helper: pick the AD integration (defensive type/name match) ───────────────
function isAdIntegration(integ) {
    var hay = (JSON.stringify(integ) || "").toLowerCase();
    var t = ("" + (integ.integrationType || integ.endpointType ||
                   integ.type || integ.name || "")).toLowerCase();
    return t.indexOf("activedirectory") >= 0 || t.indexOf("active directory") >= 0 ||
           t === "ad" || hay.indexOf("\"relativedn\"") >= 0;
}

// ⚠ VERIFY-IN-SWAGGER — adjust once you confirm field names.
function extractBaseDN(integ) {
    var p = integ.integrationProperties || integ.properties || integ.customProperties || integ;
    return p.baseDN || p.baseDn || p.base_dn || integ.baseDN || null;
}

// ⚠ VERIFY-IN-SWAGGER — adjust once you confirm field names.
function extractProjectRelativeDN(integ, wantedProjectId) {
    // Project associations may live under .projects / .projectAssociations /
    // .integrationProperties.projects — try the plausible shapes.
    var groups = [].concat(
        integ.projects || [],
        integ.projectAssociations || [],
        (integ.integrationProperties ? (integ.integrationProperties.projects || []) : []),
        (integ.properties ? (integ.properties.projects || []) : [])
    );
    var want = ("" + wantedProjectId).toLowerCase();
    for each (var g in groups) {
        var pid = ("" + (g.projectId || g.project || g.id || "")).toLowerCase();
        var pname = ("" + (g.projectName || g.name || "")).toLowerCase();
        if (pid === want || pname === want) {
            return g.relativeDN || g.relativeDn || g.relative_dn || null;
        }
    }
    return null;
}

// ── Helper: compose full base OU DN from relativeDN + baseDN ──────────────────
function composeBaseOuDN(relativeDN, baseDN) {
    if (!relativeDN) return baseDN;            // project pinned at the integration root
    var rel = relativeDN.trim().replace(/,+$/, "");
    var base = (baseDN || "").trim();
    if (base === "") return rel;
    if (rel.toLowerCase().indexOf(base.toLowerCase()) >= 0) return rel; // already absolute
    return rel + "," + base;
}

// ── Helper: enumerate child OUs via the AD plugin ────────────────────────────
function getChildOUs(baseOuDN) {
    // Resolve the base OU object by its RDN, then match the full DN exactly.
    var rdnValue = baseOuDN.split(",")[0].replace(/^\s*OU=/i, "").trim();
    var candidates = ActiveDirectory.search("OrganizationalUnit", rdnValue) || [];

    var baseOu = null;
    for each (var ou in candidates) {
        if (ou.distinguishedName &&
            ou.distinguishedName.toLowerCase() === baseOuDN.toLowerCase()) {
            baseOu = ou;
            break;
        }
    }
    if (!baseOu)
        throw new Error("Base OU not found in AD via plugin (check the configured AD host/domain): "
            + baseOuDN);

    var children = baseOu.organizationalUnits || [];
    var result = [];
    for each (var c in children) {
        if (c.distinguishedName) result.push(c.distinguishedName);
    }
    result.sort();
    return result;
}

// ═══ Main ════════════════════════════════════════════════════════════════════
try {
    System.log("getProjectADChildOUs | base=" + baseUrl + " | project=" + projectId +
               " | configElement=" + configElementName + " | apiVersion=" + apiVer);

    var refreshToken = getRefreshToken(configElementName.trim(), configElementAttribute.trim());
    var host    = createTransientHost(baseUrl);
    var bearer  = login(host, refreshToken);

    var integrations = getIntegrations(host, bearer);
    var adInteg = null;
    for each (var i in integrations) {
        if (isAdIntegration(i)) { adInteg = i; break; }
    }
    if (!adInteg)
        throw new Error("No Active Directory integration found in /iaas/api/integrations.");

    // Logged so you can confirm the real field names in your environment (see VERIFY-IN-SWAGGER).
    System.log("getProjectADChildOUs | RAW AD integration JSON: " + JSON.stringify(adInteg));

    var baseDN      = extractBaseDN(adInteg);
    var relativeDN  = extractProjectRelativeDN(adInteg, projectId.trim());
    if (!baseDN && !relativeDN)
        throw new Error("Could not derive Base DN / relative DN from the AD integration. " +
            "Inspect the RAW AD integration JSON logged above and update extractBaseDN()/" +
            "extractProjectRelativeDN() to match your API schema.");

    var baseOuDN = composeBaseOuDN(relativeDN, baseDN);
    System.log("getProjectADChildOUs | base OU resolved to: " + baseOuDN);

    var childOUs = getChildOUs(baseOuDN);
    System.log("getProjectADChildOUs | returning " + childOUs.length + " child OU(s).");
    return childOUs;

} catch (e) {
    System.error("getProjectADChildOUs | " + e);
    throw e;   // surface to the form so the field shows an error rather than silent empty
}
