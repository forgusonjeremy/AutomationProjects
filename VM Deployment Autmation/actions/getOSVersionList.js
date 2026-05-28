/**
 * Action: getOSVersionList
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Retrieves available OS image mappings from VCFA for a given cloud zone.
 *   Returns a list of image names suitable for populating a catalog request
 *   dropdown. Creates and destroys its own transient REST host.
 *
 * Prerequisites:
 *   - HTTP-REST plugin configured in Orchestrator
 *   - Valid bearer token (from getBearerToken action)
 *   - VCFA FQDN and cloud zone ID known
 *
 * Inputs:
 *   vcfaFqdn    {string} - VCFA appliance FQDN
 *   bearerToken {string} - Bearer token from getBearerToken
 *   cloudZoneId {string} - VCFA cloud zone ID to query image mappings for
 *
 * Output:
 *   {string} JSON array of image mapping objects: [{id, name, osFamily}]
 */

var transientHost = null;

try {
    if (!vcfaFqdn)    throw new Error("Input 'vcfaFqdn' is required.");
    if (!bearerToken)  throw new Error("Input 'bearerToken' is required.");
    if (!cloudZoneId) throw new Error("Input 'cloudZoneId' is required.");

    System.log("getOSVersionList: Fetching image mappings for cloudZoneId: " + cloudZoneId);

    // Create transient REST host — independent of getBearerToken host
    var restHost  = RESTHostManager.createHost("vcfa-images-" + vcfaFqdn);
    transientHost = RESTHostManager.createTransientHostFrom(restHost);
    RESTHostManager.reloadConfiguration();

    transientHost.url              = "https://" + vcfaFqdn;
    transientHost.hostVerification = false;

    var request = transientHost.createRequest(
        "GET",
        "/iaas/api/image-profiles?cloudZoneId=" + encodeURIComponent(cloudZoneId),
        "application/json"
    );
    request.setHeader("Authorization", "Bearer " + bearerToken);

    var response = request.execute();

    if (response.statusCode !== 200) {
        throw new Error(
            "Image profile query failed. HTTP " + response.statusCode +
            ": " + response.contentAsString
        );
    }

    var responseBody = JSON.parse(response.contentAsString);

    if (!responseBody || !responseBody.content) {
        throw new Error(
            "Unexpected response structure from image-profiles API. " +
            "Response: " + response.contentAsString
        );
    }

    var imageList = [];
    var profiles  = responseBody.content;

    for (var i = 0; i < profiles.length; i++) {
        var profile = profiles[i];
        if (!profile.imageMappings) continue;

        var mappingKeys = Object.keys(profile.imageMappings);
        for (var m = 0; m < mappingKeys.length; m++) {
            var key     = mappingKeys[m];
            var mapping = profile.imageMappings[key];
            imageList.push({
                id:       mapping.id   || key,
                name:     key,
                osFamily: mapping.osFamily || "Unknown"
            });
        }
    }

    if (imageList.length === 0) {
        System.warn("getOSVersionList: No image mappings found for cloudZoneId: " + cloudZoneId);
    }

    var result = JSON.stringify(imageList);
    System.log("getOSVersionList: Returned " + imageList.length + " image mapping(s).");
    return result;

} catch (e) {
    System.error("getOSVersionList FAILED: " + e.message);
    throw e;

} finally {
    if (transientHost !== null) {
        try {
            RESTHostManager.removeHost(transientHost);
            System.log("getOSVersionList: Transient host removed.");
        } catch (cleanupErr) {
            System.warn("getOSVersionList: Host cleanup warning: " + cleanupErr.message);
        }
    }
}
