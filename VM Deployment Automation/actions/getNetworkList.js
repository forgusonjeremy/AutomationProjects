/**
 * Action: getNetworkList
 * Module: com.broadcom.pso.vcfa.customForms
 *
 * Purpose:
 *   Returns a sorted list of Distributed Virtual Portgroup names in a given
 *   vCenter cluster for populating network selection dropdowns in catalog forms.
 *   Supports both ClusterComputeResource and ResourcePool as clusterName input
 *   (lab environments using resource pools as fake clusters).
 *
 * Prerequisites:
 *   - vCenter Server plugin configured and connected in Orchestrator
 *   - All clusters use DVS (no standard vSwitch support — S1 accepted)
 *
 * Inputs:
 *   vcenterName {string} - vCenter sdkId as returned by getVCenterList
 *   clusterName {string} - vSphere cluster or resource pool name
 *
 * Output:
 *   {Array} Sorted array of DVPortgroup name strings, or empty array if
 *           either input is absent.
 */

try {
    if (!vcenterName || !clusterName) {
        System.log("getNetworkList: vcenterName or clusterName not yet provided — skipping.");
        return [];
    }

    System.log("getNetworkList: vcenterName='" + vcenterName + "' clusterName='" + clusterName + "'");

    var connections  = Server.findAllForType("VC:SdkConnection");
    var vcConnection = null;

    for (var i = 0; i < connections.length; i++) {
        if (connections[i].id === vcenterName) {
            vcConnection = connections[i];
            break;
        }
    }

    if (!vcConnection) {
        throw new Error("No vCenter SDK connection found with sdkId: '" + vcenterName + "'");
    }

    // --- Resolve target ClusterComputeResource ---
    // First: look for a ClusterComputeResource matching clusterName directly
    var targetCluster = null;

    var allClusters = vcConnection.getAllClusterComputeResources();
    for (var c = 0; c < allClusters.length; c++) {
        if (allClusters[c].name === clusterName) {
            targetCluster = allClusters[c];
            System.log("getNetworkList: Matched ClusterComputeResource '" + clusterName + "'");
            break;
        }
    }

    // Second: if no cluster match, look for a ResourcePool with that name
    // and walk up to its parent ClusterComputeResource
    if (!targetCluster) {
        var allResourcePools = vcConnection.getAllResourcePools();
        for (var r = 0; r < allResourcePools.length; r++) {
            if (allResourcePools[r].name === clusterName) {
                System.log("getNetworkList: Matched ResourcePool '" + clusterName + "' — walking to parent cluster.");

                var entity = allResourcePools[r];
                while (entity && entity.vimType !== "ClusterComputeResource") {
                    var parent = null;
                    try { parent = entity.parent; } catch(e) { break; }
                    if (!parent) break;
                    entity = parent;
                }

                if (entity && entity.vimType === "ClusterComputeResource") {
                    targetCluster = entity;
                    System.log("getNetworkList: Resolved to ClusterComputeResource '" + targetCluster.name + "'");
                } else {
                    System.warn("getNetworkList: Could not walk ResourcePool '" + clusterName + "' to a ClusterComputeResource.");
                }
                break;
            }
        }
    }

    if (!targetCluster) {
        throw new Error("'" + clusterName + "' not found as ClusterComputeResource or ResourcePool in vCenter: '" + vcenterName + "'");
    }

    // --- Build network list from cluster hosts ---
    var seen        = {};
    var networkList = [];
    var hosts       = targetCluster.host;

    if (!hosts || hosts.length === 0) {
        System.warn("getNetworkList: No hosts found in cluster: " + targetCluster.name);
        return [];
    }

    for (var h = 0; h < hosts.length; h++) {
        var hostNetworks = hosts[h].network;
        if (!hostNetworks) continue;

        for (var n = 0; n < hostNetworks.length; n++) {
            var network = hostNetworks[n];
            if (!network || !network.name) continue;
            if (network.vimType !== "DistributedVirtualPortgroup") continue;
            if (seen[network.name]) continue;

            seen[network.name] = true;
            networkList.push(network.name);
        }
    }

    networkList.sort(function(a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    System.log("getNetworkList: Returned " + networkList.length + " DVPortgroup(s).");
    return networkList;

} catch (e) {
    System.error("getNetworkList FAILED: " + e.message);
    throw e;
}
