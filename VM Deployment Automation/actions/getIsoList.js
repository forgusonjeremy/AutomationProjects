/**
 *
 * @module com.broadcom.pso.vcfa.customforms
 *
 * @version 0.0.0
 *
 * @param {string} vcenterName 
 * @param {string} clusterName 
 *
 * @outputType Array/string
 *
 */
function getIsoList(vcenterName, clusterName) {
	/**
	 * ============================================================================
	 *  ACTION: getIsoList
	 *  MODULE: com.broadcom.pso.vcfa.customForms
	 * ----------------------------------------------------------------------------
	 *  PURPOSE
	 *    Custom-form action. Given the selected vCenter and cluster (both passed as
	 *    STRINGS by the form, identical to getNetworkList), find every ISO on every
	 *    datastore reachable by that cluster's hosts and return their full
	 *    datastore paths as a flat, tree-ordered string[] for a Service Broker
	 *    dropdown.
	 *
	 *    "Tree-ordered" = sorted by:
	 *        datastore name (alpha)
	 *          -> folder path (alpha, parent before child)
	 *            -> ISO filename within a folder (alpha)
	 *    Implemented with a single component-wise comparator on the full path.
	 *    No tree object is built; the flat list simply renders in tree order.
	 *
	 *  IN
	 *    vcenterName : string   // VC:SdkConnection id (as getClusterList uses)
	 *    clusterName     : string   // cluster / resource-pool NAME (from getClusterList)
	 *  OUT
	 *    : Array/string         // full datastore paths, "[ds-iso] ISOs/rhel9.iso"
	 *
	 *  API VALIDATION (vroapi.com / Broadcom TechDocs)
	 *    - Server.findAllForType("VC:SdkConnection")  -> connections; match .id
	 *    - vcConnection.getAllResourcePools()         -> VcResourcePool[]   (lab)
	 *    - vcConnection.getAllClusterComputeResources() -> VcClusterComputeResource[] (prod)
	 *    - VcResourcePool.owner            -> VcComputeResource (parent cluster/host)
	 *    - VcComputeResource.host[]        -> VcHostSystem[]
	 *    - VcHostSystem.datastore[]        -> VcDatastore[]
	 *    - VcDatastore.browser             -> VcHostDatastoreBrowser
	 *    - browser.searchDatastoreSubFolders_Task(path, spec) -> VcTask (SearchResults[])
	 *    - VcHostDatastoreBrowserSearchSpec.query = [ new VcIsoImageFileQuery() ]
	 *    - VcFileQueryFlags for detail flags; VcIsoImageFileInfo result type check
	 *
	 *  NOTES
	 *    - Custom-form actions must fail fast and never hang the form: per-datastore
	 *      errors are logged and skipped; the task wait is bounded by the poll.
	 *    - No hardcoded datastore/folder names; the "ISOs folder at datastore root"
	 *      convention is NOT relied upon (all subfolders are searched).
	 * ============================================================================
	 */
	
	try {
	
	    // ---- 0. Guard: form not fully populated yet -----------------------------
	    if (!vcenterName || !clusterName) {
	        return [];
	    }
	
	    // ---- 1. Resolve the vCenter connection by sdkId (FQDN) ------------------
	    // vcenterName is the vCenter FQDN, which is the VC:SdkConnection sdkId as
	    // returned by getVCenterList (conn.sdkId). Match on sdkId, not .id.
	    var connections = Server.findAllForType("VC:SdkConnection");
	    var vcConnection = null;
	    for (var c = 0; c < connections.length; c++) {
	        if (connections[c].sdkId == vcenterName) {
	            vcConnection = connections[c];
	            break;
	        }
	    }
	    if (!vcConnection) {
	        System.warn("getIsoList: no VC:SdkConnection matched sdkId '" + vcenterName + "'.");
	        return [];
	    }
	
	    // ---- 2. Resolve the cluster NAME -> owning VcClusterComputeResource -----
	    // The supplied name may be EITHER a resource-pool name (lab, where RPs stand
	    // in for clusters) OR a real cluster name (prod). Resolve defensively and
	    // always end up at the CLUSTER level so we enumerate the cluster's hosts:
	    //   1) Look for a resource pool with this name; if found, walk .owner up to
	    //      the parent compute resource (the cluster).
	    //   2) Otherwise look for a cluster compute resource with this name directly.
	    // This handles both cases WITHOUT depending on the getClusterList lab/prod
	    // switchover, so this action needs no switchover line of its own.
	    var computeResource = null;
	
	    // 2a. Try resource pool by name -> climb to owning cluster.
	    var resourcePools = vcConnection.getAllResourcePools();
	    if (resourcePools) {
	        for (var rp = 0; rp < resourcePools.length; rp++) {
	            if (resourcePools[rp].name == clusterName) {
	                computeResource = resourcePools[rp].owner; // VcComputeResource (cluster)
	                break;
	            }
	        }
	    }
	
	    // 2b. Not a resource pool name -> try cluster compute resource by name.
	    if (!computeResource) {
	        var clusters = vcConnection.getAllClusterComputeResources();
	        if (clusters) {
	            for (var cl = 0; cl < clusters.length; cl++) {
	                if (clusters[cl].name == clusterName) {
	                    computeResource = clusters[cl];       // VcClusterComputeResource
	                    break;
	                }
	            }
	        }
	    }
	
	    if (!computeResource) {
	        System.warn("getIsoList: '" + clusterName + "' did not match any resource pool "
	            + "or cluster in vCenter '" + vcenterName + "'.");
	        return [];
	    }
	
	    // ---- 4. Union member-host datastores (dedup by MoRef) -------------------
	    // Walking hosts (vs computeResource.datastore) handles datastores mounted
	    // on only some hosts in the cluster.
	    var hosts = computeResource.host;                // VcHostSystem[]
	    if (!hosts || hosts.length === 0) {
	        System.warn("getIsoList: compute resource '" + computeResource.name
	            + "' has no member hosts.");
	        return [];
	    }
	
	    var datastoresByRef = {};                        // moRef.value -> VcDatastore
	    for (var h = 0; h < hosts.length; h++) {
	        var hostDatastores = hosts[h].datastore;     // VcDatastore[]
	        if (!hostDatastores) {
	            continue;
	        }
	        for (var d = 0; d < hostDatastores.length; d++) {
	            var dsKey = hostDatastores[d].reference.value;
	            if (!datastoresByRef.hasOwnProperty(dsKey)) {
	                datastoresByRef[dsKey] = hostDatastores[d];
	            }
	        }
	    }
	
	    // ---- 5. Build the ISO search spec (once, reused per datastore) ----------
	    var searchSpec = new VcHostDatastoreBrowserSearchSpec();
	    searchSpec.query = [ new VcIsoImageFileQuery() ]; // ISO-only result filter
	    searchSpec.searchCaseInsensitive = true;
	    searchSpec.sortFoldersFirst = true;
	    var flags = new VcFileQueryFlags();
	    flags.fileType = true;
	    flags.fileSize = false;
	    flags.modification = false;
	    flags.fileOwner = false;
	    searchSpec.details = flags;
	
	    var basic = System.getModule("com.vmware.library.vc.basic");
	
	    // ---- 6. Search each datastore, collect full paths -----------------------
	    var isoPaths = [];
	    var seenPaths = {};
	
	    for (var key in datastoresByRef) {
	        if (!datastoresByRef.hasOwnProperty(key)) {
	            continue;
	        }
	        var ds = datastoresByRef[key];
	        var browser = ds.browser;                    // VcHostDatastoreBrowser
	        if (!browser) {
	            System.warn("getIsoList: datastore '" + ds.name + "' has no browser; skipping.");
	            continue;
	        }
	
	        var rootPath = "[" + ds.name + "]";          // datastore root
	        try {
	            var task = browser.searchDatastoreSubFolders_Task(rootPath, searchSpec);
	            var results = basic.vim3WaitTaskEnd(task, false, 2); // SearchResults[]
	            if (!results) {
	                continue;
	            }
	            for (var r = 0; r < results.length; r++) {
	                var folderPath = results[r].folderPath;  // "[ds] ISOs/"
	                var fileArr = results[r].file;           // VcFileInfo[] (ISO-filtered)
	                if (!fileArr) {
	                    continue;
	                }
	                for (var f = 0; f < fileArr.length; f++) {
	                    if (!(fileArr[f] instanceof VcIsoImageFileInfo)) {
	                        continue;
	                    }
	                    var fullPath = joinDatastorePath(folderPath, fileArr[f].path);
	                    if (!seenPaths.hasOwnProperty(fullPath)) {
	                        seenPaths[fullPath] = true;
	                        isoPaths.push(fullPath);
	                    }
	                }
	            }
	        } catch (eDs) {
	            // One bad datastore must not kill the whole dropdown.
	            System.warn("getIsoList: search failed on datastore '" + ds.name + "': " + eDs);
	        }
	    }
	
	    // ---- 7. Tree-order sort -------------------------------------------------
	    isoPaths.sort(compareDatastorePaths);
	
	    System.log("getIsoList: returned " + isoPaths.length + " ISO(s) for cluster '"
	        + clusterName + "' in vCenter '" + vcenterName + "'.");
	    return isoPaths;
	
	} catch (e) {
	    System.error("getIsoList FAILED: " + (e.message ? e.message : e));
	    throw e;
	}
	
	
	/* ---------------------------------------------------------------------------
	 * Helpers (declared inline in the action body).
	 * ------------------------------------------------------------------------- */
	
	/**
	 * Join a SearchResults.folderPath with a file name into one clean datastore
	 * path. folderPath forms: "[ds]", "[ds] ", "[ds] ISOs", "[ds] ISOs/".
	 * Produces "[ds] ISOs/file.iso" or "[ds] file.iso".
	 */
	function joinDatastorePath(folderPath, fileName) {
	    var fp = ("" + folderPath).replace(/\s+$/, "");   // strip trailing whitespace
	    var closeIdx = fp.indexOf("]");
	    var afterBracket = (closeIdx >= 0) ? fp.substring(closeIdx + 1) : fp;
	    afterBracket = afterBracket.replace(/^\s+/, "");  // path part after "[ds] "
	
	    if (afterBracket.length === 0) {
	        return fp + " " + fileName;                   // root-level file
	    }
	    if (fp.charAt(fp.length - 1) === "/") {
	        return fp + fileName;
	    }
	    return fp + "/" + fileName;
	}
	
	/**
	 * Component-wise comparator: datastore name -> each folder segment (parent
	 * before child) -> file name, all alphabetical, case-insensitive.
	 */
	function compareDatastorePaths(a, b) {
	    var ka = pathSortKey(a);
	    var kb = pathSortKey(b);
	    var n = Math.min(ka.length, kb.length);
	    for (var i = 0; i < n; i++) {
	        var cmp = ciCompare(ka[i], kb[i]);
	        if (cmp !== 0) {
	            return cmp;
	        }
	    }
	    return ka.length - kb.length;                     // parent (shorter) first
	}
	
	/** Decompose "[ds] folder/sub/file.iso" -> ["ds","folder","sub","file.iso"]. */
	function pathSortKey(fullPath) {
	    var p = "" + fullPath;
	    var dsName = "";
	    var rest = p;
	    var open = p.indexOf("[");
	    var close = p.indexOf("]");
	    if (open >= 0 && close > open) {
	        dsName = p.substring(open + 1, close);
	        rest = p.substring(close + 1);
	    }
	    rest = rest.replace(/^\s+/, "");
	    var segments = (rest.length > 0) ? rest.split("/") : [];
	    var key = [dsName];
	    for (var i = 0; i < segments.length; i++) {
	        if (segments[i].length > 0) {
	            key.push(segments[i]);
	        }
	    }
	    return key;
	}
	
	function ciCompare(x, y) {
	    var lx = ("" + x).toLowerCase();
	    var ly = ("" + y).toLowerCase();
	    if (lx < ly) { return -1; }
	    if (lx > ly) { return 1; }
	    return 0;
	}
}