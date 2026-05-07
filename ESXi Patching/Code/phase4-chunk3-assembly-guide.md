# Phase 4 Chunk 3 — Staging, Account, and Host Operation Actions

> **Project:** vSphere Environment Remediation Workflow
> **Chunk:** 3 of 7 — staging + account + host modules
> **Action count:** 21 (4 staging + 7 account + 10 host)
> **Date:** 2026-05-06
> **Companion files:** `chunk3-action-<actionName>.js` (one source file per Action)
> **Depends on:** Chunk 1 + Chunk 2 (must be installed and smoke-tested first).

---

## Read this first

This is the **meat of the patching procedure**. These Actions implement the operational primitives that the per-host workflow (WF-03, coming in Chunk 5) orchestrates. Three sub-modules:

- `.staging` — Locate, verify, and prepare the depot file for `esxcli software vib install`.
- `.account` — Lifecycle management of ephemeral local ESXi accounts (per AD-08): create, grant Administrator, enable SSH service, disable SSH service, delete account.
- `.host` — Per-host procedure primitives: baseline capture, MM enter/exit, esxcli wrapper, output parsing, reboot, reconnect wait, build verification, HA rejoin verification.

**Build order matters within the chunk:**

1. `.staging` first — depended on by host operations.
2. `.account` next — depended on by host operations.
3. `.host` last — depends on both.

| # | Module | Action |
|---|---|---|
| 1 | staging | `resolveDepotFilePath` |
| 2 | staging | `getDepotChecksum` |
| 3 | staging | `verifyDepotFileOnHost` |
| 4 | staging | `prepareEsxcliInvocation` |
| 5 | account | `generateShortRunId` |
| 6 | account | `generateEphemeralPassword` |
| 7 | account | `provisionEphemeralAccount` |
| 8 | account | `grantHostAdminRole` |
| 9 | account | `enableSshService` |
| 10 | account | `disableSshService` |
| 11 | account | `cleanupEphemeralAccount` |
| 12 | host | `captureHostBaseline` |
| 13 | host | `verifyEsxiSshAuth` |
| 14 | host | `enterMaintenanceMode` |
| 15 | host | `exitMaintenanceMode` |
| 16 | host | `runEsxcliCommand` |
| 17 | host | `parseEsxcliInstallOutput` |
| 18 | host | `rebootHost` |
| 19 | host | `waitForHostReconnect` |
| 20 | host | `verifyPatchedBuild` |
| 21 | host | `verifyHostHaRejoin` |

---

## Architectural decisions baked into Chunk 3

These were committed at the start of this chunk (per the architect-confirmed defaults):

**Short run ID format** — first 8 hex characters of the workflow run ID after stripping dashes (e.g., `d4e84e3f-3c8f-4561-9b9e-a8b91c3e8d62` → `d4e84e3f`). Used in ephemeral account names: `vro-patch-<8hex>`. Implemented in `generateShortRunId`.

**SSH session management** — per-phase: each Action that needs SSH opens a fresh `SSHSession`, runs commands, disconnects in a `finally` block. Each phase verifies the ephemeral account still works as a side effect of the connect. Implemented uniformly across `verifyDepotFileOnHost`, `verifyEsxiSshAuth`, `runEsxcliCommand`.

**Permissive cleanup philosophy** — `cleanupEphemeralAccount` and `disableSshService` never throw. They log WARN and return partial-success indicators in their result Properties. This lets cluster-level cleanup classify per AD-09 states A/B/C without losing the original error.

**Operator-state preservation** — `disableSshService` reads `wasAlreadyRunning` from the captured baseline. If SSH was running before our run started, we leave it running. Implemented by passing `captureHostBaseline.sshWasAlreadyRunning` through to `disableSshService`.

**Permission ordering at cleanup** — `cleanupEphemeralAccount` removes the host permission FIRST, then deletes the user. Reverse order is safe but produces ugly cluster events for "permission references missing principal."

**MM-exit pre-check** — `exitMaintenanceMode` no-ops if the host is already not in MM. `rebootHost` REFUSES if the host is not in MM (defense-in-depth).

**Build verification requires both build-changed AND match-expected** — `verifyPatchedBuild` returns `verified=true` only when the build differs from baseline AND matches the expected build (when expected is supplied). This catches both "patch silently failed" and "wrong depot was applied" cases.

**HA rejoin treats null `dasHostState` as no-op** — `verifyHostHaRejoin` returns `rejoined=true` if the cluster has HA disabled (no work to verify).

---

## Module: `com.broadcom.pso.vc.esxi.remediation.staging`

### Action 1: `resolveDepotFilePath`

**Module:** `com.broadcom.pso.vc.esxi.remediation.staging` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `vcenter` | `VC:SdkConnection` | vCenter for CL lookup. |
| 2 | `depotItem` | `Properties` | From form picker (must contain `libraryId`, `itemId`, `itemFileName`). |
| 3 | `targetHost` | `VC:HostSystem` | Host that will read the file. |

Returns `{ absolutePath, datastoreName, isLocal, backingType }`. Throws if storage backing cannot be resolved.

### Action 2: `getDepotChecksum`

**Module:** `com.broadcom.pso.vc.esxi.remediation.staging` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `vcenter` | `VC:SdkConnection` | vCenter for CL lookup. |
| 2 | `depotItem` | `Properties` | From form picker. |

Returns `{ algorithm, checksum }`. `algorithm="(none)"` when vCenter has no checksum on file — downstream verifier warns rather than aborts.

### Action 3: `verifyDepotFileOnHost`

**Module:** `com.broadcom.pso.vc.esxi.remediation.staging` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to verify on. |
| 2 | `absolutePath` | string | From `resolveDepotFilePath`. |
| 3 | `sshUsername` | string | Ephemeral account name. |
| 4 | `sshPassword` | `SecureString` | Ephemeral password. |
| 5 | `expectedAlgorithm` | string | "SHA-256" / "SHA-1" / "(none)". |
| 6 | `expectedChecksum` | string | Lowercase hex. |

Returns `{ readable, sizeBytes, checksumVerified, checksumActual, reason }`. Throws on SSH connect failure; returns `readable=false` on file-not-found.

### Action 4: `prepareEsxcliInvocation`

**Module:** `com.broadcom.pso.vc.esxi.remediation.staging` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `absolutePath` | string | On-host depot path. |
| 2 | `noLiveInstall` | boolean | Default true (KB requires deferred install). |
| 3 | `maintenanceModeRequired` | boolean | Default true (defense in depth). |
| 4 | `dryRun` | boolean | Default false. True for PATCH_LIST phase. |

Returns `{ commandLine, timeoutSeconds }`. Pure string composition — no side effects.

---

## Module: `com.broadcom.pso.vc.esxi.remediation.account`

### Action 5: `generateShortRunId`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `workflowRunId` | string | Pass `workflow.id`. |

Returns `{ shortId, username }`. `username = "vro-patch-<shortId>"`.

### Action 6: `generateEphemeralPassword`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** `SecureString`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `length` | number | Default 24. Range `[16, 64]`. |

Uses Java `SecureRandom`. Guarantees one character of each class (lower/upper/digit/special). Excludes ambiguous chars (`l`, `0`, `1`, `I`, `O`).

### Action 7: `provisionEphemeralAccount`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to provision on. |
| 2 | `username` | string | From `generateShortRunId`. |
| 3 | `password` | `SecureString` | From `generateEphemeralPassword`. |

Returns `{ created, description }`. Idempotent on AlreadyExists. Description format: `"vRO ESXi Patch Workflow run <fullRunId> created <ISO>"`.

### Action 8: `grantHostAdminRole`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** void

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host whose authorization manager. |
| 2 | `username` | string | Principal to grant role to. |

Assigns built-in Administrator role (roleId=-1) to the host entity. Idempotent — `setEntityPermissions` overwrites.

### Action 9: `enableSshService`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to enable SSH on. |

Returns `{ wasAlreadyRunning }`. Caller must persist this and pass to `disableSshService` later for the operator-state-preservation invariant. Throws if `TSM-SSH` is missing from inventory or `startService` fails.

### Action 10: `disableSshService`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to disable SSH on. |
| 2 | `wasAlreadyRunning` | boolean | From `enableSshService` earlier in this run. |

Returns `{ stopped }`. Permissive on failure. Leaves SSH running if `wasAlreadyRunning=true`.

### Action 11: `cleanupEphemeralAccount`

**Module:** `com.broadcom.pso.vc.esxi.remediation.account` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host whose account to remove. |
| 2 | `username` | string | Principal to clean up. |

Returns `{ permissionRemoved, accountDeleted, allClean, errors }`. Cleanup order: removeEntityPermission first, then removeUser. Idempotent on NotFound. Permissive on all other errors.

---

## Module: `com.broadcom.pso.vc.esxi.remediation.host`

### Action 12: `captureHostBaseline`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to capture state from. |

Returns `{ hostName, hostMoRef, esxiVersion, esxiBuild, bootTime, connectionState, inMaintenanceMode, sshWasAlreadyRunning, captureTime }`. Throws if not connected or already in MM.

### Action 13: `verifyEsxiSshAuth`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to test against. |
| 2 | `sshUsername` | string | Ephemeral username. |
| 3 | `sshPassword` | `SecureString` | Ephemeral password. |

Returns `{ authenticated, canRunPrivCmd, esxiVersion, esxiBuild, reason }`. Throws on connect failure (treats as fatal — credentials should already be working at this point).

### Action 14: `enterMaintenanceMode`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to enter MM. |
| 2 | `evacuatePoweredOffVms` | boolean | Default true. |
| 3 | `timeoutSeconds` | number | Default 3600 (1 hour). |
| 4 | `vsanDataEvacuationMode` | string | Default `"ensureObjectAccessibility"`. |

Returns `{ success, durationSec, taskState, error }`. Polls task to completion with timeout.

### Action 15: `exitMaintenanceMode`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to exit MM. |
| 2 | `timeoutSeconds` | number | Default 600. |

Returns `{ success, durationSec, taskState, error }`. No-op if not in MM.

### Action 16: `runEsxcliCommand`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to run on. |
| 2 | `sshUsername` | string | |
| 3 | `sshPassword` | `SecureString` | |
| 4 | `commandLine` | string | Full command. |
| 5 | `timeoutSeconds` | number | Default 300. |
| 6 | `logCommand` | boolean | Default true. |

Returns `{ exitCode, stdout, stderr, durationSec, success }`. Per-phase fresh SSH session.

### Action 17: `parseEsxcliInstallOutput`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `stdout` | string | Captured `esxcli software vib install` output. |

Returns `{ installAction, rebootRequired, vibsInstalled, vibsRemoved, vibsSkipped, messageLines }`. Pure parser — no side effects. Handles both real-run and dry-run output formats.

### Action 18: `rebootHost`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to reboot. |
| 2 | `force` | boolean | Default false. |

Returns `{ success, taskInitiated, error }`. Initiates reboot via vCenter SDK (NOT esxcli). REFUSES if host is not in MM. Does NOT wait for reconnect — that's `waitForHostReconnect`'s job.

### Action 19: `waitForHostReconnect`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to wait for. |
| 2 | `rebootBudgetSeconds` | number | Default 1500 (25 min per C-10). |
| 3 | `beforeBootTime` | Date | Pre-reboot bootTime from baseline. |

Returns `{ success, wentOffline, cameBackOnline, bootTimeChanged, durationSec, reason }`. Two-phase wait: 60s for offline detection, then `rebootBudgetSeconds` for reconnect.

### Action 20: `verifyPatchedBuild`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to verify. |
| 2 | `expectedBuild` | string | Build number from depot filename, or empty. |
| 3 | `beforeBuild` | string | Pre-patch build from baseline. |

Returns `{ verified, currentBuild, currentVersion, buildChanged, buildMatchesExpected, reason }`. Reads via SDK (not SSH) with up to 60s wait for `host.config.product` to populate.

### Action 21: `verifyHostHaRejoin`

**Module:** `com.broadcom.pso.vc.esxi.remediation.host` · **Return:** `Properties`

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `targetHost` | `VC:HostSystem` | Host to verify. |
| 2 | `timeoutSeconds` | number | Default 600. |

Returns `{ rejoined, haAgentState, durationSec, reason }`. Polls `host.runtime.dasHostState.state` for healthy values (primary/secondary/master/slave). Per AD-09 / FR-27, failures here are tracked separately for residual capacity decisions.

---

## The 14-phase per-host procedure — how the Actions compose

This is the order WF-03 (next chunk) will invoke them. The numbered phases match FR-19 in the requirements doc.

| # | Phase | Action(s) | Notes |
|---|---|---|---|
| 1 | MM_PRECHECK | `captureHostBaseline` | Fails if host not connected or already in MM. |
| 2 | AUTH_PROVISION | `provisionEphemeralAccount` + `grantHostAdminRole` | Created via vCenter SDK. |
| 3 | AUTH_VERIFY | `verifyEsxiSshAuth` | Confirms credentials before MM disruption. |
| 4 | SSH_ENABLE | `enableSshService` | Captures `wasAlreadyRunning`. |
| 5 | (defense-in-depth) | `verifyDepotFileOnHost` | Confirms host can read the depot. Pre-MM check. |
| 6 | MM_ENTER | `enterMaintenanceMode` | vSAN evacuation mode = `ensureObjectAccessibility`. |
| 7 | PATCH_LIST | `runEsxcliCommand` (with dryRun=true) + `parseEsxcliInstallOutput` | Reports what would be installed. |
| 8 | PATCH_INSTALL | `runEsxcliCommand` (with dryRun=false) + `parseEsxcliInstallOutput` | Real install with `--no-live-install`. |
| 9 | REBOOT | `rebootHost` | Refuses if not in MM. |
| 10 | RECONNECT | `waitForHostReconnect` | 25-min budget per C-10. |
| 11 | VERIFY_BUILD | `verifyPatchedBuild` | Both bootTime AND build must have changed. |
| 12 | HA_REJOIN | `verifyHostHaRejoin` | Failures here excluded from residual capacity tally. |
| 13 | SSH_DISABLE | `disableSshService` | Honors `wasAlreadyRunning`. |
| 14 | MM_EXIT | `exitMaintenanceMode` | No-op if already not in MM. |
| | AUTH_CLEANUP | `cleanupEphemeralAccount` | Permission first, then user. Permissive. |

---

## Smoke testing

Chunk 3 testing requires more setup than the previous chunks because the Actions touch real ESXi hosts. The ideal lab is a **single non-production VxRail node** that can be put into MM, rebooted, and patched with a small/trivial depot for testing purposes.

**Strong recommendation: do NOT skip the smoke tests.** The 14-phase procedure has many failure modes; better to find them in lab than during cluster remediation.

### Test 1: account lifecycle (low-risk, do this first)

Tests creation/grant/cleanup on a real host without ever entering MM or running esxcli.

```javascript
var account = System.getModule("com.broadcom.pso.vc.esxi.remediation.account");

var testHost = /* drag in a connected ESXi 8.x host */;

// Generate IDs and password.
var ids = account.generateShortRunId(workflow.id);
System.log("Username will be: " + ids.get("username"));

var pwd = account.generateEphemeralPassword(24);
// pwd is a SecureString — do NOT log it.

// Provision.
var provResult = account.provisionEphemeralAccount(
    testHost, ids.get("username"), pwd
);
System.log("Account created: " + provResult.get("created"));

// Grant role.
account.grantHostAdminRole(testHost, ids.get("username"));
System.log("Role granted.");

// Verify SSH auth (this confirms creation worked).
var host = System.getModule("com.broadcom.pso.vc.esxi.remediation.host");

// First, enable SSH.
var sshState = System.getModule("com.broadcom.pso.vc.esxi.remediation.account")
    .enableSshService(testHost);
var wasRunning = sshState.get("wasAlreadyRunning");

try {
    var verifyResult = host.verifyEsxiSshAuth(
        testHost, ids.get("username"), pwd
    );
    System.log("Auth verified: " + verifyResult.get("authenticated"));
    System.log("Can run priv cmd: " + verifyResult.get("canRunPrivCmd"));
    System.log("Version: " + verifyResult.get("esxiVersion"));
    System.log("Build: " + verifyResult.get("esxiBuild"));
} finally {
    // Always clean up.
    account.disableSshService(testHost, wasRunning);
    var cleanResult = account.cleanupEphemeralAccount(testHost, ids.get("username"));
    System.log("Cleanup all clean: " + cleanResult.get("allClean"));
    System.log("Cleanup errors: " + cleanResult.get("errors").length);
}
```

**Expected:** All steps return success. After cleanup, the account should not exist on the host (verify in vSphere UI: Host > Configure > Local Users).

### Test 2: depot resolution (no patching, just resolution)

Tests path resolution and checksum lookup using your CL.

```javascript
var staging = System.getModule("com.broadcom.pso.vc.esxi.remediation.staging");
var form    = System.getModule("com.broadcom.pso.vc.esxi.remediation.form");

var vcenter = form.getRegisteredVcenters()[0].get("value");
var depots = form.getDepotItemsForVcenter(vcenter, "ESXi-Patches");
if (depots.length === 0) throw new Error("No depots found in CLs matching pattern");

var depotItem = depots[0].get("value");
var testHost = vcenter.allHostSystems[0]; // pick any connected host

// Resolve path.
var resolved = staging.resolveDepotFilePath(vcenter, depotItem, testHost);
System.log("Path: " + resolved.get("absolutePath"));
System.log("Datastore: " + resolved.get("datastoreName"));
System.log("Backing: " + resolved.get("backingType"));
System.log("Local: " + resolved.get("isLocal"));

// Get checksum.
var checksum = staging.getDepotChecksum(vcenter, depotItem);
System.log("Algorithm: " + checksum.get("algorithm"));
System.log("Checksum: " + checksum.get("checksum"));

// Prepare command line.
var cmdInfo = staging.prepareEsxcliInvocation(
    resolved.get("absolutePath"), true, true, true
);
System.log("Dry-run command: " + cmdInfo.get("commandLine"));
System.log("Recommended timeout: " + cmdInfo.get("timeoutSeconds"));
```

**Expected:** Path resolves to `/vmfs/volumes/<datastore>/contentlib-<libId>/<itemId>/<filename>`. Checksum is SHA-256 (preferred) or SHA-1 if uploaded older. Command line ends with `--no-live-install --maintenance-mode --dry-run`.

### Test 3: dry-run patch list (no actual install)

This combines accounts, SSH, and depot to do a non-disruptive `esxcli software vib install --dry-run`. The host is NOT put into MM and is NOT rebooted.

```javascript
var account = System.getModule("com.broadcom.pso.vc.esxi.remediation.account");
var staging = System.getModule("com.broadcom.pso.vc.esxi.remediation.staging");
var host = System.getModule("com.broadcom.pso.vc.esxi.remediation.host");
var form = System.getModule("com.broadcom.pso.vc.esxi.remediation.form");

var vcenter = form.getRegisteredVcenters()[0].get("value");
var depots = form.getDepotItemsForVcenter(vcenter, "ESXi-Patches");
var depotItem = depots[0].get("value");
var testHost = /* drag in lab host */;

var ids = account.generateShortRunId(workflow.id);
var pwd = account.generateEphemeralPassword(24);

account.provisionEphemeralAccount(testHost, ids.get("username"), pwd);
account.grantHostAdminRole(testHost, ids.get("username"));
var sshState = account.enableSshService(testHost);

try {
    var resolved = staging.resolveDepotFilePath(vcenter, depotItem, testHost);
    var checksum = staging.getDepotChecksum(vcenter, depotItem);

    // Verify file is readable.
    var fileCheck = staging.verifyDepotFileOnHost(
        testHost, resolved.get("absolutePath"),
        ids.get("username"), pwd,
        checksum.get("algorithm"), checksum.get("checksum")
    );
    System.log("Readable: " + fileCheck.get("readable"));
    System.log("Checksum verified: " + fileCheck.get("checksumVerified"));

    // Run dry-run install.
    var cmdInfo = staging.prepareEsxcliInvocation(
        resolved.get("absolutePath"), true, true, true   // dryRun=true!
    );
    var execResult = host.runEsxcliCommand(
        testHost, ids.get("username"), pwd,
        cmdInfo.get("commandLine"),
        cmdInfo.get("timeoutSeconds"), true
    );
    System.log("Exit: " + execResult.get("exitCode"));

    // Parse output.
    var parsed = host.parseEsxcliInstallOutput(execResult.get("stdout"));
    System.log("Install action: " + parsed.get("installAction"));
    System.log("Reboot required: " + parsed.get("rebootRequired"));
    System.log("VIBs would be installed: " + parsed.get("vibsInstalled").length);
    System.log("VIBs would be removed: " + parsed.get("vibsRemoved").length);
} finally {
    account.disableSshService(testHost, sshState.get("wasAlreadyRunning"));
    account.cleanupEphemeralAccount(testHost, ids.get("username"));
}
```

**Expected:** `installAction = "would succeed"`. The `vibsInstalled` count depends on whether the host is already at the depot's level. If the host is already patched, the parser returns empty arrays — that's correct.

### Test 4: full per-host procedure (DESTRUCTIVE — lab only!)

Do not run this on production. This puts the host into MM and reboots it. Dry-run-equivalent commands are NOT a substitute — the only way to fully test the procedure is to actually do it.

The orchestration logic for the full 14 phases lives in WF-03 (Chunk 5). Wait until that is built before attempting end-to-end testing.

---

## Two things worth flagging before we move on

**1. `verifyDepotFileOnHost` does the SHA-256 over SSH using `sha256sum`.** A multi-GB depot takes ~30-60s to checksum on typical hardware. The Action's internal SSH timeout for the checksum step is 300s. If you've got a slower NFS backing, that may need to increase — but in practice 300s is plenty.

**2. `enterMaintenanceMode` defaults to `ensureObjectAccessibility` for vSAN evacuation.** This is the standard VxRail/vSAN MM-enter mode. The KB procedure works fine with it. If the architect wants `evacuateAllData` (slower but more conservative — full evacuation of all vSAN object copies), the workflow can pass it as the 4th arg. We did NOT make it the default because it dramatically slows MM-enter on full clusters and isn't required for the kind of bootbank-only patches this workflow handles.

---

## What's next

**Chunk 4** covers cluster + locking + tracking + reconcile + results + report (21 Actions: 1 cluster + 3 locking + 5 tracking + 5 reconcile + 3 results + 4 report). These are the cross-cutting concerns that WF-01/WF-02 use to coordinate work across hosts and clusters: per-cluster locks, the CE-05 run tracker, async fan-out result aggregation, AD-09 cluster-continuation classification, and the final email/text report assembly.

After Chunk 4, the remaining Chunks 5/6/7 are the actual workflow definitions (WF-01 through WF-07). The workflows are mostly Scriptable Tasks calling these Actions — most of the engineering work for the project is done in Chunks 1-4.
