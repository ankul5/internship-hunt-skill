#!/usr/bin/env node
// Internal helper for the sync-tracker skill (not a product CLI). check and plan change nothing; apply changes only the fixes the user approved.
//   node scripts/tracker-store.mjs check [--text]                       columns, IDs, timestamps, transitions, duplicates, conflicts, deleted rows
//   node scripts/tracker-store.mjs plan                                 save proposed repairs to tracker/repair-plan-<time>.json
//   node scripts/tracker-store.mjs apply <plan_path> --plan-hash <h> [--only I1,I2] --note "<user words>"   back up, repair, audit
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { parseArgs } from 'node:util';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { check, plan, apply } from './lib/tracker.mjs';

const { positionals: [cmd, arg], values: v } = parseArgs({ allowPositionals: true, strict: false, options: { text: { type: 'boolean' }, 'plan-hash': { type: 'string' }, only: { type: 'string' }, note: { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const text = (r) => [`Tracker check ${r.checked_at}: ${r.summary.errors} error(s), ${r.summary.warnings} warning(s); ${r.summary.fixable} with a proposed fix, ${r.summary.manual} need the user`,
  ...Object.entries(r.files).map(([n, f]) => `  ${n}: ${f.readable ? `${f.rows} rows` : 'UNREADABLE'}`),
  ...r.issues.map((i) => `- ${i.id} [${i.severity}] ${i.file}${i.record_id ? ` ${i.record_id}` : ''}: ${i.message}${i.fix ? ` -> fix: ${i.fix.op}${i.fix.risky ? ' (risky)' : ''}` : ` -> manual: ${i.manual}`}`)].join('\n');

try {
  if (cmd === 'check') { const r = check(dir); v.text ? console.log(text(r)) : out(r); }
  else if (cmd === 'plan') out(plan(dir));
  else if (cmd === 'apply') out(apply(dir, arg, { planHash: v['plan-hash'], only: v.only ? v.only.split(',').map((s) => s.trim()) : null, note: v.note }));
  else { console.error('usage: tracker-store.mjs check [--text] | plan | apply <plan_path> --plan-hash <h> [--only I1,I2] --note "<user words>"'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(e instanceof RefusedError ? 2 : 1); }
