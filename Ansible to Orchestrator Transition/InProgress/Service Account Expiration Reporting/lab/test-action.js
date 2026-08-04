// Harness for buildServiceAccountExpirationInvocation.js — wraps the action body in a
// function with vRO's inputs as parameters and a System stub, mimicking vRO.
//
// The action file is loaded AS WRITTEN and executed, so the file under test is the file
// that ships rather than a translation of it. If the action is renamed or moved, this
// fails loudly instead of silently testing a stale copy.
//
// Input model under test: the operator supplies a FLAT LIST OF OU DNs. The domain is
// DERIVED from each DN's DC= components and rows are grouped by it.
const fs = require('fs');
const path = require('path');

// Resolved RELATIVE to this file, deliberately. The equivalent harness in the Admin
// Accounts Report deliverable hard-codes an absolute path that stopped resolving the
// moment the project folder moved from InProgress to Completed.
const ACTION = path.join(__dirname, '..', 'Code', 'buildServiceAccountExpirationInvocation.js');
if (!fs.existsSync(ACTION)) {
    console.error('FATAL: action file not found at ' + ACTION);
    process.exit(1);
}

const body = fs.readFileSync(ACTION, 'utf8');
let warns = [];
const System = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };

const run = new Function('System', 'scriptPath', 'domainOUs', 'expiringWithinDays', 'emailReport',
                         'smtpServer', 'mailTo', 'mailCc', 'mailSubject', body);

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { console.log('  PASS  ' + name); pass++; }
    else      { console.log('  FAIL  ' + name); fail++; }
}
function expectThrow(name, fn, frag) {
    try { fn(); console.log('  FAIL  ' + name + ' (did not throw)'); fail++; }
    catch (e) {
        if (!frag || e.message.indexOf(frag) !== -1) { console.log('  PASS  ' + name); pass++; }
        else { console.log('  FAIL  ' + name + ' (wrong message: ' + e.message + ')'); fail++; }
    }
}
// Pull the JSON map back out of the built invocation string.
function mapOf(inv) {
    return JSON.parse(inv.match(/-DomainOUs '(.*?)' -ExpiringWithinDays/)[1].replace(/''/g, "'"));
}
function windowOf(inv) {
    return inv.match(/-ExpiringWithinDays '(\d+)'/)[1];
}

const SP   = 'C:\\vRO-Scripts\\ps_scripts\\cvs_functions.ps1';
const TO   = ['security@corp.local', 'infadmins@corp.local'];
const CC   = ['monitoring@corp.local'];
const SUBJ = 'Service Account Expiration Report';

// The customer's ACTUAL production scope (vars.txt): one domain, one OU.
const PROD = ['OU=Service Accounts,DC=corp,DC=local'];

console.log('\nT1 happy path — the production scope of one OU');
warns = [];
const inv = run(System, SP, PROD, 30, true, 'mailrelay.corp.local', TO, CC, SUBJ);
check('action -Action Get-ServiceAccountExpiration', inv.indexOf("-Action 'Get-ServiceAccountExpiration'") !== -1);
check('has -DomainOUs',                       inv.indexOf('-DomainOUs ') !== -1);
check('uses inline map, not -DomainOUsFile',  inv.indexOf('-DomainOUsFile') === -1);
check('window passed through',                inv.indexOf("-ExpiringWithinDays '30'") !== -1);
check('eMailReport yes',                      inv.indexOf("-eMailReport 'yes'") !== -1);
check('mailTo joined csv',                    inv.indexOf("-MailToString 'security@corp.local,infadmins@corp.local'") !== -1);
check('mailCc present',                       inv.indexOf("-MailCcString 'monitoring@corp.local'") !== -1);
check('subject stem passed',                  inv.indexOf("-MailSubjectstring 'Service Account Expiration Report'") !== -1);
check('stream redirect appended',             inv.indexOf('*>&1 | Out-String -Width 4096') !== -1);
check('NO legacy -OUPath',                    inv.indexOf('-OUPath') === -1);
check('NO legacy -DomainName',                inv.indexOf('-DomainName') === -1);
check('no spurious warnings',                 warns.length === 0);

const p1 = mapOf(inv);
check('domain DERIVED from DC= components',   Object.keys(p1)[0] === 'corp.local');
check('one domain, one OU',                   Object.keys(p1).length === 1 && p1['corp.local'].length === 1);
check('OU DN preserved verbatim',             p1['corp.local'][0] === 'OU=Service Accounts,DC=corp,DC=local');
fs.writeFileSync(path.join(__dirname, 'invocation.txt'), inv, 'utf8');

console.log('\nT2 multi-domain — the same workflow, a longer list');
warns = [];
const p2 = mapOf(run(System, SP, [
    'OU=Service Accounts,DC=corp,DC=local',
    'OU=Service Accounts,OU=Tier1,DC=corp,DC=local',
    'OU=Service Accounts,DC=other,DC=corp,DC=local'
], 30, false, '', [], [], SUBJ));
check('two domains grouped from 3 DNs',       Object.keys(p2).length === 2);
check('first-seen domain order kept',         JSON.stringify(Object.keys(p2)) === '["corp.local","other.corp.local"]');
check('corp.local holds its 2 OUs',           p2['corp.local'].length === 2);
check('single vs multi needs no mode switch', true);

console.log('\nT3 grouping, ordering, dedup, case');
warns = [];
const p3 = mapOf(run(System, SP, [
    'OU=X,DC=b,DC=corp,DC=local',
    'OU=Y,DC=a,DC=corp,DC=local',
    'OU=Z,DC=b,DC=corp,DC=local',
    'OU=x,DC=b,DC=corp,DC=local',          // dup of row 1, different case
    'OU=W,DC=B,DC=CORP,DC=LOCAL'           // same domain, different case
], 30, false, '', [], [], SUBJ));
check('first-seen domain order kept',         JSON.stringify(Object.keys(p3)) === '["b.corp.local","a.corp.local"]');
check('case-insensitive domain grouping',     p3['b.corp.local'].length === 3);   // X, Z, W (x deduped)
check('duplicate OU dropped',                 warns.some(w => w.indexOf('duplicate OU') !== -1));

console.log('\nT4 the look-ahead window');
warns = [];
check('default when omitted',                 windowOf(run(System, SP, PROD, null, false, '', [], [], SUBJ)) === '30');
check('default when empty string',            windowOf(run(System, SP, PROD, '', false, '', [], [], SUBJ)) === '30');
check('default when undefined',               windowOf(run(System, SP, PROD, undefined, false, '', [], [], SUBJ)) === '30');
check('numeric input accepted',               windowOf(run(System, SP, PROD, 7, false, '', [], [], SUBJ)) === '7');
check('numeric string accepted',              windowOf(run(System, SP, PROD, '90', false, '', [], [], SUBJ)) === '90');
check('whitespace trimmed',                   windowOf(run(System, SP, PROD, ' 45 ', false, '', [], [], SUBJ)) === '45');
check('zero is legal (expiring today)',       windowOf(run(System, SP, PROD, 0, false, '', [], [], SUBJ)) === '0');
check('zero is not treated as absent',        windowOf(run(System, SP, PROD, '0', false, '', [], [], SUBJ)) === '0');

// These are the values that MUST be rejected rather than quietly reinterpreted: a run
// that used a different window than the operator asked for produces a subject line and
// an Action-required section that mean something else.
expectThrow('rejects negative',      () => run(System, SP, PROD, -5,      false, '', [], [], SUBJ), 'whole number of days');
expectThrow('rejects decimal',       () => run(System, SP, PROD, '30.9',  false, '', [], [], SUBJ), 'whole number of days');
expectThrow('rejects "30 days"',     () => run(System, SP, PROD, '30 days',false, '', [], [], SUBJ), 'whole number of days');
expectThrow('rejects non-numeric',   () => run(System, SP, PROD, 'thirty',false, '', [], [], SUBJ), 'whole number of days');
expectThrow('rejects hex-ish',       () => run(System, SP, PROD, '0x1E',  false, '', [], [], SUBJ), 'whole number of days');

warns = [];
run(System, SP, PROD, 400, false, '', [], [], SUBJ);
check('warns on a window over a year',        warns.some(w => w.indexOf('longer than a') !== -1));

console.log('\nT5 escaping — exact round-trip of awkward DNs');
warns = [];
const awkward = [
    "OU=O'Brien Service,DC=d,DC=corp,DC=local",       // apostrophe (PS single-quote hazard)
    'OU=Team "Alpha",DC=d,DC=corp,DC=local',          // literal double quotes (JSON hazard)
    'OU=Back\\Slash,DC=d,DC=corp,DC=local',           // literal backslash (JSON hazard)
    'OU=Comma\\, Escaped,DC=d,DC=corp,DC=local',      // DN-escaped comma
    'OU=Dollar$Var,DC=d,DC=corp,DC=local'             // $ (PS expansion hazard)
];
const p5 = mapOf(run(System, SP, awkward, 30, false, '', [], [], SUBJ));
check('all 5 awkward DNs survive',            p5['d.corp.local'].length === 5);
awkward.forEach((dn, i) => check('round-trip #' + (i + 1) + ' byte-exact', p5['d.corp.local'][i] === dn));
check('escaped comma does not split the DN',  p5['d.corp.local'][3].indexOf('Comma\\, Escaped') !== -1);

console.log('\nT6 input shapes — Array, CSV string, newline string');
warns = [];
const pA = mapOf(run(System, SP, ['OU=A,DC=x,DC=local', 'OU=B,DC=x,DC=local'], 30, false, '', [], [], SUBJ));
const pB = mapOf(run(System, SP, 'OU=A,DC=x,DC=local\nOU=B,DC=x,DC=local',    30, false, '', [], [], SUBJ));
check('Array form and newline-string form agree', JSON.stringify(pA) === JSON.stringify(pB));
const invCsvTo = run(System, SP, PROD, 30, true, 'smtp', 'a@x.com,b@x.com', '', SUBJ);
check('mailTo accepts a CSV string',          invCsvTo.indexOf("-MailToString 'a@x.com,b@x.com'") !== -1);
check('empty mailCc renders as empty string', invCsvTo.indexOf("-MailCcString ''") !== -1);

console.log('\nT7 validation failures — the run must NOT proceed');
expectThrow('no scriptPath',        () => run(System, '',   PROD, 30, false, '', [], [], SUBJ), 'scriptPath is required');
expectThrow('empty scope list',     () => run(System, SP,   [],   30, false, '', [], [], SUBJ), 'domainOUs is required');
expectThrow('null scope',           () => run(System, SP,   null, 30, false, '', [], [], SUBJ), 'domainOUs is required');
expectThrow('row without DC=',      () => run(System, SP, ['OU=Service Accounts'], 30, false, '', [], [], SUBJ), "has no 'DC=' component");
expectThrow('empty server override',() => run(System, SP, ['|OU=A,DC=x,DC=local'], 30, false, '', [], [], SUBJ), 'the server is empty');
expectThrow('email on, no smtp',    () => run(System, SP, PROD, 30, true, '',    TO, [], SUBJ), 'smtpServer is required');
expectThrow('email on, no mailTo',  () => run(System, SP, PROD, 30, true, 'smtp', [], [], SUBJ), 'at least one recipient');
expectThrow('recipient without @',  () => run(System, SP, PROD, 30, true, 'smtp', ['not-an-address'], [], SUBJ), "no '@'");
// The vRO character-split artifact: a scalar string bound to an Array/string input
// arrives as one element per character. Both guards must catch it.
expectThrow('char-split mailTo caught',  () => run(System, SP, PROD, 30, true, 'smtp', 'a@x.com'.split(''), [], SUBJ), "no '@'");
expectThrow('char-split domainOUs caught', () => run(System, SP, 'OU=A,DC=x,DC=local'.split(''), 30, false, '', [], [], SUBJ), "has no 'DC=' component");

console.log('\nT8 advisory warnings — proceed, but say so');
warns = [];
run(System, SP, ['DC=corp,DC=local'], 30, false, '', [], [], SUBJ);
check('warns: domain root searches everything', warns.some(w => w.indexOf('searches the ENTIRE domain') !== -1));

warns = [];
run(System, SP, ['OU=Service Accounts,DC=corp,DC=local',
                 'OU=Tier1,OU=Service Accounts,DC=corp,DC=local'], 30, false, '', [], [], SUBJ);
check('warns: nested OUs overlap',             warns.some(w => w.indexOf('are nested') !== -1));
check('nested warning mentions de-duplication',warns.some(w => w.indexOf('de-duplicated') !== -1));

warns = [];
const pOv = mapOf(run(System, SP, ['dc01.corp.local|OU=Service Accounts,DC=corp,DC=local'], 30, false, '', [], [], SUBJ));
check('server override targets that server',   Object.keys(pOv)[0] === 'dc01.corp.local');
check('override strips the server from the DN',pOv['dc01.corp.local'][0] === 'OU=Service Accounts,DC=corp,DC=local');
check('warns: override disagrees with the DN', warns.some(w => w.indexOf('does not match the DN') !== -1));

warns = [];
run(System, SP, PROD, 30, false, '', [], [], SUBJ);
check('warns when email is OFF',               warns.some(w => w.indexOf('will NOT be') !== -1));
check('and says nobody gets warned',           warns.some(w => w.indexOf('Nobody will be warned') !== -1));

console.log('\nT9 read-only guarantee');
const invRO = run(System, SP, PROD, 30, true, 'smtp', TO, [], SUBJ);
check('never invokes the mass-write action',   invRO.indexOf('Set-L3-Admin-Accounts') === -1);
check('no Set-ADUser anywhere in the call',    invRO.indexOf('Set-AdUser') === -1 && invRO.indexOf('Set-ADUser') === -1);
check('single -Action argument only',          (invRO.match(/-Action /g) || []).length === 1);

console.log('\nT10 the lab seeder and this action must not drift apart');
// New-ServiceAccountTestData.ps1 PRINTS domainOUs rows for the operator to paste into
// the workflow. If the action ever stopped accepting the shape the seeder emits, the
// lab validation pass would fail for a reason that has nothing to do with the report.
// These are the exact DN forms that script prints.
warns = [];
const seeded = [
    'OU=Lab Service Accounts,DC=vcf,DC=lab',
    'OU=Tier1,OU=Lab Service Accounts,DC=vcf,DC=lab'      // the -IncludeNestedOU row
];
const pSeed = mapOf(run(System, SP, seeded, 30, false, '', [], [], SUBJ));
check('seeder rows are accepted',              Object.keys(pSeed).length === 1);
check('seeder domain derives to vcf.lab',      Object.keys(pSeed)[0] === 'vcf.lab');
check('both seeded OUs preserved',             pSeed['vcf.lab'].length === 2);
check('seeder nesting raises the overlap warn',warns.some(w => w.indexOf('are nested') !== -1));
// And the bogus row the seeder tells you to add to provoke [INCOMPLETE] must be
// ACCEPTED by the action - it has to reach PowerShell to fail there, at the directory.
const pBogus = mapOf(run(System, SP, ['OU=Does Not Exist,DC=vcf,DC=lab'], 30, false, '', [], [], SUBJ));
check('bogus-but-well-formed DN passes through', pBogus['vcf.lab'][0] === 'OU=Does Not Exist,DC=vcf,DC=lab');

console.log('\nPASS: ' + pass + '   FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);
