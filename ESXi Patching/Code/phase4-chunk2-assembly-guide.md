# Phase 4 Chunk 2 — Project-Specific Form/Detect/Preflight Actions

> **Project:** vSphere Environment Remediation Workflow
> **Chunk:** 2 of 7 (project-specific Actions in `com.broadcom.pso.vc.esxi.remediation.{detect,preflight,form}`)
> **Action count:** 20 (2 detect + 13 preflight + 5 form)
> **Date:** 2026-05-05
> **Companion files:** `chunk2-action-<actionName>.js` (one source file per Action)
> **Depends on:** Chunk 1 (must be installed and smoke-tested first).

---

## Read this first

These are the **first project-specific Actions**. They live under the project's namespace (`com.broadcom.pso.vc.esxi.remediation.*`) and depend on Chunk 1 reusable Actions for logging and configuration access.

Three sub-modules:

- `.detect` — Cluster type identification and custom-attribute helpers. Used by both form-time and workflow-time aggregators.
- `.preflight` — Pre-flight validation checks. Used at form-time (cheap subset), at workflow start (full set), and per-host (residual capacity).
- `.form` — Form-time external value Actions powering the request form's pickers and read-only summary text areas.

**Build order matters:**

1. `.detect` first (depended on by both `.preflight` and `.form`).
2. `.preflight` next (depends on `.detect`; depended on by `.form`).
3. `.form` last (depends on `.detect` and `.preflight`).

Within each module, build dependencies in this order (within-module deps are noted in each Action's header comment block):

| Order | Module | Action |
|---|---|---|
| 1 | detect | `getClusterCustomAttributes` |
| 2 | detect | `identifyClusterType` |
| 3 | preflight | `verifyAllHostsOn8x` |
| 4 | preflight | `checkClusterHaHealth` |
| 5 | preflight | `checkClusterDrsHealth` |
| 6 | preflight | `checkClusterHostsHealthy` |
| 7 | preflight | `getLockdownModeStatus` |
| 8 | preflight | `checkVsanResyncIdle` |
| 9 | preflight | `checkClusterRecentTaskActivity` |
| 10 | preflight | `checkVsanHealth` |
| 11 | preflight | `checkDrsMigrationConstraints` |
| 12 | preflight | `checkDepotVersionCompatibility` |
| 13 | preflight | `evaluateResidualCapacity` |
| 14 | preflight | `evaluateClusterPreflightCheap` (depends on 1-12 above) |
| 15 | preflight | `evaluateClusterPreflightFull` (depends on `*Cheap`) |
| 16 | form | `getRegisteredVcenters` |
| 17 | form | `getDepotItemsForVcenter` |
| 18 | form | `getClustersForVcenterAndPatch` (depends on `*Cheap`) |
| 19 | form | `buildClusterValidationSummary` (depends on `*Cheap`) |
| 20 | form | `buildReviewSectionSummary` |

---

## Module: `com.broadcom.pso.vc.esxi.remediation.detect`

### Action 1: `getClusterCustomAttributes`

**Module:** `com.broadcom.pso.vc.esxi.remediation.detect` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to read attributes from. |

### Action 2: `identifyClusterType`

**Module:** `com.broadcom.pso.vc.esxi.remediation.detect` · **Return:** `string`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to classify. |

Returns one of `"VXRAIL"`, `"POWERFLEX"`, `"VSAN-ONLY"`, `"OTHER"`.

---

## Module: `com.broadcom.pso.vc.esxi.remediation.preflight`

### Action 3: `verifyAllHostsOn8x`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster whose hosts to check. |

### Action 4: `checkClusterHaHealth`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to assess. |

### Action 5: `checkClusterDrsHealth`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to assess. |

### Action 6: `checkClusterHostsHealthy`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to assess. |

### Action 7: `getLockdownModeStatus`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to enumerate. |

### Action 8: `checkVsanResyncIdle`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to probe. |

### Action 9: `checkClusterRecentTaskActivity`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to probe. |
| 2 | `lookbackMinutes` | number | How far back to scan task history. |

### Action 10: `checkVsanHealth`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to probe. |
| 2 | `groupsToCheck` | `Array/string` | Subset of vSAN health groups (null/empty = curated default). |

### Action 11: `checkDrsMigrationConstraints`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to scan. |

### Action 12: `checkDepotVersionCompatibility`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster whose hosts to compare. |
| 2 | `depotName` | string | Depot CL item filename. |

### Action 13: `evaluateResidualCapacity`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster being evaluated. |
| 2 | `nextHost` | `VC:HostSystem` | Host about to enter MM. |
| 3 | `alreadyFailedHostMoRefs` | `Array/string` | Hosts that failed earlier this run. |
| 4 | `smallClusterAcknowledged` | boolean | Ack2 state for 4-node clusters. |

### Action 14: `evaluateClusterPreflightCheap`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to evaluate. |
| 2 | `depotName` | string | Selected depot's filename, or empty string. |
| 3 | `smallClusterAcknowledged` | boolean | Ack2 state. |
| 4 | `ignoreWarnings` | boolean | Advanced silence-warnings toggle. |

### Action 15: `evaluateClusterPreflightFull`

**Module:** `com.broadcom.pso.vc.esxi.remediation.preflight` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `cluster` | `VC:ClusterComputeResource` | Cluster to evaluate. |
| 2 | `depotName` | string | Selected depot's filename. |
| 3 | `smallClusterAcknowledged` | boolean | Ack2 state. |
| 4 | `ignoreWarnings` | boolean | Advanced silence-warnings toggle. |
| 5 | `recentTaskLookbackMinutes` | number | Default 60. |

---

## Module: `com.broadcom.pso.vc.esxi.remediation.form`

### Action 16: `getRegisteredVcenters`

**Module:** `com.broadcom.pso.vc.esxi.remediation.form` · **Return:** `Array/Properties`

No inputs.

### Action 17: `getDepotItemsForVcenter`

**Module:** `com.broadcom.pso.vc.esxi.remediation.form` · **Return:** `Array/Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `vcenter` | `VC:SdkConnection` | Selected vCenter from form. |
| 2 | `contentLibraryNamePattern` | string | Substring pattern from CE-01. |

### Action 18: `getClustersForVcenterAndPatch`

**Module:** `com.broadcom.pso.vc.esxi.remediation.form` · **Return:** `Array/Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `vcenter` | `VC:SdkConnection` | Selected vCenter. |
| 2 | `depotItem` | `Properties` | Selected depot item, or null. |

### Action 19: `buildClusterValidationSummary`

**Module:** `com.broadcom.pso.vc.esxi.remediation.form` · **Return:** `string`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `selectedClusters` | `Array/VC:ClusterComputeResource` | Currently-selected clusters from form. |
| 2 | `depotItem` | `Properties` | Selected depot item, or null. |
| 3 | `smallClusterAcknowledged` | boolean | Ack2 state. |
| 4 | `ignoreWarnings` | boolean | Advanced toggle. |

### Action 20: `buildReviewSectionSummary`

**Module:** `com.broadcom.pso.vc.esxi.remediation.form` · **Return:** `string`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `values` | `Properties` | All form values as a Properties bag. |
| 2 | `defaults` | `Properties` | Per-key boolean indicating defaulted state. |

---

## Smoke testing

Chunk 2 testing is more involved than Chunk 1 because most Actions need a real vCenter cluster to test against. The recommended approach:

1. Identify a **non-production** test cluster — preferably a small lab VxRail cluster.
2. Build all 20 Actions following the build-order above.
3. Run the smoke tests below in order. Each is a Scriptable Task in a temporary "ChunkTwoSmokeTest" workflow.

### Test 1: detect module sanity

```javascript
var detect = System.getModule("com.broadcom.pso.vc.esxi.remediation.detect");

// Replace with a real cluster from your test vCenter.
var testCluster = /* drag in a cluster from inventory */;

var attrs = detect.getClusterCustomAttributes(testCluster);
System.log("Custom attribute count: " + attrs.keys.length);
for (var i = 0; i < attrs.keys.length; i++) {
    var k = attrs.keys[i];
    System.log("  " + k + " = " + attrs.get(k));
}

var type = detect.identifyClusterType(testCluster);
System.log("Cluster type: " + type);
```

**Expected:**
- For a VxRail test cluster: type=VXRAIL and attribute list shows `VxRail-IP`.
- For a non-VxRail cluster: type=VSAN-ONLY or OTHER.

### Test 2: individual preflight checks

For each preflight Action 3-13, write a Scriptable Task that calls it and prints the resulting Properties. Inspect the output by hand to confirm sanity. Keep these tests in your test workflow as separate Scriptable Tasks so you can iterate.

```javascript
var pf = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");
var testCluster = /* test cluster */;

var checks = [
    "verifyAllHostsOn8x",
    "checkClusterHaHealth",
    "checkClusterDrsHealth",
    "checkClusterHostsHealthy",
    "getLockdownModeStatus",
    "checkVsanResyncIdle",
    "checkVsanHealth",
    "checkDrsMigrationConstraints"
];

for (var i = 0; i < checks.length; i++) {
    var name = checks[i];
    System.log("=== " + name + " ===");
    try {
        var result;
        if (name === "checkVsanHealth") {
            result = pf[name](testCluster, null);
        } else {
            result = pf[name](testCluster);
        }
        var keys = result.keys;
        for (var k = 0; k < keys.length; k++) {
            System.log("  " + keys[k] + " = " + result.get(keys[k]));
        }
    } catch (e) {
        System.log("  THREW: " + e.message);
    }
}
```

### Test 3: aggregator

```javascript
var pf = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");
var testCluster = /* test cluster */;

// Cheap aggregator with no depot, ack=false, no ignore.
var cheap = pf.evaluateClusterPreflightCheap(testCluster, "", false, false);
System.log("Cheap status: " + cheap.get("status"));
var findings = cheap.get("findings");
for (var i = 0; i < findings.length; i++) {
    System.log("  [" + findings[i].severity + "] " + findings[i].check + ": " + findings[i].message);
}

// Full aggregator (adds vSAN resync + recent tasks).
var full = pf.evaluateClusterPreflightFull(testCluster, "", false, false, 60);
System.log("Full status: " + full.get("status"));
System.log("Full findings count: " + full.get("findings").length);
```

**Expected:** Status reflects the actual cluster state. For a healthy VxRail VxRail cluster: `READY`. For a 3-node cluster: `BLOCKED` with reason "3-node cluster blocked per AD-04". For other configurations, findings should match your understanding of the cluster's actual state.

### Test 4: residual capacity

```javascript
var pf = System.getModule("com.broadcom.pso.vc.esxi.remediation.preflight");
var testCluster = /* test cluster */;
var firstHost = testCluster.host[0];

// First-host evaluation: no failures yet, no Ack2.
var result = pf.evaluateResidualCapacity(testCluster, firstHost, [], false);
System.log("Mode: " + result.get("mode"));
System.log("CanProceed: " + result.get("canProceed"));
System.log("Reason: " + result.get("reason"));
var details = result.get("details");
System.log("Details: total=" + details.get("totalHosts") +
           " healthy=" + details.get("healthyHosts") +
           " ftt=" + details.get("ftt"));
```

**Expected:** For a 5+ node healthy VxRail cluster, mode=`PROCEED_FLOOR_OK`, canProceed=true. For a 4-node cluster: mode=`BLOCK_4_NODE_NO_ACK`. For a 3-node cluster: mode=`BLOCK_3_NODE`.

### Test 5: form-time Actions

```javascript
var form = System.getModule("com.broadcom.pso.vc.esxi.remediation.form");

// Test 5a: getRegisteredVcenters
var vcenters = form.getRegisteredVcenters();
System.log("Found " + vcenters.length + " vCenters:");
for (var i = 0; i < vcenters.length; i++) {
    System.log("  " + vcenters[i].get("label"));
}

// Test 5b: getDepotItemsForVcenter
var testVc = vcenters[0].get("value");
var depots = form.getDepotItemsForVcenter(testVc, "ESXi-Patches");
System.log("Found " + depots.length + " depot items in CLs matching 'ESXi-Patches':");
for (var d = 0; d < depots.length; d++) {
    System.log("  " + depots[d].get("label"));
}

// Test 5c: getClustersForVcenterAndPatch (with no depot)
var clusters = form.getClustersForVcenterAndPatch(testVc, null);
System.log("Found " + clusters.length + " clusters (no depot context):");
for (var c = 0; c < clusters.length; c++) {
    System.log("  " + clusters[c].get("label"));
}

// Test 5c continued: with depot context
if (depots.length > 0) {
    var clustersWithDepot = form.getClustersForVcenterAndPatch(testVc, depots[0].get("value"));
    System.log("Found " + clustersWithDepot.length + " clusters (with depot context):");
    for (var cd = 0; cd < clustersWithDepot.length; cd++) {
        System.log("  " + clustersWithDepot[cd].get("label"));
    }
}
```

**Expected:**
- `getRegisteredVcenters` returns at least one entry (your test vCenter).
- `getDepotItemsForVcenter` returns CL items if the test vCenter has a CL named like "ESXi-Patches…" with depot ZIPs in it; otherwise empty.
- `getClustersForVcenterAndPatch` returns one entry per cluster, each with a label like `clusterName (VXRAIL — READY)`.

### Test 6: validation summary text

```javascript
var form = System.getModule("com.broadcom.pso.vc.esxi.remediation.form");
var vcenters = form.getRegisteredVcenters();
var clusters = form.getClustersForVcenterAndPatch(vcenters[0].get("value"), null);

// Take all clusters as "selected".
var selectedClusters = [];
for (var i = 0; i < clusters.length && i < 3; i++) {
    selectedClusters.push(clusters[i].get("value"));
}

var summary = form.buildClusterValidationSummary(selectedClusters, null, false, false);
System.log(summary);
```

**Expected:** Multi-line text with `============` borders, per-cluster blocks separated by `------------`, and CRITICAL/WARNING markers visible inline.

### Test 7: review section text

```javascript
var form = System.getModule("com.broadcom.pso.vc.esxi.remediation.form");

var values = new Properties();
values.put("vmsaReference", "VMSA-2024-0001");
values.put("ack1Acknowledged", true);
values.put("ack2SmallClusterAcknowledged", false);
values.put("ack3FinalAcknowledged", true);
values.put("vcenter", form.getRegisteredVcenters()[0].get("value"));
values.put("depotItem", null);
values.put("clusters", []);
values.put("notificationToList", ["ops@example.com"]);
values.put("notificationCcList", []);
values.put("rebootBudgetMinutes", 25);
values.put("ignorePreflightWarnings", false);
values.put("showAllVsanHealthGroups", false);
values.put("maxParallelClusters", 3);
values.put("debugLogging", false);
values.put("recentTaskLookbackMinutes", 60);

var defaults = new Properties();
defaults.put("rebootBudgetMinutes", true);
defaults.put("ignorePreflightWarnings", true);
defaults.put("showAllVsanHealthGroups", true);
defaults.put("maxParallelClusters", true);
defaults.put("debugLogging", true);
defaults.put("recentTaskLookbackMinutes", true);
defaults.put("notificationCcList", true);

var review = form.buildReviewSectionSummary(values, defaults);
System.log(review);
```

**Expected:** Review block with sections (Acknowledgements / Target / Notifications / Advanced), each value labeled, Advanced values tagged with `(default)`.

---

## What's next

Chunk 3 covers Staging + Account + Host operations (21 Actions: 4 staging + 7 account + 10 host). These are the meat of the patching procedure — depot transfer, ephemeral account lifecycle, the 14-phase per-host procedure.

