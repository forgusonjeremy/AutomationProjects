// Extract the (item6) Set Execution Context scriptable task from the spec and run it,
// so the documented code is verified rather than assumed.
const fs = require('fs');
const SPEC = 'E:\\GitHub-LocalRepos\\AutomationProjects\\Ansible to Orchestrator Transition\\InProgress\\psscript\\Admin Accounts Report\\Code\\Get-AdminAccountsReport_spec.js';
const src = fs.readFileSync(SPEC, 'utf8');

const start = src.indexOf('var ctxRows = (domainOUs');
const end   = src.indexOf('// Production example');
if (start === -1 || end === -1) { console.error('could not locate item6 block'); process.exit(1); }
const body = src.substring(start, end);

const run = new Function('domainOUs', body + '\nreturn executionContext;');

let pass = 0, fail = 0;
const check = (n, c, got) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + '   got: ' + got); fail++; } };

// Production scope: 7 domains x 2 OUs, plain DNs
const prod = [];
for (let n = 1; n <= 7; n++) {
    prod.push(`OU=Admin Accounts,OU=Servers,DC=domain${n},DC=corp,DC=local`);
    prod.push(`OU=Admin Accounts,OU=Workstations,DC=domain${n},DC=corp,DC=local`);
}
const r1 = run(prod);
console.log('\nProduction (7 domains x 2 OUs):\n  "' + r1 + '"');
check('counts 7 domains, not 14', r1.indexOf('7 domain(s)') === 0, r1);
check('counts 14 OUs',            r1.indexOf('14 OU(s)') !== -1, r1);
check('names real domains',       r1.indexOf('domain1.corp.local') !== -1, r1);
check('no raw DN leaked in',      r1.indexOf('OU=') === -1, r1);
check('bounded with +N more',     r1.indexOf('+4 more') !== -1, r1);
check('stays short (<110 chars)', r1.length < 110, r1.length);

// Single OU — the consolidated legacy job
const r2 = run(['OU=Admin Accounts,OU=Servers,DC=vcf,DC=lab']);
console.log('\nSingle OU:\n  "' + r2 + '"');
check('1 domain / 1 OU',          r2 === '1 domain(s), 1 OU(s): vcf.lab', r2);

// Lab seeder output
const r3 = run(['OU=Admin Accounts,OU=Servers,OU=LabAdminReport,DC=vcf,DC=lab',
                'OU=Admin Accounts,OU=Workstations,OU=LabAdminReport,DC=vcf,DC=lab']);
console.log('\nLab seeder scope:\n  "' + r3 + '"');
check('nested OUs still 1 domain', r3 === '1 domain(s), 2 OU(s): vcf.lab', r3);

// Server-override form
const r4 = run(['dc01.vcf.lab|OU=Admin Accounts,DC=vcf,DC=lab']);
console.log('\nServer override:\n  "' + r4 + '"');
check('override uses the server',  r4.indexOf('dc01.vcf.lab') !== -1, r4);

// Edge cases — must not throw
const r5 = run([]);
console.log('\nEmpty scope:\n  "' + r5 + '"');
check('empty scope handled',       r5.indexOf('no scope supplied') !== -1, r5);
check('null handled',              run(null).indexOf('no scope supplied') !== -1, run(null));
const r6 = run('OU=A,DC=x,DC=y\nOU=B,DC=x,DC=y');
console.log('\nNewline string form:\n  "' + r6 + '"');
check('string form parses',        r6 === '1 domain(s), 2 OU(s): x.y', r6);
const r7 = run(['not-a-dn']);
check('undeterminable domain safe', r7.indexOf('(undetermined)') !== -1, r7);

// ES5 / Rhino compatibility — vRO's engine has no let/const/arrow functions
check('no let/const/arrow in body', !/\b(let|const)\s|=>/.test(body), 'ES5 violation');

console.log('\n==========================');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);
