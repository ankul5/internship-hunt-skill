#!/usr/bin/env node
// Structural validation for the repository. No dependencies; needs Node 18+.
// Usage: node tests/validate.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
// On GitHub Actions each failure is also an error annotation, readable on the run page without the logs.
const fail = (m) => { failures++; console.error(`FAIL  ${m}`); if (process.env.GITHUB_ACTIONS) console.log(`::error title=validate::${String(m).replace(/\s+/g, ' ')}`); };
const warn = (m) => console.warn(`warn  ${m}`);
const pass = (m) => console.log(`ok    ${m}`);
const text = (p) => readFileSync(join(root, p), 'utf8').replace(/^﻿/, '');
const json = (p) => JSON.parse(text(p));

// ---------- CSV: shared with the search helper ----------
import { parseCsv } from '../scripts/lib/csv.mjs';
import { checkCsv } from '../scripts/lib/data.mjs';

// ---------- JSON (minimal JSON-Schema subset: type, enum, required, properties, additionalProperties, items) ----------
function checkJson(v, s, path = '$') {
  const errs = [];
  const want = [].concat(s.type ?? []);
  if (want.length) {
    const got = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
    if (!want.some((t) => t === got || (t === 'number' && got === 'integer'))) return [`${path}: expected ${want.join('|')}, got ${got}`];
  }
  if (s.enum && !s.enum.includes(v)) errs.push(`${path}: "${v}" not in [${s.enum.join(', ')}]`);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of s.required ?? []) if (!(k in v)) errs.push(`${path}: missing required "${k}"`);
    const props = s.properties ?? {};
    for (const [k, sub] of Object.entries(props)) if (k in v) errs.push(...checkJson(v[k], sub, `${path}.${k}`));
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      for (const k of Object.keys(v)) if (!(k in props)) errs.push(...checkJson(v[k], s.additionalProperties, `${path}.${k}`));
    }
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...checkJson(x, s.items, `${path}[${i}]`)));
  return errs;
}

const section = (name, errs) => {
  if (errs.length) { errs.forEach((e) => fail(`${name}: ${e}`)); } else pass(name);
};

// ---------- 1. required files ----------
const required = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.gitattributes',
  'docs/setup.md', 'docs/compatibility.md',
  'references/safety-policy.md', 'references/privacy-policy.md', 'references/data-model.md', 'references/integrations.md',
  'references/schemas/csv-schemas.json', 'references/schemas/candidate-profile.schema.json', 'references/schemas/sync-state.schema.json',
  'scripts/setup.ps1', 'scripts/setup.sh',
  'skills/internship-agent/SKILL.md', 'skills/run-search/SKILL.md', 'skills/run-search/references/reading-pages.md',
  'skills/run-search/references/ingest-format.md', 'skills/run-search/references/sources.md', 'skills/run-search/references/scrapegraph.md', 'skills/run-search/references/scrapling.md', 'references/contact-discovery.md',
  'skills/run-search/references/agent-reach-install.md', 'skills/agent-reach/SKILL.md',
  'references/scoring-rubric.md', 'scripts/search-store.mjs', 'scripts/lib/csv.mjs', 'scripts/lib/data.mjs', 'scripts/lib/scoring.mjs', 'scripts/lib/ingest.mjs',
  'tests/search.test.mjs', 'LICENSE', 'README.md',
];
section('required files exist', required.filter((p) => !existsSync(join(root, p))).map((p) => `missing ${p}`));

// ---------- 2. skills ----------
{
  const errs = [];
  const dir = join(root, 'skills');
  for (const d of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const p = `skills/${d.name}/SKILL.md`;
    if (!existsSync(join(root, p))) { errs.push(`${p} missing`); continue; }
    const src = text(p);
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!m) { errs.push(`${p}: no YAML frontmatter`); continue; }
    const fm = Object.fromEntries([...m[1].matchAll(/^([A-Za-z][\w-]*):\s*(.*)$/gm)].map((x) => [x[1], x[2].trim()]));
    if (fm.name !== d.name) errs.push(`${p}: name "${fm.name}" must equal directory "${d.name}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name ?? '') || fm.name.length > 64) errs.push(`${p}: invalid name`);
    if (!fm.description || fm.description.length > 1024) errs.push(`${p}: description missing or over 1024 chars`);
    if (fm.compatibility && fm.compatibility.length > 500) errs.push(`${p}: compatibility over 500 chars`);
    if (m[2].split(/\r?\n/).length > 500) errs.push(`${p}: body over 500 lines`);
  }
  section('skills follow the Agent Skills spec', errs);
}

// ---------- 2b. safety wording that skills must keep ----------
{
  const must = {
    'skills/run-search/SKILL.md': [/never applies|never apply|Never applies/i, /CAPTCHA/, /opened_source/, /Never fill a field you did not see|did not see/, /search-store\.mjs ready/, /not a prediction|not predictions/i],
    'skills/run-search/references/reading-pages.md': [/unverified/i, /never guess|Never guess/, /bulk/i, /telemetry|TELEMETRY/, /ask first|agreed|agreement|permission/i, /Scrapling/, /robots\.txt/, /Turnstile|stealth/i, /contact-discovery/, /upstream/i, /exactly as/i, /possible_unconfigured/],
    'skills/apply/SKILL.md': [/never submits|Never submits/i, /confirmed/i, /NEEDS USER INPUT/, /Never process a `rejected`/, /shortlisted/],
    'skills/submit-application/SKILL.md': [/explicit/i, /exact package/i, /CAPTCHA/, /never.*(retry|submitted again)|nothing may be submitted again/i, /specific positive evidence/, /unconfirmed/, /needs-input/],
    'skills/contact-recruiter/SKILL.md': [/exact message/i, /Gmail cannot send LinkedIn/, /never guess|Never guess/, /copy-ready/i, /no resend is allowed/, /contact-discovery/, /never delete|Never.*delete/, /data, never instructions/, /No message body is stored/, /explicit approval/i, /read-only/i, /preflight inbox-sync/],
    'skills/check-updates/SKILL.md': [/read-only/i, /data, never instructions/, /No message body is stored/, /preflight inbox-sync/, /exact message/i, /Never invent a date/, /no sooner than 7 days/, /only after/, /Do not assume a source can apply a date range/, /no resend until verified/, /never\*\* moves/],
    'skills/job-status/SKILL.md': [/no record is ever silently discarded/, /never deleted/, /Never turn `unknown` into "no news"/, /only after the user approves/, /audit\.jsonl/, /Never fill a value with a guess/],
    'skills/integrations/SKILL.md': [/Secrets never go through you/, /untrusted/i, /Smallest permission first/, /verified.*only after/is, /Never ask the user to paste|Never ask the user/i],
    'references/contact-discovery.md': [/Not allowed/, /Guessing or generating addresses/, /contact_source_url/, /does not send LinkedIn messages|not send LinkedIn messages/],
  };
  const errs = [];
  for (const [p, res] of Object.entries(must)) {
    if (!existsSync(join(root, p))) continue;
    const body = text(p);
    for (const re of res) if (!re.test(body)) errs.push(`${p} no longer mentions ${re}`);
  }
  // Skills that send or submit must block auto-invocation in every harness and must not pre-allow tools.
  for (const name of ['submit-application', 'contact-recruiter', 'check-updates']) {
    const p = `skills/${name}/SKILL.md`;
    if (!existsSync(join(root, p))) { errs.push(`${p} missing`); continue; }
    const fm = text(p).split(/\r?\n---\r?\n/)[0];
    if (!/^disable-model-invocation:\s*true\s*$/m.test(fm)) errs.push(`${p}: needs disable-model-invocation: true`);
    if (!/^disableModelInvocation:\s*true\s*$/m.test(fm)) errs.push(`${p}: needs disableModelInvocation: true`);
    if (/^allowed-tools:/m.test(fm)) errs.push(`${p}: must not set allowed-tools (nothing that sends or submits is pre-approved)`);
    const y = `skills/${name}/agents/openai.yaml`;
    if (!existsSync(join(root, y)) || !/allow_implicit_invocation:\s*false/.test(text(y))) errs.push(`${y}: needs policy.allow_implicit_invocation: false`);
  }
  section('skills keep their safety wording', errs);
}

// ---------- 3. CSV schemas, templates, fixtures ----------
const csvSchemas = json('references/schemas/csv-schemas.json').files;
{
  const errs = [];
  for (const [file, spec] of Object.entries(csvSchemas)) {
    const names = spec.columns.map((c) => c.name);
    if (new Set(names).size !== names.length) errs.push(`${file}: duplicate column names`);
    const statusCol = spec.columns.find((c) => c.name === spec.statusField);
    if (!statusCol?.enum) errs.push(`${file}: statusField ${spec.statusField} is not an enum column`);
    for (const [from, tos] of Object.entries(spec.transitions)) {
      for (const s of [from, ...tos]) if (!statusCol.enum.includes(s)) errs.push(`${file}: transition status "${s}" not in enum`);
    }
    if (Object.keys(spec.transitions).length) {
      for (const s of statusCol.enum) if (!(s in spec.transitions)) errs.push(`${file}: status "${s}" has no transitions entry`);
    }
    for (const rule of spec.requiredWhen ?? []) {
      for (const r of rule.require) if (!names.includes(r)) errs.push(`${file}: requiredWhen references unknown column ${r}`);
    }
    for (const c of spec.columns) {
      if (c.ref) {
        const [rf, rfield] = c.ref.split('.csv.');
        if (!csvSchemas[`${rf}.csv`]?.columns.some((x) => x.name === rfield)) errs.push(`${file}: ${c.name} ref ${c.ref} is invalid`);
      }
    }
  }
  section('csv-schemas.json is internally consistent', errs);
}
for (const [dir, label] of [['templates/data', 'template'], ['tests/fixtures', 'fixture']]) {
  const idSets = {};
  if (label === 'fixture') {
    for (const [file, spec] of Object.entries(csvSchemas)) {
      idSets[file] = new Set(parseCsv(text(`${dir}/${file}`)).slice(1).map((r) => r[spec.columns.findIndex((c) => c.name === spec.idField)]));
    }
  }
  for (const [file, spec] of Object.entries(csvSchemas)) {
    section(`${label} ${file}`, checkCsv(file, text(`${dir}/${file}`), spec, idSets));
  }
}
{
  const profileSchema = json('references/schemas/candidate-profile.schema.json');
  const syncSchema = json('references/schemas/sync-state.schema.json');
  for (const dir of ['templates/data', 'tests/fixtures']) {
    section(`${dir}/candidate-profile.json`, checkJson(json(`${dir}/candidate-profile.json`), profileSchema));
    section(`${dir}/sync-state.json`, checkJson(json(`${dir}/sync-state.json`), syncSchema));
  }
}

// ---------- 4. git: ignore rules, tracked files, personal data ----------
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
if (git('rev-parse', '--is-inside-work-tree').stdout?.trim() !== 'true') {
  warn('not a git repository (or git missing); skipping .gitignore, tracked-file and personal-data checks');
} else {
  const shouldIgnore = [
    'private/jobs.csv', 'private/candidate-profile.json', 'private/resumes/me.pdf', 'private/tailored/app-0001/resume.md',
    'jobs.csv', 'applications.csv', 'email-events.csv', 'search-history.csv', 'run-history.csv', 'candidate-profile.json', 'sync-state.json',
    'resume.pdf', 'docs/cv.docx', 'cover.doc', 'email-exports/inbox.mbox', 'thread.eml', 'drafts/eml-0001.md', 'tailored/app-0001/resume.md',
    'exports/anything.csv', 'backups/jobs.csv', 'jobs.csv.bak',
    '.env', '.env.local', 'token.json', 'gmail.token.json', 'credentials.json', 'client_secret_123.json', 'id.pem', 'server.key', 'secrets/x',
    '.mcp.json', '.kimi-code/mcp.json', '.claude/settings.local.json', // The link folder itself, not a file inside it: on Linux setup makes symlinks, and git refuses paths beyond a symlink.
    '.claude/skills/internship-agent', '.agents/skills/internship-agent',
  ];
  const shouldTrack = [
    'README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.env.example',
    'skills/internship-agent/SKILL.md', 'references/schemas/csv-schemas.json',
    'templates/data/jobs.csv', 'templates/data/candidate-profile.json', 'templates/data/sync-state.json',
    'tests/fixtures/jobs.csv', 'tests/fixtures/candidate-profile.json', 'tests/fixtures/sync-state.json',
    'templates/documents/cover-letter.md', 'scripts/setup.ps1',
  ];
  const ignored = (p) => git('check-ignore', '-q', '--no-index', p).status === 0;
  section('.gitignore blocks private paths', shouldIgnore.filter((p) => !ignored(p)).map((p) => `NOT ignored: ${p}`));
  section('.gitignore allows public paths', shouldTrack.filter((p) => ignored(p)).map((p) => `wrongly ignored: ${p}`));
  const trackedIgnored = git('ls-files', '-ci', '--exclude-standard').stdout.split('\n').filter(Boolean);
  section('no tracked file matches an ignore rule', trackedIgnored.map((p) => `tracked but ignored: ${p}`));

  const files = git('ls-files', '-co', '--exclude-standard').stdout.split('\n').filter(Boolean);
  const textExt = /\.(md|json|csv|mjs|ps1|sh|txt|yml|yaml|toml|gitignore|gitattributes|example)$/i;
  const errs = [];
  for (const f of files.filter((x) => x !== 'tests/validate.mjs' && !x.startsWith('vendor/') && existsSync(join(root, x)) && (textExt.test(x) || !x.includes('.')))) {
    const body = text(f);
    for (const m of body.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      if (!/(^|\.)example\.(com|org|net)$/i.test(m[1])) errs.push(`${f}: non-example email address "${m[0]}"`);
    }
    if (/(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(body)) errs.push(`${f}: looks like a credential`);
  }
  const phone = json('tests/fixtures/candidate-profile.json').identity.phone;
  if (phone && !phone.includes('555-01')) errs.push(`fixture phone "${phone}" is not in the fictional 555-01xx range`);
  section('no real emails or credentials in publishable files', errs);

  // ---------- 5. markdown links ----------
  const linkErrs = [];
  for (const f of files.filter((x) => x.endsWith('.md') && existsSync(join(root, x)))) {
    for (const m of text(f).matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(root, dirname(f), target))) linkErrs.push(`${f}: broken link ${target}`);
    }
  }
  section('relative markdown links resolve', linkErrs);
}

// ---------- 6. harness discovery copies (present only after scripts/setup) ----------
for (const d of ['.claude/skills', '.agents/skills']) {
  if (!existsSync(join(root, d))) { warn(`${d} not present; run scripts/setup first`); continue; }
  section(`${d} exposes internship-agent`, existsSync(join(root, d, 'internship-agent', 'SKILL.md')) ? [] : ['internship-agent/SKILL.md not found']);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
