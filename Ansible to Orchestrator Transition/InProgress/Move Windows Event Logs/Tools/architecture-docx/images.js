'use strict';
const path = require('path');
const DOCS = path.join(
  'C:', 'Users', 'forgusonjw', 'Documents', 'GitHubRepos', 'AutomationProjects',
  'Ansible to Orchestrator Transition', 'InProgress', 'Move Windows Event Logs',
  '_Shared', 'Documentation');

module.exports = {
  whole: {
    id: 1, rid: 'rId10', file: 'figure1.png',
    src: path.join(DOCS, '05_Architecture-Figure1.png'),
    w: 2720, h: 1400,
    alt: 'Scripts and actions travel from the GitLab repository down into Orchestrator, ' +
         'manually today and by pipeline in future. At run time Orchestrator queries Active ' +
         'Directory through its plug-in for the servers in a group, then runs a PowerShell ' +
         'script on a PowerShell host, which reaches the target servers and the archive share ' +
         'over UNC across a Kerberos delegation boundary.',
  },
  delivery: {
    id: 2, rid: 'rId11', file: 'figure2.png',
    src: path.join(DOCS, '05_Architecture-Figure2.png'),
    w: 2320, h: 620,
    alt: 'Code moves from the GitLab repository into Orchestrator, by hand today and by a ' +
         'GitLab CI pipeline calling the Orchestrator REST API in the planned future state.',
  },
};
