#!/usr/bin/env node
// Low-level inbox pipeline (not a product CLI). The check-updates skill uses scripts/updates-store.mjs, which adds date windows
// and checkpoints on top of this. Works on normalised messages from the Gmail API client or a connector. It never alters a
// mailbox and never stores message bodies.
//   node scripts/inbox-store.mjs ingest <messages.json> [--source gmail|connector]
//   node scripts/inbox-store.mjs pending
//   node scripts/inbox-store.mjs confirm <event_id> [--application <app_id>] [--kind reply|interview_invite|assessment|rejection|offer|other] --note "<user words>"
//   node scripts/inbox-store.mjs dismiss <event_id> --note "<user words>"
// Message shape: { id, thread_id, received_at (UTC YYYY-MM-DDTHH:MM:SSZ), from_name, from_email, subject, snippet, body_text?, links?, message_id_header? }
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { ingestMessages, pendingEvents, confirmEvent, dismissEvent } from './lib/inbox.mjs';

const { positionals: [cmd, arg], values: v } = parseArgs({ allowPositionals: true, strict: false, options: { source: { type: 'string' }, application: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  if (cmd === 'ingest') { const j = JSON.parse(readFileSync(arg, 'utf8').replace(/^﻿/, '')); out(ingestMessages(dir, Array.isArray(j) ? j : j.messages, { source: v.source ?? 'connector' })); }
  else if (cmd === 'pending') out(pendingEvents(dir));
  else if (cmd === 'confirm') out(confirmEvent(dir, arg, { applicationId: v.application, kind: v.kind, note: v.note }));
  else if (cmd === 'dismiss') out(dismissEvent(dir, arg, v.note));
  else { console.error('usage: inbox-store.mjs ingest <messages.json> | pending | confirm <event_id> --note | dismiss <event_id> --note'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(e instanceof RefusedError ? 2 : 1); }
