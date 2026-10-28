#!/usr/bin/env node
// Integration readiness for the internship agent (not a product CLI). Contains and prints no secrets.
//   node scripts/integrations-store.mjs readiness [--text]     the four-way checklist, with what to ask the user for anything missing
//   node scripts/integrations-store.mjs preflight apply|submit-application|contact-recruiter|inbox-sync   can this task start? if not: the question and options to put to the user
//   node scripts/integrations-store.mjs probe ats-feeds|freehire  real read-only test of a public source; records the result
//   node scripts/integrations-store.mjs platforms [--id <platform>] [--text]   search/apply/messaging/auth/limits/status per platform
//   node scripts/integrations-store.mjs render-platforms [--write]   regenerate references/platforms.md from platforms.json
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON (or text). Exit 0 ok, 1 error.
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { readiness, renderChecklist, preflight, probe, loadPlatforms, renderPlatformsMd, platformsMdPath } from './lib/readiness.mjs';

const { positionals: [cmd, arg], values: v } = parseArgs({ allowPositionals: true, strict: false, options: { text: { type: 'boolean' }, write: { type: 'boolean' }, id: { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  if (cmd === 'readiness') { const r = readiness(dir); v.text ? console.log(renderChecklist(r)) : out(r); }
  else if (cmd === 'probe') out(await probe(dir, arg));
  else if (cmd === 'preflight') out(preflight(dir, arg));
  else if (cmd === 'platforms') {
    const all = loadPlatforms().platforms.filter((p) => !v.id || p.id === v.id);
    if (!all.length) throw new Error(`no such platform: ${v.id}`);
    v.text ? console.log(renderPlatformsMd({ platforms: all })) : out(all);
  } else if (cmd === 'render-platforms') {
    const md = renderPlatformsMd();
    if (v.write) { writeFileSync(platformsMdPath(), md); out({ written: platformsMdPath() }); } else process.stdout.write(md);
  } else { console.error('usage: integrations-store.mjs readiness [--text] | probe ats-feeds|freehire | platforms [--id x] [--text] | render-platforms [--write]'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(1); }
