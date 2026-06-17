/**
 * Action: getClusterList
 * Module: com.broadcom.pso.customforms
 *
 * Purpose:
 *   Returns a list of compute clusters in a given vCenter datacenter for
 *   populating cluster selection dropdowns in catalog request forms.
 *
 * Prerequisites:
 *   - vCenter Server plugin configured and connected in Orchestrator
 *
 * Inputs:
 *   vcenterName {string} - name of the vCenter from which to get a list of vSphere clusters
 *
 * Output:
 *   {string} (array) Cluster Names
 *
 * Notes:
 *   - vimType values must be validated for your vCenter SDK version (V4 validation item)
 *   - Expected vimType string: "ClusterComputeResource"
 */

try {
    if (vcenterName){
        var connections = Server.findAllForType("VC:SdkConnection")
        var vcConnection
        for (var i = 0; i < connections.length; i++){
            var connection = connections[i]
            if (connection.id == vcenterName){
                vcConnection = connection;
                break;
            }
        }

        System.log("getClusterList: Searching for clusters in vCenter: " + vcenterName);

        var clusterList  = [];
        //var allClusters  = vcConnection.getAllClusterComputeResources()
        var allResourcePools = vcConnection.getAllResourcePools() 
        var allClusters = vcConnection.getAllClusterComputeResources()

        if (!allClusters || allClusters.length === 0) {
            System.warn("getClusterList: No clusters found in vCenter inventory.");
            return JSON.stringify([]);
        }

        for (var i = 0; i < allClusters.length; i++) {
            var cluster = allClusters[i];

            try {
                var clusterName = cluster.name
                System.log("clusterName: " + clusterName)
            } catch (summaryErr) {
                System.warn("getClusterList: Could not get name for cluster '" + cluster.name);
            }

            clusterList.push(clusterName);
        }

        if (!allResourcePools || allResourcePools.length === 0) {
            System.warn("getClusterList: No clusters found in vCenter inventory.");
            return JSON.stringify([]);
        }

        for (var i = 0; i < allResourcePools.length; i++) {
            var resourcePool = allResourcePools[i];

            try {
                if (resourcePool.name == "Resources"){
                    //do nothing
                }
                else {
                    var resourcePoolName = resourcePool.name
                    System.log("clusterName: " + resourcePool)
                }
                
            } catch (summaryErr) {
                System.warn("getClusterList: Could not get name for cluster '" + resourcePool.name);
            }

            clusterList.push(resourcePoolName);
        }

        System.log("getClusterList: Returned " + clusterList.length + " cluster(s) in vCenter: " + vcenterName);
        return clusterList
    }
} catch (e) {
    System.error("getClusterList FAILED: " + e.message);
    throw e;
}
