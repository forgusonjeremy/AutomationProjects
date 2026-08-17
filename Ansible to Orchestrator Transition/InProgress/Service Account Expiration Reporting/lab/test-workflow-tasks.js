// Tests the SCRIPTABLE TASK code inside Get-ServiceAccountExpirationReport_spec.js.
//
// The task code in the spec is not documentation - it is the code that gets pasted into
// the vRO schema elements. This harness EXTRACTS it from the spec file and EXECUTES it,
// so the file that ships to the appliance is the file under test. A spec whose task
// code has quietly diverged from what was tested is the failure mode this prevents.
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'Code', 'Get-ServiceAccountExpirationReport_spec.js');
if (!fs.existsSync(SPEC)) {
    console.error('FATAL: spec file not found at ' + SPEC);
    process.exit(1);
}
const spec = fs.readFileSync(SPEC, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { console.log('  PASS  ' + name); pass++; }
    else      { console.log('  FAIL  ' + name); fail++; }
}

// Pull one task's body out of the spec by its banner comment, up to the next banner.
//
// The banner line continues past the marker with box-drawing rule characters, so the
// REMAINDER OF THAT LINE is discarded too - otherwise the extracted text starts with
// "────────" sitting outside any comment, which is not valid JavaScript.
function extractTask(marker) {
    const start = spec.indexOf(marker);
    if (start === -1) { return null; }
    let rest = spec.substring(start + marker.length);
    const nl = rest.indexOf('\n');
    rest = (nl === -1 ? '' : rest.substring(nl + 1));
    const end = rest.indexOf('// ── (item');
    return (end === -1 ? rest : rest.substring(0, end));
}

console.log('\nW1 the spec still contains the tasks it claims to');
const item6  = extractTask('// ── (item6) Set Execution Context');
const item10 = extractTask('// ── (item10) Set Log Marker');
const item11 = extractTask('// ── (item11) Log Success');
const item9  = extractTask('// ── (item9) Log Failures');
check('(item6) Set Execution Context found', item6  !== null);
check('(item10) Set Log Marker found',       item10 !== null);
check('(item11) Log Success found',          item11 !== null);
check('(item9) Log Failures found',          item9  !== null);

console.log('\nW2 ES5/Rhino compatibility — vRO has no let/const/arrow functions');
// vRO's JavaScript engine is ES5. `let`, `const`, arrow functions and template literals
// fail AT RUNTIME inside the appliance, where the only symptom is a workflow that
// faults on a line that looks perfectly valid in a modern editor.
const allTasks = [item6, item10, item11, item9].filter(Boolean).join('\n');
check('no let declarations',          !/(^|[^\w.])let\s+\w/.test(allTasks));
check('no const declarations',        !/(^|[^\w.])const\s+\w/.test(allTasks));
check('no arrow functions',           !/=>/.test(allTasks));
check('no template literals',         allTasks.indexOf('`') === -1);
check('no Array.prototype.includes',  allTasks.indexOf('.includes(') === -1);

console.log('\nW3 (item6) Set Execution Context — behaviour');
// Executed exactly as vRO would: inputs in, attribute out.
function runItem6(domainOUs, expiringWithinDays) {
    const fn = new Function('domainOUs', 'expiringWithinDays',
        'var executionContext; ' + item6 + '; return executionContext;');
    return fn(domainOUs, expiringWithinDays);
}

const prod = runItem6(['OU=Service Accounts,DC=corp,DC=local'], 30);
check('production scope summarised',  prod === '1 domain(s), 1 OU(s): corp.local | window 30d');

const multi = runItem6([
    'OU=Service Accounts,DC=corp,DC=local',
    'OU=Tier1,DC=corp,DC=local',
    'OU=Svc,DC=other,DC=local'
], 45);
check('counts domains, not rows',     multi.indexOf('2 domain(s), 3 OU(s)') === 0);
check('names both domains',           multi.indexOf('corp.local, other.local') !== -1);
check('carries the window',           multi.indexOf('window 45d') !== -1);

// The domain must be DERIVED, exactly as the action derives it. Treating each DN as a
// domain name would report one "domain" per OU and dump whole DNs into every log line.
check('domain derived, not the DN',   prod.indexOf('OU=') === -1);

const escaped = runItem6(['OU=Comma\\, Escaped,DC=d\\,x,DC=corp,DC=local'], 30);
check('DN escaping handled',          escaped.indexOf('d,x.corp.local') !== -1);

const override = runItem6(['dc01.corp.local|OU=Service Accounts,DC=corp,DC=local'], 30);
check('server override respected',    override.indexOf('dc01.corp.local') !== -1);

console.log('\nW4 (item6) — bounded output');
// The context is prepended to several parse lines. It must not grow with the scope.
const many = [];
for (let i = 1; i <= 12; i++) { many.push('OU=Svc,DC=domain' + i + ',DC=corp,DC=local'); }
const big = runItem6(many, 30);
check('names at most three domains',  (big.match(/corp\.local/g) || []).length <= 3);
check('summarises the rest as +N',    big.indexOf('+9 more') !== -1);
check('stays short',                  big.length < 140);

console.log('\nW5 (item6) — empty and odd inputs must not throw');
check('null scope',                   runItem6(null, 30).indexOf('(no scope supplied)') !== -1);
check('undefined scope',              runItem6(undefined, 30).indexOf('(no scope supplied)') !== -1);
check('empty array',                  runItem6([], 30).indexOf('(no scope supplied)') !== -1);
check('blank rows ignored',           runItem6(['', '   ', 'OU=A,DC=x,DC=local'], 30).indexOf('1 OU(s)') !== -1);
check('newline-string form',          runItem6('OU=A,DC=x,DC=local\nOU=B,DC=y,DC=local', 30).indexOf('2 domain(s), 2 OU(s)') === 0);
check('DN with no DC= is flagged',    runItem6(['OU=Nope'], 30).indexOf('(undetermined)') !== -1);
check('null window defaults to 30',   runItem6(['OU=A,DC=x,DC=local'], null).indexOf('window 30d') !== -1);
check('empty window defaults to 30',  runItem6(['OU=A,DC=x,DC=local'], '').indexOf('window 30d') !== -1);
check('window 0 is NOT treated as unset', runItem6(['OU=A,DC=x,DC=local'], 0).indexOf('window 0d') !== -1);

console.log('\nW6 the spec documents the contract it must');
// These are the facts an operator or a future maintainer must not have to rediscover.
check('states it is READ-ONLY',       /NOTHING IS EVER MODIFIED/.test(spec));
check('warns output will differ',     /WHY THE OUTPUT WILL NOT MATCH THE OLD REPORT/.test(spec));
check('explains the silent -SC filter',/SmartcardLogonRequired was False/.test(spec));
check('has a failure-handling contract',/FAILURE-HANDLING CONTRACT/.test(spec));
check('tells you to match window to schedule',/MATCH THE WINDOW TO THE SCHEDULE/.test(spec));
check('records the workflow ID as TBD',/Workflow ID : \(TBD/.test(spec));

console.log('\nPASS: ' + pass + '   FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);
