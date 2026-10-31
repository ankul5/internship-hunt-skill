#!/usr/bin/env node
// Internal helper used by the apply skill (not a product CLI). Prepares documents; never submits or sends anything.
//   node scripts/apply-store.mjs list                                       shortlisted (approved) jobs and their applications
//   node scripts/apply-store.mjs approve-job <job_id> --note "<user words>"  verified -> shortlisted, after the user approves
//   node scripts/apply-store.mjs start <job_id>                             gate the job, open application + new version, print job and confirmed profile
//   node scripts/apply-store.mjs set-description <app_id> <file> --origin fetched|user_provided [--url <u>]
//   node scripts/apply-store.mjs add-input <app_id> --key <k> --text "<value>" --quote "<user's words>"
//   node scripts/apply-store.mjs prepare <app_id> <package.json>            validate and write resume, cover letter, answers, review
//   node scripts/apply-store.mjs review <app_id> [--version N]              print the full package for the user
//   node scripts/apply-store.mjs templates                                  resume templates: built-in and the user's own
//   node scripts/apply-store.mjs preview-template <name>                    the confirmed profile in that template, as a PDF
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 2 refused, 1 error.
import { readFileSync } from 'node:fs';
import { dataDir } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { listApprovable, approveJob, startApplication, setDescription, addInput, prepare, review, previewTemplate } from './lib/apply.mjs';
import { listTemplates, DEFAULT_TEMPLATE } from './lib/resume-templates.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const pos = (n) => args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))[n];
const out = (o) => console.log(JSON.stringify(o, null, 2));
const dir = dataDir();

try {
  if (cmd === 'list') out(listApprovable(dir));
  else if (cmd === 'approve-job') out(approveJob(dir, pos(0), flag('--note')));
  else if (cmd === 'start') out(startApplication(dir, pos(0)));
  else if (cmd === 'set-description') out(setDescription(dir, pos(0), pos(1), { origin: flag('--origin'), url: flag('--url') ?? null }));
  else if (cmd === 'add-input') out(addInput(dir, pos(0), flag('--key'), flag('--text'), flag('--quote')));
  else if (cmd === 'prepare') out(prepare(dir, pos(0), JSON.parse(readFileSync(pos(1), 'utf8').replace(/^﻿/, ''))));
  else if (cmd === 'templates') out({ default: DEFAULT_TEMPLATE, user_folder: 'resume-templates/<name>/ in the data directory', templates: listTemplates(dir).map(({ css, ...t }) => t) });
  else if (cmd === 'preview-template') out(previewTemplate(dir, pos(0)));
  else if (cmd === 'review') out(review(dir, pos(0), flag('--version') ? Number(flag('--version')) : null));
  else { console.error('usage: apply-store.mjs list | approve-job <job_id> --note | start <job_id> | set-description <app_id> <file> --origin | add-input <app_id> --key --text --quote | prepare <app_id> <package.json> | review <app_id> [--version N] | templates | preview-template <name>'); process.exit(1); }
} catch (e) {
  console.error(e.message);
  process.exit(e instanceof RefusedError ? 2 : 1);
}
