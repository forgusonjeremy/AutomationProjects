const fs = require('fs');
const path = require('path');
const ACTION = 'E:\\GitHub-LocalRepos\\AutomationProjects\\Ansible to Orchestrator Transition\\InProgress\\psscript\\Admin Accounts Report\\Code\\buildAdminAccountsReportInvocation.js';
const body = fs.readFileSync(ACTION, 'utf8');
const System = { log: () => {}, warn: () => {}, error: () => {} };
const run = new Function('System', 'scriptPath', 'domainOUs', 'emailReport', 'smtpServer', 'mailTo', 'mailCc', 'mailSubject', body);

const awkward = [
    "OU=O'Brien Admins,DC=d,DC=corp,DC=local",   // apostrophe -> PS single-quote hazard
    'OU=Team "Alpha",DC=d,DC=corp,DC=local',     // double quotes -> JSON hazard
    'OU=Back\\Slash,DC=d,DC=corp,DC=local',      // backslash -> JSON hazard
    'OU=Comma\\, Escaped,DC=d,DC=corp,DC=local', // DN-escaped comma
    'OU=Dollar$Var,DC=d,DC=corp,DC=local'        // $ -> PS expansion hazard
];

// Plain OU DNs — the domain (d.corp.local) is DERIVED from each DN's DC= components.
const inv = run(System, 'C:\\ps\\cvs_functions.ps1', awkward, false, '', [], [], 's');
fs.writeFileSync(path.join(__dirname, 'invocation-awkward.txt'), inv, 'utf8');
console.log('wrote invocation-awkward.txt (' + inv.length + ' chars)');
