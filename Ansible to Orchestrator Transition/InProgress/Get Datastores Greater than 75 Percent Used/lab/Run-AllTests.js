// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE — Get Datastore Capacity Report
//
//   node Run-AllTests.js
//
// Exercises the shipped source in ../Code against the synthetic estate in
// fixtures.js. Also writes the sample reports referenced by the User Guide and
// the Validation & Testing Plan.
//
// Exit code 0 = all assertions passed.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const path = require('path');
const shim = require('./vro-shim');
const fx   = require('./fixtures');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else {
        fail++; failures.push(name + (detail ? '  (' + detail + ')' : ''));
        console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
    }
}
function eq(name, actual, expected) {
    check(name, actual === expected, 'expected ' + JSON.stringify(expected) +
                                     ', got ' + JSON.stringify(actual));
}
function expectThrow(name, fn, fragment) {
    try {
        fn();
        check(name, false, 'did not throw');
    } catch (e) {
        const msg = String(e.message || e);
        check(name, !fragment || msg.indexOf(fragment) !== -1, 'message was: ' + msg);
    }
}
function section(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

function rowsOf(ctx) {
    const b = JSON.parse(ctx.bandedJson);
    return { critical: b.critical, warning: b.warning, advisory: b.advisory, meta: b.meta };
}
function names(rows) { return rows.map(r => r.name); }
function findRow(ctx, name, vcName) {
    const b = rowsOf(ctx);
    const all = b.critical.concat(b.warning, b.advisory);
    return all.filter(r => r.name === name && (!vcName || r.vcenterName === vcName))[0];
}

// ═════════════════════════════════════════════════════════════════════════════
section('T-01  Full run across the estate (defaults, mail enabled)');
// ═════════════════════════════════════════════════════════════════════════════
const estate = fx.buildEstate();
const env    = shim.newEnv(estate.all);
const ctx    = shim.newContext();
shim.runWorkflow(ctx, env);

check('runId is stamped in DSR- format', /^DSR-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(ctx.runId), ctx.runId);
eq  ('outcome reflects the unreachable vCenter', ctx.outcome, 'COMPLETE_WITH_GAPS');
eq  ('mail was sent',                            ctx.mailSent, true);
eq  ('one SMTP message captured',                env.capture.sent.length, 1);

const bands = rowsOf(ctx);
console.log('        critical: ' + JSON.stringify(names(bands.critical)));
console.log('        warning : ' + JSON.stringify(names(bands.warning)));
console.log('        advisory: ' + JSON.stringify(names(bands.advisory)));

// ═════════════════════════════════════════════════════════════════════════════
section('T-02  P-35  One unreachable vCenter does not end the run');
// ═════════════════════════════════════════════════════════════════════════════
const fails = JSON.parse(ctx.failuresJson);
eq   ('exactly one vCenter recorded as failed', fails.length, 1);
eq   ('the failed vCenter is vc.corp.local',    fails[0].vcenterName, 'vc.corp.local');
check('failure reason is carried through',      /incorrect user name or password/.test(fails[0].error), fails[0].error);
check('datastores from the other vCenters survived', bands.critical.length > 0);
check('the report was still produced',          ctx.reportHtml.length > 0);
check('the report was still delivered',         ctx.mailSent === true);

// The legacy implementation, on the same estate, delivers nothing at all.
const legacy = fx.legacySelect(estate.all);
check('legacy run aborts on this estate (nothing emailed)', legacy.aborted === true,
      'legacy aborted=' + legacy.aborted);
console.log('        legacy aborted on: ' + legacy.abortedOn + ' — ' + legacy.abortError);

// ═════════════════════════════════════════════════════════════════════════════
section('T-03  P-35  Zero-capacity datastore is skipped, not fatal');
// ═════════════════════════════════════════════════════════════════════════════
const skipped = JSON.parse(ctx.skippedJson);
const zeroCap = skipped.filter(s => s.name === 'DECOMMISSIONED-01')[0];
check('zero-capacity datastore recorded in skipped[]', !!zeroCap);
eq   ('with the capacity reason', zeroCap && zeroCap.reason, 'zero or unreadable capacity');
check('it does not appear in any band', !findRow(ctx, 'DECOMMISSIONED-01'));

// Legacy, in isolation, dies on exactly this row.
const legacyJustVc02 = fx.legacySelect([fx.buildEstate().vc02]);
check('legacy divides by zero on the same datastore',
      legacyJustVc02.aborted && /divide by zero/.test(legacyJustVc02.abortError),
      legacyJustVc02.abortError);

// ═════════════════════════════════════════════════════════════════════════════
section('T-04  Unreadable datastore is isolated, siblings still collected');
// ═════════════════════════════════════════════════════════════════════════════
const faulty = skipped.filter(s => s.name === 'FAULTY-VMFS-099')[0];
check('faulting datastore recorded in skipped[]', !!faulty);
check('its sibling on the same vCenter was still collected',
      !!findRow(ctx, 'NFS-ARCHIVE-01'));

// ═════════════════════════════════════════════════════════════════════════════
section('T-05  P-36  Full-but-not-overcommitted datastore is now reported');
// ═════════════════════════════════════════════════════════════════════════════
const full = findRow(ctx, 'PROD-VMFS-002');
check('PROD-VMFS-002 (99.10% used, low uncommitted) appears', !!full);
eq   ('it is in the Critical band', bands.critical.filter(r => r.name === 'PROD-VMFS-002').length, 1);
eq   ('and is correctly flagged NOT overcommitted', full && full.overcommitted, false);

const legacyClean = fx.legacySelect([fx.buildEstate().vc01]);
const legacyNames = legacyClean.high.concat(legacyClean.med, legacyClean.low).map(r => r.name);
check('legacy omitted it entirely', legacyNames.indexOf('PROD-VMFS-002') === -1,
      'legacy saw: ' + JSON.stringify(legacyNames));

// ═════════════════════════════════════════════════════════════════════════════
section('T-06  P-34  Boundary datastores land in exactly one band');
// ═════════════════════════════════════════════════════════════════════════════
const b9000 = findRow(ctx, 'BOUNDARY-90-00');
const b8999 = findRow(ctx, 'BOUNDARY-89-99');
const b8000 = findRow(ctx, 'BOUNDARY-80-00');
const b7000 = findRow(ctx, 'BOUNDARY-70-00');

eq('90.00% computes exactly',  b9000 && b9000.percentUsed, 90);
eq('89.99% computes exactly',  b8999 && b8999.percentUsed, 89.99);
eq('80.00% computes exactly',  b8000 && b8000.percentUsed, 80);
eq('70.00% computes exactly',  b7000 && b7000.percentUsed, 70);

eq('90.00% -> Critical', bands.critical.filter(r => r.name === 'BOUNDARY-90-00').length, 1);
eq('89.99% -> Warning',  bands.warning .filter(r => r.name === 'BOUNDARY-89-99').length, 1);
eq('80.00% -> Warning',  bands.warning .filter(r => r.name === 'BOUNDARY-80-00').length, 1);
eq('70.00% -> Advisory', bands.advisory.filter(r => r.name === 'BOUNDARY-70-00').length, 1);

// No row may appear in two bands.
const allNamesWithVc = bands.critical.concat(bands.warning, bands.advisory)
                            .map(r => r.vcenterName + '|' + r.moRef);
eq('no datastore appears in more than one band',
   allNamesWithVc.length, new Set(allNamesWithVc).size);

// All four were invisible in the legacy report.
['BOUNDARY-90-00','BOUNDARY-89-99','BOUNDARY-80-00','BOUNDARY-70-00'].forEach(n => {
    check('legacy dropped ' + n, legacyNames.indexOf(n) === -1);
});

// ═════════════════════════════════════════════════════════════════════════════
section('T-07  Below-floor datastore is excluded');
// ═════════════════════════════════════════════════════════════════════════════
check('QUIET-VMFS-050 (41.20%) is not reported', !findRow(ctx, 'QUIET-VMFS-050'));

// ═════════════════════════════════════════════════════════════════════════════
section('T-08  P-37  Same-named datastores on different vCenters both survive');
// ═════════════════════════════════════════════════════════════════════════════
const collides = bands.critical.concat(bands.warning, bands.advisory)
                      .filter(r => r.name === 'SITE-PROD-01');
eq   ('both SITE-PROD-01 rows are present', collides.length, 2);
check('they are attributed to different vCenters',
      collides.length === 2 && collides[0].vcenterName !== collides[1].vcenterName);

const legacyBoth = fx.legacySelect([fx.buildEstate().vc03, fx.buildEstate().vc04]);
eq('legacy kept only one of them', legacyBoth.high.filter(r => r.name === 'SITE-PROD-01').length, 1);

// ═════════════════════════════════════════════════════════════════════════════
section('T-09  Uncommitted value absent -> "unknown", never asserted as false');
// ═════════════════════════════════════════════════════════════════════════════
const nfs = findRow(ctx, 'NFS-ARCHIVE-01');
check('NFS-ARCHIVE-01 is reported',              !!nfs);
eq   ('uncommittedKnown is false',               nfs && nfs.uncommittedKnown, false);
eq   ('uncommittedGB is null, not 0',            nfs && nfs.uncommittedGB, null);
eq   ('overcommitted is not asserted true',      nfs && nfs.overcommitted, false);
check('report renders it as "unknown"',          /unknown<\/span>/.test(ctx.reportHtml));
check('report renders an em dash for the value', /&mdash;/.test(ctx.reportHtml));

// ═════════════════════════════════════════════════════════════════════════════
section('T-10  Inaccessible datastores: excluded by default, included on request');
// ═════════════════════════════════════════════════════════════════════════════
check('APD-VMFS-007 excluded by default', !findRow(ctx, 'APD-VMFS-007'));
check('and recorded as skipped with a reason',
      skipped.filter(s => s.name === 'APD-VMFS-007' && /inaccessible/.test(s.reason)).length === 1);

const estateB = fx.buildEstate();
const envB    = shim.newEnv(estateB.all);
const ctxB    = shim.newContext({ includeInaccessible: true, sendEmail: false });
shim.runWorkflow(ctxB, envB);
check('APD-VMFS-007 included when includeInaccessible is true', !!findRow(ctxB, 'APD-VMFS-007'));

// ═════════════════════════════════════════════════════════════════════════════
section('T-11  Placement: datacenter and datastore cluster resolve');
// ═════════════════════════════════════════════════════════════════════════════
const prod14 = findRow(ctx, 'PROD-VMFS-014');
eq('datacenter resolved from the inventory tree', prod14 && prod14.datacenter, 'DC-EAST');
eq('storage pod resolved as the datastore cluster', prod14 && prod14.datastoreCluster, 'SDRS-PROD');
const loose = findRow(ctx, 'BOUNDARY-90-00');
eq('a datastore in a nested folder still resolves its datacenter', loose && loose.datacenter, 'DC-EAST');
eq('and carries no datastore cluster', loose && loose.datastoreCluster, '');

// A vCenter whose inventory tree cannot be walked must still yield capacity data.
const estateC = fx.buildEstate();
const brokenTree = fx.vc('vc06.corp.local',
    [fx.ds('TREELESS-01', { percentUsed: 95.00, capacityGB: 512, uncommittedGB: 400 })],
    { rootFolderThrows: true });
const envC = shim.newEnv([brokenTree]);
const ctxC = shim.newContext({ vCenterConnections: [brokenTree], sendEmail: false });
shim.runWorkflow(ctxC, envC);
check('capacity still collected when the placement walk fails', !!findRow(ctxC, 'TREELESS-01'));
eq   ('placement columns degrade to blank', findRow(ctxC, 'TREELESS-01').datacenter, '');
check('and the degradation is warned, not silent',
      envC.capture.warn.some(w => /placement map/.test(w)));

// ═════════════════════════════════════════════════════════════════════════════
section('T-12  Report rendering and escaping');
// ═════════════════════════════════════════════════════════════════════════════
check('report is a complete HTML document', /^<html>/.test(ctx.reportHtml) && /<\/html>$/.test(ctx.reportHtml));
check('P-39 a stylesheet is present',       /<style>/.test(ctx.reportHtml));
check('all three band headings render',
      /Critical &mdash;/.test(ctx.reportHtml) &&
      /Warning &mdash;/.test(ctx.reportHtml) &&
      /Advisory &mdash;/.test(ctx.reportHtml));
check('P-38 the unreachable vCenter is named in the report body',
      /This report is incomplete/.test(ctx.reportHtml) && /vc\.corp\.local/.test(ctx.reportHtml));
check('the skipped-datastore table is rendered', /could not be evaluated/.test(ctx.reportHtml));

check('a hostile datastore name is escaped',
      ctx.reportHtml.indexOf('<script>alert') === -1 &&
      ctx.reportHtml.indexOf('&lt;script&gt;alert') !== -1);
check('embedded quotes are escaped', ctx.reportHtml.indexOf('&quot;quoted&quot;') !== -1);

// ═════════════════════════════════════════════════════════════════════════════
section('T-13  Ordering is worst-first and deterministic');
// ═════════════════════════════════════════════════════════════════════════════
let ordered = true;
for (let i = 1; i < bands.critical.length; i++) {
    if (bands.critical[i - 1].percentUsed < bands.critical[i].percentUsed) ordered = false;
}
check('critical band is sorted descending by % used', ordered,
      JSON.stringify(bands.critical.map(r => r.percentUsed)));

const envD = shim.newEnv(fx.buildEstate().all);
const ctxD = shim.newContext({ sendEmail: false });
shim.runWorkflow(ctxD, envD);
eq('a repeat run over identical data produces byte-identical bands',
   JSON.stringify(rowsOf(ctxD)), JSON.stringify(rowsOf(ctx)));

// ═════════════════════════════════════════════════════════════════════════════
section('T-14  Mail subject carries all three counts and declares incompleteness');
// ═════════════════════════════════════════════════════════════════════════════
const sent = env.capture.sent[0];
check('subject keeps the operator prefix', sent.subject.indexOf('VCF-Orchestrator-Report: Datastore Report') === 0);
check('subject carries critical/warning/advisory counts',
      /\d+ critical \/ \d+ warning \/ \d+ advisory/.test(sent.subject), sent.subject);
check('subject declares the incomplete scan', /INCOMPLETE \(1 vCenter\(s\) unreachable\)/.test(sent.subject), sent.subject);
eq   ('subject counts match the banded rows',
      sent.subject.indexOf(bands.critical.length + ' critical / ' + bands.warning.length +
                           ' warning / ' + bands.advisory.length + ' advisory') > -1, true);
eq('body is sent as HTML', sent.parts[0].mime, 'text/html');
eq('recipients are comma joined', sent.toAddress, 'On-PremEngineering@corp.local');
eq('cc is populated', sent.ccAddress, 'Monitoring@corp.local');
check('no SMTP authentication is attempted for an anonymous relay', sent.username === null);

// ═════════════════════════════════════════════════════════════════════════════
section('T-15  Cc handling: blank entries stripped, not rejected');
// ═════════════════════════════════════════════════════════════════════════════
const envE = shim.newEnv(fx.buildEstate().all);
const ctxE = shim.newContext({ mailCc: ['', '   ', null] });
shim.runWorkflow(ctxE, envE);
eq('mail still sends with an all-blank Cc list', ctxE.mailSent, true);
eq('and no Cc header is set',                    envE.capture.sent[0].ccAddress, null);

// ═════════════════════════════════════════════════════════════════════════════
section('T-16  Input validation fails fast, before any vCenter is contacted');
// ═════════════════════════════════════════════════════════════════════════════
function initOnly(overrides) {
    const e = shim.newEnv(fx.buildEstate().all);
    const c = shim.newContext(overrides);
    shim.runTask('ST-01_InitialiseRun.js', c, e);
    return c;
}
expectThrow('threshold above 100 is rejected',      () => initOnly({ thresholdHighPct: 140 }), 'thresholdHighPct');
expectThrow('threshold of zero is rejected',        () => initOnly({ thresholdHighPct: 0 }),   'thresholdHighPct');
expectThrow('non-numeric threshold is rejected',    () => initOnly({ thresholdHighPct: 'ninety' }), 'thresholdHighPct');
expectThrow('negative band width is rejected',      () => initOnly({ bandWidthPct: -5 }),      'bandWidthPct');
expectThrow('bands that underflow zero are rejected', () => initOnly({ thresholdHighPct: 15, bandWidthPct: 10 }), 'reporting floor');
expectThrow('mail enabled with no SMTP host',       () => initOnly({ smtpHost: '' }),          'smtpHost is empty');
expectThrow('mail enabled with a bad From',         () => initOnly({ mailFrom: 'not-an-address' }), 'mailFrom');
expectThrow('mail enabled with no valid recipient', () => initOnly({ mailTo: ['', 'nope'] }),  'no valid recipient');

const noMail = initOnly({ sendEmail: false, smtpHost: '', mailTo: [] });
eq('mail validation is skipped when sendEmail is false', noMail.outcome, 'RUNNING');

// ═════════════════════════════════════════════════════════════════════════════
section('T-17  vCenter resolution');
// ═════════════════════════════════════════════════════════════════════════════
const estF = fx.buildEstate();
const envF = shim.newEnv(estF.all);
const ctxF = shim.newContext();
shim.runTask('ST-01_InitialiseRun.js', ctxF, envF);
eq('empty input resolves every registered vCenter', ctxF.targetConnections.length, 5);

const ctxG = shim.newContext({ vCenterConnections: [estF.vc01, estF.vc03] });
shim.runTask('ST-01_InitialiseRun.js', ctxG, envF);
eq('an explicit list narrows the run', ctxG.targetConnections.length, 2);

const envH = shim.newEnv([]);   // no vCenters registered at all
expectThrow('no registered vCenter is a hard failure',
            () => shim.runTask('ST-01_InitialiseRun.js', shim.newContext(), envH),
            'No vCenter connections available');

// ═════════════════════════════════════════════════════════════════════════════
section('T-18  Clean estate -> CLEAN_NO_FINDINGS, and a report is still sent');
// ═════════════════════════════════════════════════════════════════════════════
const quiet = fx.vc('vcq.corp.local', [
    fx.ds('QUIET-01', { percentUsed: 12.00, capacityGB: 1024, uncommittedGB: 10 }),
    fx.ds('QUIET-02', { percentUsed: 55.55, capacityGB: 1024, uncommittedGB: 10 })
]);
const envI = shim.newEnv([quiet]);
const ctxI = shim.newContext({ vCenterConnections: [quiet] });
shim.runWorkflow(ctxI, envI);
eq   ('outcome is CLEAN_NO_FINDINGS',      ctxI.outcome, 'CLEAN_NO_FINDINGS');
eq   ('no rows in any band',               ctxI.criticalCount + ctxI.warningCount + ctxI.advisoryCount, 0);
eq   ('the report is still delivered',     ctxI.mailSent, true);
check('and says so plainly',               /No datastore in the scanned estate is at or above/.test(ctxI.reportHtml));
check('subject shows zeroes',              /0 critical \/ 0 warning \/ 0 advisory/.test(envI.capture.sent[0].subject));

// ═════════════════════════════════════════════════════════════════════════════
section('T-19  Custom thresholds re-band correctly');
// ═════════════════════════════════════════════════════════════════════════════
const envJ = shim.newEnv(fx.buildEstate().all);
const ctxJ = shim.newContext({ thresholdHighPct: 95, bandWidthPct: 5, sendEmail: false });
shim.runWorkflow(ctxJ, envJ);
const bandsJ = rowsOf(ctxJ);
eq('critical floor follows the input',  bandsJ.meta.criticalFloor, 95);
eq('warning floor is derived',          bandsJ.meta.warningFloor,  90);
eq('advisory floor is derived',         bandsJ.meta.advisoryFloor, 85);
check('a 92.97% datastore moves down to Warning',
      bandsJ.warning.filter(r => r.name === 'PROD-VMFS-014').length === 1);
check('an 89.99% datastore moves down to Advisory (85-90%)',
      bandsJ.advisory.filter(r => r.name === 'BOUNDARY-89-99').length === 1);
check('a 80.00% datastore now falls below the 85% floor and drops out',
      !findRow(ctxJ, 'BOUNDARY-80-00'));
check('a 70.00% datastore also drops out',
      !findRow(ctxJ, 'BOUNDARY-70-00'));

// ═════════════════════════════════════════════════════════════════════════════
section('T-20  Delivery failure surfaces as a run failure, report recoverable');
// ═════════════════════════════════════════════════════════════════════════════
const envK = shim.newEnv(fx.buildEstate().all);
envK.capture.smtpShouldFail = true;
envK.capture.smtpFailMessage = 'Connection timed out to mailrelay.corp.local:25';
const ctxK = shim.newContext();
let threw = null;
try {
    shim.runWorkflow(ctxK, envK);
} catch (e) {
    threw = String(e.message || e);
}
check('the run raises on delivery failure',  threw !== null, 'no exception raised');
check('the message names the relay',         threw && /mailrelay\.corp\.local/.test(threw), threw);
eq   ('mailSent stays false',                ctxK.mailSent, false);
check('the report had already been built',   ctxK.reportHtml.length > 0);

// Exception handler: the built report must be recoverable from the transcript.
ctxK.errorCode = threw;
shim.runTask('EH_ExceptionHandler.js', ctxK, envK);
eq   ('handler sets outcome to ERROR', ctxK.outcome, 'ERROR');
check('handler writes the report into the transcript',
      envK.capture.log.some(l => l.indexOf('---BEGIN REPORT HTML---') !== -1) &&
      envK.capture.log.some(l => l.indexOf('<html>') === 0));
check('handler states no vCenter was modified',
      envK.capture.error.some(l => /read-only/.test(l)));

// Handler on an early failure, before anything was built.
const envL = shim.newEnv([]);
const ctxL = shim.newContext({ errorCode: 'No vCenter connections available.' });
shim.runTask('EH_ExceptionHandler.js', ctxL, envL);
eq   ('handler is safe with no state at all', ctxL.outcome, 'ERROR');
check('and says there is nothing to recover',
      envL.capture.warn.some(l => /nothing to\s+recover|nothing to recover/.test(l)));

// ═════════════════════════════════════════════════════════════════════════════
section('T-21  sendEmail=false builds the report and sends nothing');
// ═════════════════════════════════════════════════════════════════════════════
const envM = shim.newEnv(fx.buildEstate().all);
const ctxM = shim.newContext({ sendEmail: false });
shim.runWorkflow(ctxM, envM);
check('report produced', ctxM.reportHtml.length > 0);
eq   ('nothing sent',    envM.capture.sent.length, 0);
eq   ('mailSent false',  ctxM.mailSent, false);

// ═════════════════════════════════════════════════════════════════════════════
section('T-22  Every log line carries the [DATASTORE-REPORT] marker');
// ═════════════════════════════════════════════════════════════════════════════
const allLines = env.capture.log.concat(env.capture.warn, env.capture.error);
const strays = allLines.filter(l => l.indexOf('[DATASTORE-REPORT]') !== 0 &&
                                    l.indexOf('<html>') !== 0);
eq('no unmarked log lines', strays.length, 0, JSON.stringify(strays.slice(0, 3)));

// ═════════════════════════════════════════════════════════════════════════════
section('T-23  Legacy vs new — the delta the customer will see');
// ═════════════════════════════════════════════════════════════════════════════
// Legacy aborts on the full estate, so compare on the subset it can survive:
// vc01 + vc03 + vc04 (no zero-capacity, no faulting summary, no dead vCenter).
const estN = fx.buildEstate();
const survivable = [estN.vc01, estN.vc03, estN.vc04];
const envN = shim.newEnv(survivable);
const ctxN = shim.newContext({ vCenterConnections: survivable, sendEmail: false });
shim.runWorkflow(ctxN, envN);

const newRows = rowsOf(ctxN);
const newSet  = newRows.critical.concat(newRows.warning, newRows.advisory)
                       .map(r => r.vcenterName + '|' + r.name);
const legN    = fx.legacySelect(survivable);
const legSet  = legN.high.concat(legN.med, legN.low).map(r => r.vcenterName + '|' + r.name);

console.log('        legacy reported : ' + legSet.length + '  ' + JSON.stringify(legSet));
console.log('        new reports     : ' + newSet.length + '  ' + JSON.stringify(newSet));
const gained = newSet.filter(n => legSet.indexOf(n) === -1);
const lost   = legSet.filter(n => newSet.indexOf(n) === -1);
console.log('        newly visible   : ' + JSON.stringify(gained));
console.log('        no longer shown : ' + JSON.stringify(lost));

check('the new report is a strict superset of the legacy one', lost.length === 0,
      'unexpectedly dropped: ' + JSON.stringify(lost));
check('and it surfaces datastores the legacy report never showed', gained.length > 0);

// ═════════════════════════════════════════════════════════════════════════════
section('Sample reports');
// ═════════════════════════════════════════════════════════════════════════════
function write(file, html) {
    const p = path.join(__dirname, file);
    fs.writeFileSync(p, html, 'utf8');
    console.log('  wrote ' + file + '  (' + html.length + ' chars)');
}
write('Sample-Report-Full.html',        ctx.reportHtml);   // incl. unreachable vCenter
write('Sample-Report-NoFindings.html',  ctxI.reportHtml);
write('Sample-Report-Complete.html',    ctxN.reportHtml);  // all vCenters reachable
write('Sample-Report-Thresholds-95.html', ctxJ.reportHtml);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(64));
console.log('  PASSED: ' + pass + '    FAILED: ' + fail);
if (fail > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   - ' + f));
}
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
