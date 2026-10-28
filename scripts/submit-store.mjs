#!/usr/bin/env node
// Internal helper used by the submit-application skill (not a product CLI). It never submits anything itself:
// it gates, binds approval to the exact package, and records what the integration or the user actually observed.
//   node scripts/submit-store.mjs integrations
//   node scripts/submit-store.mjs set-integration <name> --status verified|possible_unconfigured|unsupported_or_unverified --notes "<what you did>"
//   node scripts/submit-store.mjs card <app_id>                                  what the user must see, plus package_hash
//   node scripts/submit-store.mjs approve <app_id> --note "<user words>" --package-hash <h>
//   node scripts/submit-store.mjs deny <app_id> --note "<user words>"
//   node scripts/submit-store.mjs begin <app_id> [--method portal|manual_by_user|other] [--integration browser|portal-api]
//   node scripts/submit-store.mjs needs-input <app_id> --field "<question or declaration>"
//   node scripts/submit-store.mjs record <app_id> --result success|failed|unconfirmed --evidence "<observed>" [--evidence-kind <k>] [--blocked captcha|login|bot_check]
//   node scripts/submit-store.mjs verify <app_id> --result success|failed --evidence "<observed>" [--evidence-kind <k>]
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { setIntegration, integrationStatus } from './lib/outbound.mjs';
import { submissionCard, approveSubmission, denySubmission, beginSubmission, needsInput, recordSubmission, verifySubmission } from './lib/submit.mjs';

const { positionals: [cmd, id], values: v } = parseArgs({ allowPositionals: true, strict: false, options: {
  note: { type: 'string' }, 'package-hash': { type: 'string' }, destination: { type: 'string' }, method: { type: 'string' }, integration: { type: 'string' }, field: { type: 'string' },
  result: { type: 'string' }, evidence: { type: 'string' }, 'evidence-kind': { type: 'string' }, blocked: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } } });
const dir = dataDir();
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  if (cmd === 'integrations') {
    const sync = JSON.parse(readFileSync(join(dir, 'sync-state.json'), 'utf8'));
    out(Object.fromEntries([...new Set(['browser', 'portal-api', 'gmail-send', 'outlook-send', ...Object.keys(sync.integrations ?? {})])].map((n) => [n, integrationStatus(dir, n)])));
  } else if (cmd === 'set-integration') out(setIntegration(dir, id, v.status, v.notes));
  else if (cmd === 'card') out(submissionCard(dir, id));
  else if (cmd === 'approve') out(approveSubmission(dir, id, { note: v.note, packageHash: v['package-hash'], destination: v.destination }));
  else if (cmd === 'deny') out(denySubmission(dir, id, v.note));
  else if (cmd === 'begin') out(beginSubmission(dir, id, { method: v.method ?? 'portal', integration: v.integration ?? null }));
  else if (cmd === 'needs-input') out(needsInput(dir, id, v.field));
  else if (cmd === 'record') out(recordSubmission(dir, id, { result: v.result, evidence: v.evidence, evidenceKind: v['evidence-kind'] ?? null, blocked: v.blocked ?? null }));
  else if (cmd === 'verify') out(verifySubmission(dir, id, { result: v.result, evidence: v.evidence, evidenceKind: v['evidence-kind'] ?? null }));
  else { console.error('usage: submit-store.mjs integrations | set-integration | card | approve | deny | begin | needs-input | record | verify  (see the header of this file)'); process.exit(1); }
} catch (e) {
  console.error(e.message);
  process.exit(e instanceof RefusedError ? 2 : 1);
}
