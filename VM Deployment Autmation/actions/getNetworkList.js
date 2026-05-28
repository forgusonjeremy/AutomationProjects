/**
 * Action: getNetworkList
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Returns a list of Distributed Virtual Portgroups available in a given
 *   vCenter cluster for populating network selection dropdowns in catalog forms.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured and connected in Orchestrator
 *   - All clusters use Distributed Virtual Switches (DVS) — no standard switch support
 *
 * Inputs:
 *   clusterName  {string} - vCenter cluster display name
 *   datacenterName {string} - vCenter datacenter display name
 *
 * Output:
 *   {string} JSON array: [{name, moRef, vlanId}]
 *
 * Assumptions:
 *   - All portgroups in the cluster are DVPortgroups (S1 accepted — confirmed DVS-only)
 *   - vimType values confirmed for target vCenter SDK version (V4 validation required)
 */

try {
    if (!clusterName)    throw new Error("Input 'clusterName' is required.");
    if (!datacenterName) throw new Error("Input 'datacenterName' is required.");

    System.log("getNetworkList: Searching for portgroups in cluster '" + clusterName +
               "' datacenter '" + datacenterName + "'");

    var networkList = [];
    var allNetworks = VcPlugin.getAllNetworks();

    if (!allNetworks || allNetworks.length === 0) {
        System.warn("getNetworkList: No networks found in vCenter inventory.");
        return JSON.stringify([]);
    }

    for (var i = 0; i < allNetworks.length; i++) {
        var network = allNetworks[i];

        // Filter: DVPortgroup only (vimType check — validate V4 for your vCenter SDK version)
        if (!network.vimType || network.vimType !== "DistributedVirtualPortgroup") {
            continue;
        }

        // Filter: match datacenter and cluster association
        var hosts = network.host;
        if (!hosts || hosts.length === 0) continue;

        var inTargetCluster = false;
        for (var h = 0; h < hosts.length; h++) {
            var host = hosts[h];
            if (!host.parent) continue;

            // host.parent is the ClusterComputeResource
            if (host.parent.vimType !== "ClusterComputeResource") continue;
            if (host.parent.name !== clusterName) continue;

            // Walk up to datacenter
            var entity = host.parent;
            while (entity && entity.vimType !== "Datacenter") {
                entity = entity.parent;
            }
            if (entity && entity.name === datacenterName) {
                inTargetCluster = true;
                break;
            }
        }

        if (!inTargetCluster) continue;

        var vlanId = null;
        try {
            if (network.config && network.config.defaultPortConfig &&
                network.config.defaultPortConfig.vlan) {
                vlanId = network.config.defaultPortConfig.vlan.vlanId || null;
            }
        } catch (vlanErr) {
            System.warn("getNetworkList: Could not read VLAN ID for network '" +
                        network.name + "': " + vlanErr.message);
        }

        networkList.push({
            name:  network.name,
            moRef: network.reference.value,
            vlanId: vlanId
        });
    }

    System.log("getNetworkList: Returned " + networkList.length + " portgroup(s).");
    return JSON.stringify(networkList);

} catch (e) {
    System.error("getNetworkList FAILED: " + e.message);
    throw e;
}
