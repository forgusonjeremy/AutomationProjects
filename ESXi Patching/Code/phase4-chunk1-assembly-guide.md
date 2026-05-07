# Phase 4 Chunk 1 — Reusable Library Actions

> **Project:** vSphere Environment Remediation Workflow
> **Chunk:** 1 of 7 (reusable library Actions in `com.broadcom.pso.common.*`)
> **Action count:** 8
> **Date:** 2026-05-05
> **Companion files:** `chunk1-action-<actionName>.js` (one source file per Action, in this directory)

---

## Read this first

This chunk contains 8 reusable Actions that form the foundation of the project. Every other Action and workflow in the project depends on these. Build and test these first — get them right and the rest of the project layers cleanly on top.

These Actions are **intentionally generic**. Although they were created for this project, they are designed to be reused across any vRO project the architect maintains. The naming, parameter signatures, and behavior should NOT be tailored to ESXi remediation specifics — that is what project-specific Actions in later chunks are for.

---

## Action inventory

| # | Module Path | Action Name | Source File |
|---|---|---|---|
| 1 | `com.broadcom.pso.common.logging` | `initWorkflowLogging` | `chunk1-action-initWorkflowLogging.js` |
| 2 | `com.broadcom.pso.common.logging` | `auditLog` | `chunk1-action-auditLog.js` |
| 3 | `com.broadcom.pso.common.logging` | `debugLog` | `chunk1-action-debugLog.js` |
| 4 | `com.broadcom.pso.common.workflow` | `runWithParallelism` | `chunk1-action-runWithParallelism.js` |
| 5 | `com.broadcom.pso.common.workflow` | `releaseAllLocksHeldByWorkflow` | `chunk1-action-releaseAllLocksHeldByWorkflow.js` |
| 6 | `com.broadcom.pso.common.workflow` | `withRetry` | `chunk1-action-withRetry.js` |
| 7 | `com.broadcom.pso.common.config` | `getConfigurationElementValue` | `chunk1-action-getConfigurationElementValue.js` |
| 8 | `com.broadcom.pso.common.config` | `getEncryptedConfigurationElementValue` | `chunk1-action-getEncryptedConfigurationElementValue.js` |

**Build order matters.** Two Actions depend on `auditLog`:

- `runWithParallelism` calls `System.getModule("com.broadcom.pso.common.logging").auditLog(...)`.
- `releaseAllLocksHeldByWorkflow` calls the same.
- `withRetry` calls `auditLog` and also calls `System.getModule(...)` for the wrapped action.

Build them in the order listed above (logging first, then workflow, then config) so dependencies are present when each new Action is saved.

---

## Per-Action assembly instructions

For each Action below, follow this general procedure in the vRO UI:

1. Navigate to **Library → Actions** in the vRO UI.
2. Click **New Action**.
3. Set the **Module** to the full module path (e.g. `com.broadcom.pso.common.logging`). vRO will auto-create the module hierarchy if it does not exist.
4. Set the **Name** to the bare action name (e.g. `initWorkflowLogging`).
5. Set the **Description** to the one-line purpose statement (extractable from the header comment block in each source file).
6. Set the **Return type** per the table below.
7. Add **input parameters** in the exact order and types listed below. Order matters because Rhino positional argument access via `arguments[0]`, `arguments[1]`, etc., depends on it.
8. Paste the entire content of the corresponding source file (`chunk1-action-<actionName>.js`) into the script editor. The header comment block stays — it is part of the deliverable and helps reviewers understand the Action without leaving the editor.
9. Click **Save**.
10. Run the smoke test for that Action (see the testing section below) before moving to the next one.

---

### Action 1: `initWorkflowLogging`

**Module:** `com.broadcom.pso.common.logging`
**Return type:** `void`

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `prefix` | string | Workflow-layer log prefix (e.g. `[ESXI-REMEDIATE-VC]`). |
| 2 | `wfName` | string | Caller passes `workflow.name` (the global). |
| 3 | `wfRunId` | string | Caller passes `workflow.id`. |

**Why two of those inputs are passed in instead of read inside the action:** the `workflow` global is only available inside Scriptable Tasks, not inside Action scripts. The caller's Scriptable Task reads `workflow.name` and `workflow.id` and passes them in.

---

### Action 2: `auditLog`

**Module:** `com.broadcom.pso.common.logging`
**Return type:** `void`

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `prefix` | string | Per-line audit prefix (e.g. `[ESXI-REMEDIATE-VC]`). |
| 2 | `phase` | string | Phase token (e.g. `STARTUP`, `MM_ENTER`). |
| 3 | `status` | string | Status token (e.g. `OK`, `FAIL`, `RESULT`). |
| 4 | `message` | string | Human-readable message body. |

---

### Action 3: `debugLog`

**Module:** `com.broadcom.pso.common.logging`
**Return type:** `void`

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `prefix` | string | Per-line audit prefix. |
| 2 | `phase` | string | Phase token. |
| 3 | `status` | string | Status token. |
| 4 | `message` | string | Debug message body. |
| 5 | `debugEnabled` | boolean | When false, the action is a no-op. |

---

### Action 4: `runWithParallelism`

**Module:** `com.broadcom.pso.common.workflow`
**Return type:** `Array/Properties`

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `workItems` | `Array/Properties` | One Properties bag per work unit. |
| 2 | `workerWorkflow` | `Workflow` | Worker workflow to run per work item. |
| 3 | `inputBuilderActionName` | string | Format: `moduleName/actionName`. |
| 4 | `parallelismCap` | number | Max in-flight workers. |
| 5 | `pollIntervalSeconds` | number | Seconds between scheduler polls. |

---

### Action 5: `releaseAllLocksHeldByWorkflow`

**Module:** `com.broadcom.pso.common.workflow`
**Return type:** number

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `workflowRunId` | string | The workflow run ID whose locks should be released. |

---

### Action 6: `withRetry`

**Module:** `com.broadcom.pso.common.workflow`
**Return type:** `Any`

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `actionName` | string | Format: `moduleName/actionName`. |
| 2 | `actionInputs` | Properties | Inputs to pass to the wrapped action. Optional `inputOrder` Array key controls positional argument order. |
| 3 | `maxAttempts` | number | Total attempts including the first. |
| 4 | `backoffMs` | number | Base delay (ms) between attempts. |

---

### Action 7: `getConfigurationElementValue`

**Module:** `com.broadcom.pso.common.config`
**Return type:** `Any`

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `pathOrName` | string | CE path (`PSO/ESXi Remediation/Settings`) or just the name. |
| 2 | `attributeName` | string | The attribute key to read. |

---

### Action 8: `getEncryptedConfigurationElementValue`

**Module:** `com.broadcom.pso.common.config`
**Return type:** SecureString

**Inputs (in order):**

| # | Name | Type | Description |
|---|---|---|---|
| 1 | `pathOrName` | string | CE path or name. |
| 2 | `attributeName` | string | Encrypted attribute key. |

---

## Smoke testing

For each Action, run the smoke test below in the vRO UI's "Run" dialog after the Action is saved. These are minimal verifications — full integration testing happens in Phase 6 against a complete environment.

### Smoke test setup (one-time)

Before testing the config accessors, create a temporary test Configuration Element:

1. Navigate to **Library → Configurations**.
2. Create a new category at path: `PSO/_TestSmokeChunk1/`
3. Create a Configuration Element named `SmokeTest` under that category.
4. Add three attributes:
   - `testString` (string, value: `hello`)
   - `testNumber` (number, value: `42`)
   - `testEncryptedString` (SecureString, encrypted, value: `secret-value`)

Delete this CE after Chunk 1 testing is complete.

### Action-by-Action smoke tests

**Test 1: `initWorkflowLogging`**

In a temporary Scriptable Task in any test workflow:

```javascript
// Inputs to test
var prefix  = "[SMOKE-TEST]";
var wfName  = workflow.name;
var wfRunId = workflow.id;

// Invoke
System.getModule("com.broadcom.pso.common.logging")
    .initWorkflowLogging(prefix, wfName, wfRunId);
```

**Expected result:** Workflow logs show two lines:
- `WorkflowStart:Workflow Name:<name>-WorkflowRunId:<id>`
- `[SMOKE-TEST] [STARTUP] [OK] Workflow initialized | RunId: <id>`

**PASS criteria:** No exception. Both log lines visible in workflow run output.

---

**Test 2: `auditLog`**

```javascript
System.getModule("com.broadcom.pso.common.logging")
    .auditLog("[SMOKE-TEST]", "EXECUTE", "OK", "Hello from smoke test");
```

**Expected log line:** `[SMOKE-TEST] [EXECUTE] [OK] Hello from smoke test`

**PASS criteria:** Exact line appears.

---

**Test 3: `debugLog`**

Run this twice — once with debug disabled, once enabled.

```javascript
// First call: debugEnabled = false. Should NOT emit anything.
System.getModule("com.broadcom.pso.common.logging")
    .debugLog("[SMOKE-TEST]", "EXECUTE", "OK", "you should not see me", false);

// Second call: debugEnabled = true. Should emit.
System.getModule("com.broadcom.pso.common.logging")
    .debugLog("[SMOKE-TEST]", "EXECUTE", "OK", "you should see me", true);
```

**Expected:** Only the second line appears, ending with `[DEBUG]`.

**PASS criteria:** First call produces no output; second call produces `[SMOKE-TEST] [EXECUTE] [OK] you should see me [DEBUG]`.

---

**Test 4: `runWithParallelism`**

This requires a small worker workflow. Create a temporary worker workflow named `SmokeWorker`:

- Inputs: `delaySeconds` (number), `label` (string).
- One Scriptable Task that does: `System.sleep(delaySeconds * 1000); return label + "-DONE";`
- Output attribute: `result` (string), bound to the return value.

Then create an input-builder action — call it `chunk1SmokeBuildInputs` in module `com.broadcom.pso._smoke`:

```javascript
// Input: workItem (Properties)
// Returns: Properties bag of inputs for SmokeWorker
var inputs = new Properties();
inputs.put("delaySeconds", workItem.get("delaySeconds"));
inputs.put("label", workItem.get("label"));
return inputs;
```

Then call `runWithParallelism` in a test workflow:

```javascript
var smokeWorker = Server.findForType("Workflow", /* workflow ID of SmokeWorker */);

var workItems = [];
for (var i = 0; i < 5; i++) {
    var item = new Properties();
    item.put("delaySeconds", 5 - i); // first item slowest, last item fastest
    item.put("label", "item-" + i);
    workItems.push(item);
}

var results = System.getModule("com.broadcom.pso.common.workflow")
    .runWithParallelism(
        workItems,
        smokeWorker,
        "com.broadcom.pso._smoke/chunk1SmokeBuildInputs",
        2,  // parallelismCap = 2
        1   // poll every 1 second
    );

for (var i = 0; i < results.length; i++) {
    System.log("Result " + i + ": state=" + results[i].get("state") +
               " | runId=" + results[i].get("wfRunId"));
}
```

**Expected:**
- 5 worker runs eventually all complete.
- At any moment, at most 2 are running concurrently.
- Workflow logs show `Dispatched item N` and `Harvested item N` audit lines.
- Results array is in the SAME order as workItems (item-0 first, item-4 last).

**PASS criteria:** All 5 results have `state=completed`, the in-flight count never exceeded 2 (visible in audit logs), and asymmetric scheduling is visible (faster-finishing items free slots for queued items immediately).

Delete the SmokeWorker workflow and `chunk1SmokeBuildInputs` action after testing.

---

**Test 5: `releaseAllLocksHeldByWorkflow`**

```javascript
// Acquire two test locks owned by this workflow run.
var thisRunId = workflow.id;
LockingSystem.lock("SMOKE_LOCK_1", thisRunId);
LockingSystem.lock("SMOKE_LOCK_2", thisRunId);

// Verify they exist.
var beforeAll = LockingSystem.retrieveAll();
var beforeCount = 0;
for (var i = 0; i < beforeAll.length; i++) {
    if (String(beforeAll[i].owner) === thisRunId) beforeCount++;
}
System.log("Locks held by this run before release: " + beforeCount);

// Release them.
var releasedCount = System.getModule("com.broadcom.pso.common.workflow")
    .releaseAllLocksHeldByWorkflow(thisRunId);

System.log("Released: " + releasedCount);

// Verify they are gone.
var afterAll = LockingSystem.retrieveAll();
var afterCount = 0;
for (var i = 0; i < afterAll.length; i++) {
    if (String(afterAll[i].owner) === thisRunId) afterCount++;
}
System.log("Locks held by this run after release: " + afterCount);
```

**Expected:** before=2, released=2, after=0.

**PASS criteria:** All numbers match. No exception thrown.

---

**Test 6: `withRetry`**

Create a temporary action `chunk1SmokeFlaky` in module `com.broadcom.pso._smoke`:

```javascript
// Input: shouldSucceedOnAttempt (number)
// Reads/writes a global counter via System.getContext (workflow attribute).
// Throws on attempts < shouldSucceedOnAttempt; succeeds on/after.
var attemptKey = "_smokeAttempt";
var attempt = System.getContext().getParameter(attemptKey);
if (attempt == null) attempt = 0;
attempt = attempt + 1;
System.getContext().setParameter(attemptKey, attempt);

if (attempt < shouldSucceedOnAttempt) {
    throw new Error("flaky failure attempt " + attempt);
}
return "succeeded on attempt " + attempt;
```

(Note: this counter approach is contrived for the smoke test only; production code would not use System.getContext this way.)

Test calling withRetry:

```javascript
var inputs = new Properties();
inputs.put("shouldSucceedOnAttempt", 3);
inputs.put("inputOrder", ["shouldSucceedOnAttempt"]);

var result = System.getModule("com.broadcom.pso.common.workflow")
    .withRetry(
        "com.broadcom.pso._smoke/chunk1SmokeFlaky",
        inputs,
        5,    // maxAttempts
        500   // backoffMs
    );

System.log("withRetry result: " + result);
```

**Expected:** Audit log shows `attempt=1/5 ... WARN: threw`, then `attempt=2/5 ... WARN: threw`, then `attempt=3/5 ... succeeded on attempt 3`.

**PASS criteria:** Returns `succeeded on attempt 3`. Audit logs show 2 retries with exponential backoff (500ms then 1000ms sleeps).

Delete `chunk1SmokeFlaky` action after testing.

---

**Test 7: `getConfigurationElementValue`**

```javascript
var v1 = System.getModule("com.broadcom.pso.common.config")
    .getConfigurationElementValue("PSO/_TestSmokeChunk1/SmokeTest", "testString");
System.log("testString value: " + v1);

var v2 = System.getModule("com.broadcom.pso.common.config")
    .getConfigurationElementValue("PSO/_TestSmokeChunk1/SmokeTest", "testNumber");
System.log("testNumber value: " + v2);

// Verify it throws on missing attribute.
try {
    System.getModule("com.broadcom.pso.common.config")
        .getConfigurationElementValue("PSO/_TestSmokeChunk1/SmokeTest", "doesNotExist");
    System.log("FAIL: should have thrown");
} catch (e) {
    System.log("Expected throw on missing attribute: " + e.message);
}
```

**Expected:**
- `testString value: hello`
- `testNumber value: 42`
- Third call throws with message containing `attribute not found`.

**PASS criteria:** All three behaviors as expected.

---

**Test 8: `getEncryptedConfigurationElementValue`**

```javascript
var secret = System.getModule("com.broadcom.pso.common.config")
    .getEncryptedConfigurationElementValue("PSO/_TestSmokeChunk1/SmokeTest", "testEncryptedString");
// Do NOT log the value directly.
System.log("Encrypted value retrieved | length=" + (secret != null ? String(secret).length : 0));

// Verify it throws when given a non-encrypted attribute.
try {
    System.getModule("com.broadcom.pso.common.config")
        .getEncryptedConfigurationElementValue("PSO/_TestSmokeChunk1/SmokeTest", "testString");
    System.log("FAIL: should have thrown on non-encrypted attribute");
} catch (e) {
    System.log("Expected throw on non-encrypted attribute: " + e.message);
}
```

**Expected:**
- First call returns the value with length 12 (`secret-value`).
- Second call throws with message containing `is NOT marked encrypted`.

**PASS criteria:** Both behaviors as expected.

---

## Cleanup after smoke testing

After all 8 smoke tests pass:

1. Delete the temporary `PSO/_TestSmokeChunk1/SmokeTest` Configuration Element.
2. Delete the temporary `PSO/_TestSmokeChunk1/` category.
3. Delete the temporary `SmokeWorker` workflow (if created for Test 4).
4. Delete the temporary `com.broadcom.pso._smoke` module (and its actions).
5. Verify no test artifacts remain by browsing **Library → Configurations**, **Library → Workflows**, and **Library → Actions**.

---

## What's next

Once Chunk 1 is built and all 8 smoke tests pass, Chunk 2 is ready to begin:

- Chunk 2: Form-time + detect + preflight Actions (20 Actions in `com.broadcom.pso.vc.esxi.remediation.{form,detect,preflight}.*`).

Chunk 2 depends on Chunk 1 — every Action in Chunk 2 will call `auditLog` and `debugLog`, and several will use `getConfigurationElementValue` for project settings.

