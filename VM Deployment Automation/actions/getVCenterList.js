/**
 * Action: getVCenterList
 * Module: com.broadcom.pso.vcfa.customForms
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
 *   {string} (array) vCenter Names
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

        var vcName = null;

        try { 
            vcName = conn.sdkId;
        } 
        catch (e) { 
            System.warn("getVCenterList[" + i + "]: Could not read name: " + e.message);
        }

        vcenterList.push(vcName)
    }

    System.log("getVCenterList: Returned " + vcenterList.length + " vCenter connection(s).");

    return vcenterList;

} catch (e) {
    System.error("getVCenterList FAILED: " + e.message);
    throw e;
}
