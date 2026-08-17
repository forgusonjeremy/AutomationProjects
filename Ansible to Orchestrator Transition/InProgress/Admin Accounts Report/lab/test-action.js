// Harness for buildAdminAccountsReportInvocation.js — wraps the action body in a
// function with vRO's inputs as parameters and a System stub, mimicking vRO.
//
// Input model under test: the operator supplies a FLAT LIST OF OU DNs. The domain
// is DERIVED from each DN's DC= components and rows are grouped by it.
const fs = require('fs');
const path = require('path');
const ACTION = 'E:\\GitHub-LocalRepos\\AutomationProjects\\Ansible to Orchestrator Transition\\InProgress\\psscript\\Admin Accounts Report\\Code\\buildAdminAccountsReportInvocation.js';

const body = fs.readFileSync(ACTION, 'utf8');
let warns = [];
const System = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };

const run = new Function('System', 'scriptPath', 'domainOUs', 'emailReport', 'smtpServer', 'mailTo', 'mailCc', 'mailSubject', body);

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
    return JSON.parse(inv.match(/-DomainOUs '(.*?)' -eMailReport/)[1].replace(/''/g, "'"));
}

const SP = 'C:\\vRO-Scripts\\ps_scripts\\cvs_functions.ps1';
const TO = ['user1@corp.local', 'user2@corp.local'];
const CC = ['user5@corp.local'];
const SUBJ = 'Report: Admin PKI Card Status';

// Production scope: 7 domains x 2 OUs, as plain DNs — no domain column.
const rows = [];
for (let n = 1; n <= 7; n++) {
    rows.push(`OU=Admin Accounts,OU=Servers,DC=domain${n},DC=corp,DC=local`);
    rows.push(`OU=Admin Accounts,OU=Workstations,DC=domain${n},DC=corp,DC=local`);
}

console.log('\nT1 happy path (14 OU DNs spanning 7 domains)');
warns = [];
const inv = run(System, SP, rows, true, 'smtp.corp.local', TO, CC, SUBJ);
check('action -Action Get-AllAdmin-Accounts', inv.indexOf("-Action 'Get-AllAdmin-Accounts'") !== -1);
check('has -DomainOUs',                       inv.indexOf('-DomainOUs ') !== -1);
check('uses inline map, not -DomainOUsFile',  inv.indexOf('-DomainOUsFile') === -1);
check('eMailReport yes',                      inv.indexOf("-eMailReport 'yes'") !== -1);
check('mailTo joined csv',                    inv.indexOf("-MailToString 'user1@corp.local,user2@corp.local'") !== -1);
check('mailCc present',                       inv.indexOf("-MailCcString 'user5@corp.local'") !== -1);
check('subject passed',                       inv.indexOf("-MailSubjectstring 'Report: Admin PKI Card Status'") !== -1);
check('stream redirect appended',             inv.indexOf('*>&1 | Out-String -Width 4096') !== -1);
check('no spurious warnings',                 warns.length === 0);

const parsed = mapOf(inv);
check('JSON is valid',                        !!parsed);
check('domain DERIVED from DC= components',   Object.keys(parsed).indexOf('domain3.corp.local') !== -1);
check('7 domains grouped from 14 flat DNs',   Object.keys(parsed).length === 7);
check('each domain has its 2 OUs',            Object.keys(parsed).every(k => parsed[k].length === 2));
check('OU DN preserved verbatim',             parsed['domain3.corp.local'][0] === 'OU=Admin Accounts,OU=Servers,DC=domain3,DC=corp,DC=local');
fs.writeFileSync(path.join(__dirname, 'invocation.txt'), inv, 'utf8');

console.log('\nT2 single-domain list (the consolidated legacy job)');
warns = [];
const p2 = mapOf(run(System, SP, ['OU=Admin Accounts,OU=Servers,DC=only,DC=corp,DC=local'],
                     true, 'smtp.corp.local', TO, [], SUBJ));
check('one domain, one OU',                   Object.keys(p2).length === 1 && p2['only.corp.local'].length === 1);
check('single-OU run needs no special mode',  warns.length === 0);

console.log('\nT3 grouping, ordering, dedup, case');
warns = [];
const p3 = mapOf(run(System, SP, [
    'OU=X,DC=b,DC=corp,DC=local',
    'OU=Y,DC=a,DC=corp,DC=local',
    'OU=Z,DC=b,DC=corp,DC=local',
    'OU=x,DC=b,DC=corp,DC=local',          // dup of row 1, different case
    'OU=W,DC=B,DC=CORP,DC=LOCAL'           // same domain, different case
], false, '', [], [], SUBJ));
check('first-seen domain order kept',         JSON.stringify(Object.keys(p3)) === '["b.corp.local","a.corp.local"]');
check('case-insensitive domain grouping',     p3['b.corp.local'].length === 3);   // X, Z, W (x deduped)
check('duplicate OU dropped',                 warns.some(w => w.indexOf('duplicate OU') !== -1));

console.log('\nT4 escaping — exact round-trip of awkward DNs');
warns = [];
const awkward = [
    "OU=O'Brien Admins,DC=d,DC=corp,DC=local",        // apostrophe (PS single-quote hazard)
    'OU=Team "Alpha",DC=d,DC=corp,DC=local',          // literal double quotes (JSON hazard)
    'OU=Back\\Slash,DC=d,DC=corp,DC=local',           // literal backslash (JSON hazard)
    'OU=Comma\\, Escaped,DC=d,DC=corp,DC=local',      // DN-escaped comma
    'OU=Dollar$Var,DC=d,DC=corp,DC=local'             // $ (PS expansion hazard)
];
const p4 = mapOf(run(System, SP, awkward, false, '', [], [], SUBJ));
awkward.forEach((o, i) => check('exact round-trip: ' + o.substring(0, 24), p4['d.corp.local'][i] === o));
check('escaped comma did not split the DN',   p4['d.corp.local'].length === 5);
const invQ = run(System, SP, ["OU=O'Brien,DC=d,DC=corp,DC=local"], false, '', [], [], SUBJ);
check('apostrophe doubled for PowerShell',    invQ.indexOf("O''Brien") !== -1);

console.log('\nT5 validation failures');
expectThrow('empty scriptPath',  () => run(System, '', rows, false, '', [], [], SUBJ), 'scriptPath is required');
expectThrow('empty domainOUs',   () => run(System, SP, [], false, '', [], [], SUBJ), 'domainOUs is required');
expectThrow('not a DN',          () => run(System, SP, ['Admin Accounts'], false, '', [], [], SUBJ), "no 'DC=' component");
expectThrow('char-split array',  () => run(System, SP, ['O','U','=','x'], false, '', [], [], SUBJ), "no 'DC=' component");
expectThrow('empty server override', () => run(System, SP, ['|OU=x,DC=a,DC=b'], false, '', [], [], SUBJ), 'server is empty');
expectThrow('email w/o smtp',    () => run(System, SP, rows, true, '', TO, [], SUBJ), 'smtpServer is required');
expectThrow('email w/o mailTo',  () => run(System, SP, rows, true, 'smtp.corp.local', [], [], SUBJ), 'at least one recipient');
expectThrow('char-split mailTo', () => run(System, SP, rows, true, 'smtp.corp.local', ['u','s','e','r'], [], SUBJ), "no '@'");

console.log('\nT6 advisory warnings (proceed, do not fail)');
warns = [];
run(System, SP, ['DC=domain1,DC=corp,DC=local'], false, '', [], [], SUBJ);
check('domain-root scope warned',             warns.some(w => w.indexOf("no 'OU='") !== -1));
warns = [];
const pN = mapOf(run(System, SP, [
    'OU=Admin Accounts,DC=d,DC=corp,DC=local',
    'OU=Servers,OU=Admin Accounts,DC=d,DC=corp,DC=local'   // nested under the first
], false, '', [], [], SUBJ));
check('nested OUs warned (double-count)',     warns.some(w => w.indexOf('nested') !== -1));
check('nested OUs still both included',       pN['d.corp.local'].length === 2);
warns = [];
run(System, SP, rows, false, '', [], [], SUBJ);
check('emailReport=false warned',             warns.some(w => w.indexOf('will NOT be') !== -1));

console.log('\nT7 advanced server override');
warns = [];
const p7 = mapOf(run(System, SP, [
    'dc01.domain1.corp.local|OU=Admin Accounts,DC=domain1,DC=corp,DC=local'
], false, '', [], [], SUBJ));
check('override sets the server key',         Object.keys(p7)[0] === 'dc01.domain1.corp.local');
check('override mismatch warned',             warns.some(w => w.indexOf('does not match the DN') !== -1));

console.log('\nT8 CSV / newline string instead of Array (both forms accepted)');
warns = [];
const inv8 = run(System, SP, rows.join('\n'), true, 'smtp.corp.local', 'user1@corp.local,user2@corp.local', '', SUBJ);
check('newline-delimited string parses',      Object.keys(mapOf(inv8)).length === 7);
check('CSV mailTo parses',                    inv8.indexOf("-MailToString 'user1@corp.local,user2@corp.local'") !== -1);
check('empty mailCc allowed',                 inv8.indexOf("-MailCcString ''") !== -1);

console.log('\nT9 lab seeder alignment — New-AdminAccountTestData.ps1 output feeds this action');
// The seeder prints a domainOUs list for the operator to paste into the workflow.
// These assert the two stay compatible: if the seeder's OU layout or the action's
// validation changes independently, the lab run would fail at the appliance instead
// of here.
const base   = 'OU=LabAdminReport,DC=vcf,DC=lab';
const svrOU  = `OU=Admin Accounts,OU=Servers,${base}`;
const wksOU  = `OU=Admin Accounts,OU=Workstations,${base}`;
const nestOU = `OU=Tier0,${svrOU}`;

warns = [];
const seed1 = mapOf(run(System, SP, [svrOU, wksOU], true, 'smtp.vcf.lab', ['admin@vcf.lab'], [], SUBJ));
check('seeder default set accepted',      Object.keys(seed1).length === 1);
check('domain derived from seeder DNs',   Object.keys(seed1)[0] === 'vcf.lab');
check('both seeded OUs in scope',         seed1['vcf.lab'].length === 2);
check('2 OUs -> per-OU sub-sections',     seed1['vcf.lab'].length > 1);
check('clean seeder set warns nothing',   warns.length === 0);

warns = [];
const seed2 = mapOf(run(System, SP, [svrOU, wksOU, nestOU], false, '', [], [], SUBJ));
check('-IncludeNestedOU set accepted',    seed2['vcf.lab'].length === 3);
check('nesting warned before the run',    warns.some(w => w.indexOf('nested') !== -1));

// The documented "make it INCOMPLETE" trick must reach AD to fail, not be rejected here.
const seed3 = mapOf(run(System, SP, [svrOU, wksOU, `OU=Does Not Exist,${base}`], false, '', [], [], SUBJ));
check('bogus-OU demo reaches AD to fail', seed3['vcf.lab'].length === 3);

console.log('\n==========================');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);
