#!/usr/bin/env node
// Internal helper for the follow-ups skill (not a product CLI). It never sends: a drafted follow-up is approved and sent with
// contact-store.mjs card -> approve -> begin-send -> record-send, exactly like any other message.
//   node scripts/followup-store.mjs report                                             due / waiting / blocked / not applicable, with reasons
//   node scripts/followup-store.mjs set-prefs --after-days N [--max 0|1] --note "<user words>"   the timing the user approved (7 to 60 days)
//   node scripts/followup-store.mjs draft <app_id> --body-file <f> [--subject <s>] [--allow-unchecked-inbox]
//   node scripts/followup-store.mjs skip <app_id> --note "<user words>"                 the user decided not to follow up
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { followUpReport, setPrefs, draft, skip } from './lib/followups.mjs';

const { positionals: [cmd, id], values: v } = parseArgs({ allowPositionals: true, strict: false, options: {
  'after-days': { type: 'string' }, max: { type: 'string' }, note: { type: 'string' }, 'body-file': { type: 'string' }, subject: { type: 'string' }, 'allow-unchecked-inbox': { type: 'boolean' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  if (cmd === 'report') out(followUpReport(dir));
  else if (cmd === 'set-prefs') out(setPrefs(dir, { afterDays: v['after-days'], maxPerMessage: v.max ?? 1, note: v.note }));
  else if (cmd === 'draft') out(draft(dir, id, { body: v['body-file'] ? readFileSync(v['body-file'], 'utf8').replace(/^﻿/, '') : '', subject: v.subject ?? null, allowUncheckedInbox: !!v['allow-unchecked-inbox'] }));
  else if (cmd === 'skip') out(skip(dir, id, v.note));
  else { console.error('usage: followup-store.mjs report | set-prefs --after-days N --note | draft <app_id> --body-file <f> | skip <app_id> --note'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(e instanceof RefusedError ? 2 : 1); }
