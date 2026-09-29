/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LOGGING HELPER — Marker Architecture
 * Paste this block at the TOP of every scriptable task (ST-01 through ST-09
 * and the Exception Handler) before the task's own code.
 *
 * Every log line produced by this workflow follows the format:
 *
 *   [SNAPSHOT-CLEANUP] [PHASE] [STATUS] Message
 *
 * This makes every line from this workflow:
 *   - Instantly identifiable in Aria Operations for Logs
 *   - Filterable with a single search: [SNAPSHOT-CLEANUP]
 *   - Self-explanatory without needing to open documentation
 *
 * PHASE markers  : [STARTUP] [INVENTORY] [PROCESSING] [FINALISE] [ERROR]
 * STATUS markers : [OK] [SKIP] [DONE] [DRY-RUN] [HOLD] [WARN] [FAIL] [RESULT]
 * ─────────────────────────────────────────────────────────────────────────────
 */

var LOG = {
    // ── Core log emitters ────────────────────────────────────────────────────
    ok:     function(phase, msg) { System.log(  "[SNAPSHOT-CLEANUP] [" + phase + "] [OK]      " + msg); },
    skip:   function(phase, msg) { System.log(  "[SNAPSHOT-CLEANUP] [" + phase + "] [SKIP]    " + msg); },
    done:   function(phase, msg) { System.log(  "[SNAPSHOT-CLEANUP] [" + phase + "] [DONE]    " + msg); },
    dryrun: function(phase, msg) { System.log(  "[SNAPSHOT-CLEANUP] [" + phase + "] [DRY-RUN] " + msg); },
    hold:   function(phase, msg) { System.log(  "[SNAPSHOT-CLEANUP] [" + phase + "] [HOLD]    " + msg); },
    warn:   function(phase, msg) { System.warn( "[SNAPSHOT-CLEANUP] [" + phase + "] [WARN]    " + msg); },
    fail:   function(phase, msg) { System.error("[SNAPSHOT-CLEANUP] [" + phase + "] [FAIL]    " + msg); },
    result: function(phase, msg) { System.log(  "[SNAPSHOT-CLEANUP] [" + phase + "] [RESULT]  " + msg); },

    // ── Convenience shortcuts bound to each phase ────────────────────────────
    startup:    { ok:     function(m) { LOG.ok("STARTUP",     m); },
                  warn:   function(m) { LOG.warn("STARTUP",   m); },
                  fail:   function(m) { LOG.fail("STARTUP",   m); } },

    inventory:  { ok:     function(m) { LOG.ok("INVENTORY",   m); },
                  skip:   function(m) { LOG.skip("INVENTORY", m); },
                  warn:   function(m) { LOG.warn("INVENTORY", m); },
                  fail:   function(m) { LOG.fail("INVENTORY", m); } },

    processing: { ok:     function(m) { LOG.ok("PROCESSING",     m); },
                  skip:   function(m) { LOG.skip("PROCESSING",   m); },
                  done:   function(m) { LOG.done("PROCESSING",   m); },
                  dryrun: function(m) { LOG.dryrun("PROCESSING", m); },
                  hold:   function(m) { LOG.hold("PROCESSING",   m); },
                  warn:   function(m) { LOG.warn("PROCESSING",   m); },
                  fail:   function(m) { LOG.fail("PROCESSING",   m); } },

    finalise:   { ok:     function(m) { LOG.ok("FINALISE",     m); },
                  warn:   function(m) { LOG.warn("FINALISE",   m); },
                  fail:   function(m) { LOG.fail("FINALISE",   m); },
                  result: function(m) { LOG.result("FINALISE", m); } },

    error:      { ok:     function(m) { LOG.ok("ERROR",     m); },
                  warn:   function(m) { LOG.warn("ERROR",   m); },
                  fail:   function(m) { LOG.fail("ERROR",   m); },
                  result: function(m) { LOG.result("ERROR", m); } }
};
