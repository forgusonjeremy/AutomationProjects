/**
 * Action: getVCenterList
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Returns a list of all vCenter Server instances currently connected to
 *   VCF Orchestrator. Intended for populating vCenter selection dropdowns
 *   in catalog request forms or for resolving the correct SDK connection
 *   in multi-vCenter environments.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured in Orchestrator
 *   - At least one active vCenter connection
 *
 * Inputs:
 *   (none)
 *
 * Output:
 *   {string} JSON array: [{name, url, version, apiVersion}]
 *
 * Notes:
 *   - Returns all registered connections regardless of connectivity state.
 *   - 'name' is the display name assigned when the vCenter was registered
 *     in Orchestrator (Administration → Integrations → vCenter Server).
 *   - Use 'name' to match against user input when resolving the correct
 *     SDK connection in multi-vCenter workflows.
 */

try {
    var connections = VcPlugin.getAllSdkConnections();

    if (!connections || connections.length === 0) {
        System.warn("getVCenterList: No vCenter SDK connections found.");
        return JSON.stringify([]);
    }

    var vcenterList = [];

    for (var i = 0; i < connections.length; i++) {
        var conn = connections[i];

        var name       = null;
        var url        = null;
        var version    = null;
        var apiVersion = null;

        try { name       = conn.name;                                          } catch (e) { System.warn("getVCenterList[" + i + "]: Could not read name: "       + e.message); }
        try { url        = conn.url;                                           } catch (e) { System.warn("getVCenterList[" + i + "]: Could not read url: "        + e.message); }
        try { version    = conn.serviceInstance.content.about.version;         } catch (e) { System.warn("getVCenterList[" + i + "]: Could not read version: "    + e.message); }
        try { apiVersion = conn.serviceInstance.content.about.apiVersion;      } catch (e) { System.warn("getVCenterList[" + i + "]: Could not read apiVersion: " + e.message); }

        vcenterList.push({
            name:       name,
            url:        url,
            version:    version,
            apiVersion: apiVersion
        });
    }

    System.log("getVCenterList: Returned " + vcenterList.length + " vCenter connection(s).");
    return JSON.stringify(vcenterList);

} catch (e) {
    System.error("getVCenterList FAILED: " + e.message);
    throw e;
}
