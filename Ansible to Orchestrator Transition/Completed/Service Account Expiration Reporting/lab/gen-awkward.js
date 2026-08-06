// Writes the invocation-string fixtures that Test-Boundary.ps1 EXECUTES.
//
// These are not hand-written strings: they are produced by the real action, so the
// boundary test exercises the exact escaping the shipping code emits.
const fs = require('fs');
const path = require('path');

const ACTION = path.join(__dirname, '..', 'Code', 'buildServiceAccountExpirationInvocation.js');
if (!fs.existsSync(ACTION)) {
    console.error('FATAL: action file not found at ' + ACTION);
    process.exit(1);
}
const body = fs.readFileSync(ACTION, 'utf8');
const System = { log: () => {}, warn: () => {}, error: () => {} };
const run = new Function('System', 'scriptPath', 'domainOUs', 'expiringWithinDays', 'emailReport',
                         'smtpServer', 'mailTo', 'mailCc', 'mailSubject', body);

const awkward = [
    "OU=O'Brien Service,DC=d,DC=corp,DC=local",  // apostrophe -> PS single-quote hazard
    'OU=Team "Alpha",DC=d,DC=corp,DC=local',     // double quotes -> JSON hazard
    'OU=Back\\Slash,DC=d,DC=corp,DC=local',      // backslash -> JSON hazard
    'OU=Comma\\, Escaped,DC=d,DC=corp,DC=local', // DN-escaped comma
    'OU=Dollar$Var,DC=d,DC=corp,DC=local'        // $ -> PS expansion hazard
];

// Plain OU DNs — the domain (d.corp.local) is DERIVED from each DN's DC= components.
const inv = run(System, 'C:\\ps\\cvs_functions.ps1', awkward, 30, false, '', [], [], 's');
fs.writeFileSync(path.join(__dirname, 'invocation-awkward.txt'), inv, 'utf8');
console.log('wrote invocation-awkward.txt (' + inv.length + ' chars)');

// A subject line containing an apostrophe: the one PowerShell-quoting hazard in the
// mail arguments, and easy to hit for real ("Corp's service accounts").
const inv2 = run(System, 'C:\\ps\\cvs_functions.ps1',
                 ['OU=Service Accounts,DC=corp,DC=local'], 45, true, 'mailrelay.corp.local',
                 ["o'brien@corp.local"], [], "Corp's Service Account Expiry: don't ignore");
fs.writeFileSync(path.join(__dirname, 'invocation-quotes.txt'), inv2, 'utf8');
console.log('wrote invocation-quotes.txt (' + inv2.length + ' chars)');
