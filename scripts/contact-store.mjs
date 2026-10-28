#!/usr/bin/env node
// Internal helper used by the contact-recruiter skill (not a product CLI). It never sends anything itself:
// it drafts from confirmed facts, binds approval to the exact text, and records what the provider returned.
//   node scripts/contact-store.mjs draft <app_id> --platform gmail|outlook|linkedin|other --to <addr-or-url> [--name <n>] [--subject <s>] --body-file <f>
//                                       (--contact-source-url <url> | --user-provided) [--kind recruiter_outreach|application_email]
//   node scripts/contact-store.mjs draft <app_id> --reply-to <inbound_event_id> --body-file <f> [--subject <s>]   a reply to a recruiter message already recorded by inbox-store
//   node scripts/contact-store.mjs card <event_id>                             what the user must see, plus content_hash
//   node scripts/contact-store.mjs revise <event_id> [--subject <s>] [--body-file <f>]
//   node scripts/contact-store.mjs approve <event_id> --note "<user words>" --content-hash <h>
//   node scripts/contact-store.mjs deny <event_id> --note "<user words>"
//   node scripts/contact-store.mjs handoff <event_id>                           copy-ready text + official destination (no approval needed; nothing is sent)
//   node scripts/contact-store.mjs begin-send <event_id>
//   node scripts/contact-store.mjs record-send <event_id> --result sent|failed|unknown --evidence "<provider response>" [--message-id <id>] [--thread-id <id>]
//   node scripts/contact-store.mjs verify-send <event_id> --result sent|not_sent --evidence "<seen>" [--message-id <id>]
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { draftMessage, messageCard, reviseMessage, approveMessage, denyMessage, handoff, beginSend, recordSend, verifySend } from './lib/contact.mjs';

const { positionals: [cmd, id], values: v } = parseArgs({ allowPositionals: true, strict: false, options: {
  platform: { type: 'string' }, to: { type: 'string' }, name: { type: 'string' }, subject: { type: 'string' }, 'body-file': { type: 'string' }, 'contact-source-url': { type: 'string' },
  'user-provided': { type: 'boolean' }, kind: { type: 'string' }, note: { type: 'string' }, 'content-hash': { type: 'string' }, result: { type: 'string' }, evidence: { type: 'string' },
  'message-id': { type: 'string' }, 'thread-id': { type: 'string' }, 'reply-to': { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const body = () => (v['body-file'] ? readFileSync(v['body-file'], 'utf8').replace(/^﻿/, '') : undefined);

try {
  if (cmd === 'draft') out(draftMessage(dir, id, { platform: v.platform, to: v.to, name: v.name, subject: v.subject, body: body(), contactSourceUrl: v['contact-source-url'], userProvided: !!v['user-provided'], kind: v.kind, replyTo: v['reply-to'] }));
  else if (cmd === 'card') out(messageCard(dir, id));
  else if (cmd === 'revise') out(reviseMessage(dir, id, { subject: v.subject, body: body() }));
  else if (cmd === 'approve') out(approveMessage(dir, id, { note: v.note, contentHash: v['content-hash'] }));
  else if (cmd === 'deny') out(denyMessage(dir, id, v.note));
  else if (cmd === 'handoff') out(handoff(dir, id));
  else if (cmd === 'begin-send') out(beginSend(dir, id));
  else if (cmd === 'record-send') out(recordSend(dir, id, { result: v.result, evidence: v.evidence, messageId: v['message-id'] ?? null, threadId: v['thread-id'] ?? null }));
  else if (cmd === 'verify-send') out(verifySend(dir, id, { result: v.result, evidence: v.evidence, messageId: v['message-id'] ?? null, threadId: v['thread-id'] ?? null }));
  else { console.error('usage: contact-store.mjs draft | card | revise | approve | deny | handoff | begin-send | record-send | verify-send  (see the header of this file)'); process.exit(1); }
} catch (e) {
  console.error(e.message);
  process.exit(e instanceof RefusedError ? 2 : 1);
}
