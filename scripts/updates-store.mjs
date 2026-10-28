#!/usr/bin/env node
// Internal helper for the check-updates skill (not a product CLI). Reads mail only; never sends, deletes, labels or marks anything.
//   node scripts/updates-store.mjs plan --source gmail-api|gmail-connector|pasted [--since last-sync|today|yesterday|7d|YYYY-MM-DD] [--tz +05:30]
//                                   the exact UTC window, the search query, the integration status and what will not be checked
//   node scripts/updates-store.mjs gmail [--since ...] [--tz ...] [--max N]        fetch through this repository's Gmail API client and record
//   node scripts/updates-store.mjs record <messages.json> --source gmail-connector|pasted --from <utc> --to <utc> [--complete] [--date-filter-evidence "<what you saw>"]
//                                   record messages fetched by a connector (or pasted); the window comes from plan
//   node scripts/updates-store.mjs set-tz <+05:30>                                the user's UTC offset for today / yesterday / dates
//   node scripts/updates-store.mjs pending | confirm <event_id> [--application <app_id>] [--kind <k>] --note "<user words>" | dismiss <event_id> --note "<user words>"
//   node scripts/updates-store.mjs log                                            every check attempt, with why a checkpoint did or did not move
// Message shape: { id?, thread_id, received_at (UTC YYYY-MM-DDTHH:MM:SSZ), from_name, from_email, subject, snippet, body_text?, links? }.
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused or not authorized, 1 error.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { planCheck, recordCheck, checkGmailApi, setTimezone, readCheckLog } from './lib/updates.mjs';
import { pendingEvents, confirmEvent, dismissEvent } from './lib/inbox.mjs';
import { secretsDir, assertSafeSecretsDir } from './lib/secrets.mjs';
import { GmailClient } from './lib/gmail.mjs';
import { recovery } from './lib/readiness.mjs';

const { positionals: [cmd, arg], values: v } = parseArgs({ allowPositionals: true, strict: false, options: {
  source: { type: 'string' }, since: { type: 'string' }, tz: { type: 'string' }, max: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  complete: { type: 'boolean' }, 'date-filter-evidence': { type: 'string' }, application: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  if (cmd === 'plan') out(planCheck(dir, { since: v.since ?? 'last-sync', source: v.source, tz: v.tz ?? null }));
  else if (cmd === 'gmail') {
    const client = new GmailClient({ sdir: assertSafeSecretsDir(secretsDir(), dir) });
    const r = await checkGmailApi(dir, client, { since: v.since ?? 'last-sync', tz: v.tz ?? null, max: Number(v.max ?? 200) });
    if (r.ok === false) { r.recover = recovery(dir, 'inbox-sync', r.message); r.next = 'Do not just report this. Ask the user the recover.ask_user question (connect Gmail, use a connector, or paste the emails), help them, then check again.'; process.exitCode = 2; }
    out(r);
  } else if (cmd === 'record') {
    if (!['gmail-connector', 'pasted'].includes(v.source)) throw new Error('--source must be gmail-connector or pasted (the Gmail API path is the gmail command)');
    const j = JSON.parse(readFileSync(arg, 'utf8').replace(/^﻿/, ''));
    out(recordCheck(dir, { source: v.source, window: { from: v.from, to: v.to }, messages: Array.isArray(j) ? j : j.messages, complete: !!v.complete, dateFilterEvidence: v['date-filter-evidence'] ?? null }));
  } else if (cmd === 'set-tz') out(setTimezone(dir, arg));
  else if (cmd === 'pending') out(pendingEvents(dir));
  else if (cmd === 'confirm') out(confirmEvent(dir, arg, { applicationId: v.application, kind: v.kind, note: v.note }));
  else if (cmd === 'dismiss') out(dismissEvent(dir, arg, v.note));
  else if (cmd === 'log') out(readCheckLog(dir));
  else { console.error('usage: updates-store.mjs plan | gmail | record <messages.json> | set-tz <offset> | pending | confirm | dismiss | log  (see the header of this file)'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(e instanceof RefusedError ? 2 : 1); }
