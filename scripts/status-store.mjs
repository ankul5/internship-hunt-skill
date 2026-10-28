#!/usr/bin/env node
// Internal helper for the job-status skill (not a product CLI). Read-only: local records only, nothing is fetched or written.
//   node scripts/status-store.mjs [--since <utc>] [--text]
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON (or text). Exit 0 ok, 1 error.
import { parseArgs } from 'node:util';
import { dataDir } from './lib/data.mjs';
import { jobStatus, renderStatus } from './lib/status.mjs';

const { values: v } = parseArgs({ allowPositionals: true, strict: false, options: { since: { type: 'string' }, text: { type: 'boolean' } } });
try {
  const r = jobStatus(dataDir(), { since: v.since ?? null });
  console.log(v.text ? renderStatus(r) : JSON.stringify(r, null, 2));
} catch (e) { console.error(e.message); process.exit(1); }
