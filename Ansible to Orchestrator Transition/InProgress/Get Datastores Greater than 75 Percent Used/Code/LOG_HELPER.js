/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LOGGING HELPER — Marker Architecture
 * Paste this block at the TOP of every scriptable task (ST-01 through ST-06
 * and the Exception Handler) before the task's own code.
 *
 * Every log line produced by this workflow follows the format:
 *
 *   [DATASTORE-REPORT] [PHASE] [STATUS] Message
 *
 * This makes every line from this workflow:
 *   - Instantly identifiable in VCF Operations for Logs
 *   - Filterable with a single search: [DATASTORE-REPORT]
 *   - Self-explanatory without needing to open documentation
 *
 * PHASE markers  : [STARTUP] [INVENTORY] [ANALYSIS] [REPORT] [NOTIFY]
 *                  [FINALISE] [ERROR]
 * STATUS markers : [OK] [SKIP] [DONE] [WARN] [FAIL] [RESULT]
 *
 * Consistency note: this mirrors the marker architecture delivered with the
 * Snapshot Cleanup package (com.broadcom.pso.vc.snapshotmanagement) so that a
 * single log-source dashboard can carry both storage workflows.
 * ─────────────────────────────────────────────────────────────────────────────
 */

var LOG = {
    // ── Core log emitters ────────────────────────────────────────────────────
    ok:     function(phase, msg) { System.log(  "[DATASTORE-REPORT] [" + phase + "] [OK]     " + msg); },
    skip:   function(phase, msg) { System.log(  "[DATASTORE-REPORT] [" + phase + "] [SKIP]   " + msg); },
    done:   function(phase, msg) { System.log(  "[DATASTORE-REPORT] [" + phase + "] [DONE]   " + msg); },
    warn:   function(phase, msg) { System.warn( "[DATASTORE-REPORT] [" + phase + "] [WARN]   " + msg); },
    fail:   function(phase, msg) { System.error("[DATASTORE-REPORT] [" + phase + "] [FAIL]   " + msg); },
    result: function(phase, msg) { System.log(  "[DATASTORE-REPORT] [" + phase + "] [RESULT] " + msg); },

    // ── Convenience shortcuts bound to each phase ────────────────────────────
    startup:   { ok:   function(m) { LOG.ok("STARTUP",   m); },
                 warn: function(m) { LOG.warn("STARTUP", m); },
                 fail: function(m) { LOG.fail("STARTUP", m); } },

    inventory: { ok:   function(m) { LOG.ok("INVENTORY",   m); },
                 skip: function(m) { LOG.skip("INVENTORY", m); },
                 done: function(m) { LOG.done("INVENTORY", m); },
                 warn: function(m) { LOG.warn("INVENTORY", m); },
                 fail: function(m) { LOG.fail("INVENTORY", m); } },

    analysis:  { ok:   function(m) { LOG.ok("ANALYSIS",     m); },
                 skip: function(m) { LOG.skip("ANALYSIS",   m); },
                 warn: function(m) { LOG.warn("ANALYSIS",   m); },
                 fail: function(m) { LOG.fail("ANALYSIS",   m); },
                 result: function(m) { LOG.result("ANALYSIS", m); } },

    report:    { ok:   function(m) { LOG.ok("REPORT",   m); },
                 warn: function(m) { LOG.warn("REPORT", m); },
                 fail: function(m) { LOG.fail("REPORT", m); } },

    notify:    { ok:   function(m) { LOG.ok("NOTIFY",   m); },
                 skip: function(m) { LOG.skip("NOTIFY", m); },
                 warn: function(m) { LOG.warn("NOTIFY", m); },
                 fail: function(m) { LOG.fail("NOTIFY", m); } },

    finalise:  { ok:     function(m) { LOG.ok("FINALISE",     m); },
                 warn:   function(m) { LOG.warn("FINALISE",   m); },
                 fail:   function(m) { LOG.fail("FINALISE",   m); },
                 result: function(m) { LOG.result("FINALISE", m); } },

    error:     { ok:     function(m) { LOG.ok("ERROR",     m); },
                 warn:   function(m) { LOG.warn("ERROR",   m); },
                 fail:   function(m) { LOG.fail("ERROR",   m); },
                 result: function(m) { LOG.result("ERROR", m); } }
};
