/**
 * Action: getBearerToken
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Authenticates against VCF Automation (VCFA) and returns a bearer token
 *   string for use in subsequent API calls. Creates and destroys its own
 *   transient REST host within a single script block.
 *
 * Prerequisites:
 *   - HTTP-REST plugin configured in Orchestrator
 *   - VCFA FQDN reachable from Orchestrator
 *
 * Inputs:
 *   vcfaFqdn {string} - VCFA appliance FQDN (e.g. vcfa.example.com)
 *   username {string} - VCFA username
 *   password {string} - VCFA password (SecureString input at workflow level)
 *
 * Output:
 *   {string} Bearer token string (without "Bearer " prefix)
 *
 * Notes:
 *   - Transient host is created and destroyed within this action.
 *   - Token is NOT cached. Caller is responsible for token reuse across
 *     multiple actions within the same workflow execution if needed.
 */

var transientHost = null;

try {
    if (!vcfaFqdn) throw new Error("Input 'vcfaFqdn' is required.");
    if (!username)  throw new Error("Input 'username' is required.");
    if (!password)  throw new Error("Input 'password' is required.");

    System.log("getBearerToken: Authenticating to VCFA at " + vcfaFqdn);

    // Create transient REST host
    var restHost      = RESTHostManager.createHost("vcfa-token-" + vcfaFqdn);
    transientHost     = RESTHostManager.createTransientHostFrom(restHost);
    RESTHostManager.reloadConfiguration();

    transientHost.url              = "https://" + vcfaFqdn;
    transientHost.hostVerification = false;

    // Build authentication request
    var requestBody = JSON.stringify({
        username: username,
        password: password
    });

    var request = transientHost.createRequest(
        "POST",
        "/csp/gateway/am/api/login?access_token",
        "application/json"
    );
    request.contentType = "application/json";
    request.setContent(requestBody);

    var response = request.execute();

    if (response.statusCode !== 200) {
        throw new Error(
            "Authentication failed. HTTP " + response.statusCode +
            ": " + response.contentAsString
        );
    }

    var responseBody = JSON.parse(response.contentAsString);

    if (!responseBody || !responseBody.access_token) {
        throw new Error(
            "Authentication response did not contain access_token. " +
            "Response: " + response.contentAsString
        );
    }

    System.log("getBearerToken: Authentication successful for user: " + username);
    return responseBody.access_token;

} catch (e) {
    System.error("getBearerToken FAILED: " + e.message);
    throw e;

} finally {
    if (transientHost !== null) {
        try {
            RESTHostManager.removeHost(transientHost);
            System.log("getBearerToken: Transient host removed.");
        } catch (cleanupErr) {
            System.warn("getBearerToken: Host cleanup warning: " + cleanupErr.message);
        }
    }
}
