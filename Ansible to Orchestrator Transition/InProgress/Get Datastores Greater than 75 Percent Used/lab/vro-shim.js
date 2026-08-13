// ─────────────────────────────────────────────────────────────────────────────
// vRO SHIM
// Runs the real, unmodified action and scriptable-task source from ../Code
// under Node, so the logic can be exercised and asserted before it is ever
// imported into an Orchestrator appliance.
//
// Nothing in ../Code is edited or copied for testing. Each file is read from
// disk and evaluated exactly as shipped:
//   - ACTIONS use `return`, so they are wrapped as a function whose parameters
//     are the action's declared inputs. This is how vRO invokes an action.
//   - SCRIPTABLE TASKS read and assign bare identifiers, which in vRO are
//     workflow attributes. They are evaluated inside `with (ctx)` against a
//     pre-seeded context object, which is how vRO binds attributes.
//
// If a task ever assigns an attribute that was not declared in the workflow,
// the pre-seeding requirement here surfaces it as a ReferenceError rather than
// letting it silently become a global — the same class of mistake vRO would
// otherwise hide until runtime.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const path = require('path');

const CODE_DIR = path.join(__dirname, '..', 'Code');

// ── System / plug-in stubs ───────────────────────────────────────────────────
function makeSystem(capture) {
    return {
        log:   (m) => { capture.log.push(String(m)); },
        warn:  (m) => { capture.warn.push(String(m)); },
        error: (m) => { capture.error.push(String(m)); },
        sleep: () => {},
        getModule: (name) => {
            if (!capture.modules[name]) {
                throw new Error('System.getModule: unknown module ' + name);
            }
            return capture.modules[name];
        }
    };
}

// vRO's Mail plug-in object. Records what would have been sent, and can be told
// to fail so the delivery-failure path is testable.
function makeEmailMessageClass(capture) {
    return function EmailMessage() {
        this.smtpHost = null; this.smtpPort = null;
        this.useSsl = false;  this.useStartTls = false;
        this.username = null; this.password = null;
        this.fromAddress = null; this.fromName = null;
        this.toAddress = null; this.ccAddress = null;
        this.subject = null;
        this._parts = [];
        this.addMimePart = function (content, mime) {
            this._parts.push({ content: content, mime: mime });
        };
        this.sendMessage = function () {
            if (capture.smtpShouldFail) {
                throw new Error(capture.smtpFailMessage || 'Connection refused');
            }
            capture.sent.push({
                smtpHost: this.smtpHost, smtpPort: this.smtpPort,
                useSsl: this.useSsl, username: this.username,
                fromAddress: this.fromAddress, fromName: this.fromName,
                toAddress: this.toAddress, ccAddress: this.ccAddress,
                subject: this.subject, parts: this._parts
            });
        };
    };
}

// ── Environment ──────────────────────────────────────────────────────────────
function newEnv(sdkConnections) {
    const capture = {
        log: [], warn: [], error: [], sent: [],
        modules: {},
        smtpShouldFail: false,
        smtpFailMessage: null
    };
    const System = makeSystem(capture);
    const EmailMessage = makeEmailMessageClass(capture);
    const VcPlugin = { allSdkConnections: sdkConnections || [] };

    // The module namespace the workflow calls into. Both actions are registered
    // under the real package name so System.getModule(...) resolves exactly as
    // it will on the appliance.
    capture.modules['com.broadcom.pso.vc.storage.reporting'] = {
        getDatastoreCapacity: (conn, minPct, incInacc) =>
            runAction('getDatastoreCapacity.js',
                      ['vcenterSdkConnection', 'minPercentUsed', 'includeInaccessible'],
                      [conn, minPct, incInacc], System),
        buildDatastoreReportHtml: (banded, failures, skipped, summary) =>
            runAction('buildDatastoreReportHtml.js',
                      ['bandedJson', 'failuresJson', 'skippedJson', 'scanSummaryJson'],
                      [banded, failures, skipped, summary], System)
    };

    return { System, VcPlugin, EmailMessage, capture };
}

// ── Loaders ──────────────────────────────────────────────────────────────────
function readCode(file) {
    return fs.readFileSync(path.join(CODE_DIR, file), 'utf8');
}

function runAction(file, paramNames, paramValues, System) {
    const body = readCode(file);
    const fn = new Function('System', ...paramNames, body);
    return fn(System, ...paramValues);
}

// Evaluate a scriptable task against a workflow context. Every attribute the
// task may read or write must already exist on ctx — see the note at the top.
function runTask(file, ctx, env) {
    const body = readCode(file);
    const fn = new Function('ctx', 'System', 'VcPlugin', 'EmailMessage',
                            'with (ctx) {\n' + body + '\n}');
    fn(ctx, env.System, env.VcPlugin, env.EmailMessage);
    return ctx;
}

// Every workflow attribute and input, pre-seeded. Mirrors the ATTRIBUTES and
// INPUTS sections of Get-DatastoreCapacityReport_spec.js.
function newContext(overrides) {
    const ctx = {
        // inputs
        vCenterConnections: [],
        thresholdHighPct: 90,
        bandWidthPct: 10,
        includeInaccessible: false,
        sendEmail: true,
        smtpHost: 'mailrelay.corp.local',
        smtpPort: 25,
        smtpUseSsl: false,
        smtpUsername: '',
        smtpPassword: '',
        mailFrom: 'vro_Do_Not_Reply@vcf.lab',
        mailTo: ['On-PremEngineering@corp.local'],
        mailCc: ['Monitoring@corp.local'],
        mailSubjectPrefix: 'VCF-Orchestrator-Report: Datastore Report',
        // attributes
        runId: '',
        startedAtIso: '',
        targetConnections: [],
        collectedJson: '',
        failuresJson: '',
        skippedJson: '',
        scanSummaryJson: '',
        bandedJson: '',
        mailSubject: '',
        mailSent: false,
        // outputs
        reportHtml: '',
        outcome: '',
        criticalCount: 0,
        warningCount: 0,
        advisoryCount: 0,
        // exception-handler binding
        errorCode: ''
    };
    return Object.assign(ctx, overrides || {});
}

// Runs ST-01 .. ST-06 in schema order, including the sendEmail decision branch.
function runWorkflow(ctx, env) {
    runTask('ST-01_InitialiseRun.js',    ctx, env);
    runTask('ST-02_CollectDatastores.js', ctx, env);
    runTask('ST-03_BandAndSort.js',       ctx, env);
    runTask('ST-04_BuildReport.js',       ctx, env);
    if (ctx.sendEmail === true) {
        runTask('ST-05_SendReport.js',    ctx, env);
    }
    runTask('ST-06_Finalise.js',          ctx, env);
    return ctx;
}

module.exports = { newEnv, newContext, runAction, runTask, runWorkflow, CODE_DIR };
