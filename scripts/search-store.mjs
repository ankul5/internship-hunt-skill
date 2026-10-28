#!/usr/bin/env node
// Internal helper used by the run-search skill (not a product CLI).
//   node scripts/search-store.mjs ready                 profile readiness check
//   node scripts/search-store.mjs list [status,status]  jobs already recorded (for refresh)
//   node scripts/search-store.mjs ingest <input.json>   persist search results
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './lib/data.mjs';
import { ingest, listJobs, checkReadiness, RefusedError } from './lib/ingest.mjs';

const [cmd, arg] = process.argv.slice(2);
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

try {
  if (cmd === 'ready') {
    const r = checkReadiness(readJson(join(dir, 'candidate-profile.json')));
    out({ data_dir: dir, ...r });
    process.exit(r.ready ? 0 : 2);
  } else if (cmd === 'list') {
    out(listJobs(dir, arg ? arg.split(',') : null));
  } else if (cmd === 'ingest' && arg) {
    out(ingest(dir, readJson(arg)));
  } else {
    console.error('usage: search-store.mjs ready | list [statuses] | ingest <input.json>');
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(e instanceof RefusedError ? 2 : 1);
}
