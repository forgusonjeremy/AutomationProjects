/**
 * Action: getClusterList
 * Module: com.vcf.guestcustomization
 *
 * Purpose:
 *   Returns a list of compute clusters in a given vCenter datacenter for
 *   populating cluster selection dropdowns in catalog request forms.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured and connected in Orchestrator
 *
 * Inputs:
 *   datacenterName {string} - vCenter datacenter display name
 *
 * Output:
 *   {string} JSON array: [{name, moRef, totalCpuMhz, totalMemoryMB, numHosts}]
 *
 * Notes:
 *   - vimType values must be validated for your vCenter SDK version (V4 validation item)
 *   - Expected vimType string: "ClusterComputeResource"
 */

try {
    if (!datacenterName) throw new Error("Input 'datacenterName' is required.");

    System.log("getClusterList: Searching for clusters in datacenter: " + datacenterName);

    var clusterList  = [];
    var allClusters  = VcPlugin.getAllClusterComputeResources();

    if (!allClusters || allClusters.length === 0) {
        System.warn("getClusterList: No clusters found in vCenter inventory.");
        return JSON.stringify([]);
    }

    for (var i = 0; i < allClusters.length; i++) {
        var cluster = allClusters[i];

        if (!cluster.vimType || cluster.vimType !== "ClusterComputeResource") {
            continue;
        }

        // Walk up to datacenter to verify association
        var entity = cluster;
        while (entity && entity.vimType !== "Datacenter") {
            entity = entity.parent;
        }

        if (!entity || entity.name !== datacenterName) continue;

        var totalCpu    = null;
        var totalMemory = null;
        var numHosts    = null;

        try {
            if (cluster.summary) {
                totalCpu    = cluster.summary.totalCpu    || null;
                totalMemory = cluster.summary.totalMemory
                    ? Math.round(cluster.summary.totalMemory / 1048576) // bytes to MB
                    : null;
                numHosts    = cluster.summary.numHosts    || null;
            }
        } catch (summaryErr) {
            System.warn("getClusterList: Could not read summary for cluster '" +
                        cluster.name + "': " + summaryErr.message);
        }

        clusterList.push({
            name:        cluster.name,
            moRef:       cluster.reference.value,
            totalCpuMhz: totalCpu,
            totalMemoryMB: totalMemory,
            numHosts:    numHosts
        });
    }

    System.log("getClusterList: Returned " + clusterList.length + " cluster(s) in datacenter: " + datacenterName);
    return JSON.stringify(clusterList);

} catch (e) {
    System.error("getClusterList FAILED: " + e.message);
    throw e;
}
