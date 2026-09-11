'use strict';
const path = require('path');
const engine = require('./engine');

const which = process.argv[2];
if (!which) { console.error('usage: node build.js move|remove'); process.exit(1); }

const IMG = require('./images');

const DOCS = {
  move: {
    content: './content-move',
    stage: 'stage-move',
    meta: {
      title: 'Move Archived Logs — Solution Architecture',
      subject: 'VCF Operations Orchestrator 9 — Windows event log archives',
      author: 'Broadcom Professional Services',
      company: 'Broadcom',
      footer: 'Move Archived Logs — Solution Architecture',
    },
    images: [IMG.whole, IMG.delivery],
  },
  remove: {
    content: './content-remove',
    stage: 'stage-remove',
    meta: {
      title: 'Remove Old Archived Logs — Solution Architecture',
      subject: 'VCF Operations Orchestrator 9 — Windows event log archives',
      author: 'Broadcom Professional Services',
      company: 'Broadcom',
      footer: 'Remove Old Archived Logs — Solution Architecture',
    },
    images: [IMG.whole, IMG.delivery],
  },
};

const spec = DOCS[which];
if (!spec) { console.error('unknown doc: ' + which); process.exit(1); }

const { blocks } = require(spec.content);
const stageDir = path.join(__dirname, spec.stage);

const order = engine.stage(stageDir, {
  meta: spec.meta,
  images: spec.images,
  blocks: blocks,
});

console.log('staged ' + order.length + ' parts into ' + spec.stage);
order.forEach((o) => console.log('  ' + o));
