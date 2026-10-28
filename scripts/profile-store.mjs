#!/usr/bin/env node
// Internal helper used by the profile-setup skill (not a product CLI).
//   node scripts/profile-store.mjs show                    current profile and readiness
//   node scripts/profile-store.mjs questions               unanswered preference questions as choice cards (batches of 4)
//   node scripts/profile-store.mjs attach-resume <file>    copy a resume into <data>/resumes/ and print its relative path
//   node scripts/profile-store.mjs save <profile.json>     validate and save the whole profile
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 1 error.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { dataDir, isoNow } from './lib/data.mjs';
import { checkReadiness } from './lib/ingest.mjs';

const [cmd, arg] = process.argv.slice(2);
const dir = dataDir();
const profilePath = join(dir, 'candidate-profile.json');
const out = (o) => console.log(JSON.stringify(o, null, 2));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

const PROV = ['resume', 'user_stated'];
const REMOTE = ['onsite', 'hybrid', 'remote'];
const LISTS = { education: ['institution', 'degree'], experience: ['organization', 'title'], projects: ['name'], skills: ['name'], certifications: ['name'] };
const TOP = ['schema_version', 'updated_at', 'identity', 'education', 'experience', 'projects', 'skills', 'certifications', 'resume', 'preferences', 'provenance', 'open_questions'];

/** Returns problems. Only confirmed facts (provenance resume or user_stated) may be saved. */
export function validateProfile(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['profile is not an object'];
  for (const k of TOP) if (!(k in p)) errs.push(`missing "${k}"`);
  if (errs.length) return errs;
  for (const [list, req] of Object.entries(LISTS)) {
    if (!Array.isArray(p[list])) { errs.push(`${list} must be an array`); continue; }
    p[list].forEach((e, i) => {
      for (const r of req) if (!e[r] || typeof e[r] !== 'string') errs.push(`${list}[${i}].${r} is required`);
      if (!PROV.includes(e.provenance)) errs.push(`${list}[${i}].provenance must be one of ${PROV.join('/')} (unconfirmed facts are not saved; put the question in open_questions)`);
    });
  }
  const pr = p.preferences;
  for (const k of ['target_roles', 'locations', 'remote_types', 'industries', 'excluded_companies', 'deal_breakers']) if (!Array.isArray(pr?.[k])) errs.push(`preferences.${k} must be an array`);
  for (const r of pr?.remote_types ?? []) if (!REMOTE.includes(r)) errs.push(`preferences.remote_types: "${r}" not in ${REMOTE.join('/')}`);
  for (const k of ['earliest_start', 'latest_start']) if (pr?.[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(pr[k])) errs.push(`preferences.${k} must be YYYY-MM-DD or null`);
  for (const [k, v] of Object.entries(p.provenance ?? {})) if (!PROV.includes(v)) errs.push(`provenance["${k}"] must be one of ${PROV.join('/')}`);
  const sp = p.resume?.source_path;
  if (sp != null) {
    if (/^([\\/]|[A-Za-z]:)/.test(sp) || /(^|[\\/])\.\.([\\/]|$)/.test(sp)) errs.push('resume.source_path must be relative to the data directory');
    else if (!existsSync(join(dir, sp))) errs.push(`resume.source_path "${sp}" does not exist in the data directory (use attach-resume first)`);
  }
  if (!Array.isArray(p.open_questions)) errs.push('open_questions must be an array');
  return errs;
}

const opt = (label, description) => ({ label, description });

/** Preference questions as choice cards. `answered_by` is the provenance key that marks a question answered (even if the answer is "none"). */
export const preferenceQuestions = (p) => [
  { field: 'target_roles', answered_by: 'preferences.target_roles', header: 'Roles', multiSelect: true,
    question: 'Which kinds of roles do you want to look for?',
    options: [opt('Software engineering', 'Backend, full-stack, mobile'), opt('Machine learning / AI', 'ML, computer vision, data science'), opt('Data / analytics', 'Data engineering, analysis'), opt('Part-time or freelance too', 'Include part-time roles alongside internships')],
    maps_to: 'preferences.target_roles (write the roles in the user\'s words; add part-time wording if chosen)' },
  { field: 'locations', answered_by: 'preferences.locations', header: 'Location', multiSelect: true,
    question: 'Where do you want to work?',
    options: [opt(p.identity?.location ? `Near ${p.identity.location}` : 'My city', 'Onsite or hybrid close to home'), opt('Anywhere in my country', 'Any city'), opt('Outside my country', 'Needs work authorization there'), opt('Remote only', 'No relocation')],
    maps_to: 'preferences.locations' },
  { field: 'remote_types', answered_by: 'preferences.remote_types', header: 'Work mode', multiSelect: true,
    question: 'Which work arrangements are acceptable?',
    options: [opt('Onsite', ''), opt('Hybrid', ''), opt('Remote', '')], maps_to: 'preferences.remote_types (onsite, hybrid, remote)' },
  { field: 'start_dates', answered_by: 'preferences.earliest_start', header: 'Start date', multiSelect: false,
    question: 'When can you start?',
    options: [opt('Right away', 'Within the next month'), opt('In about 3 months', ''), opt('Next summer', 'May to July'), opt('Flexible', 'No fixed dates')],
    maps_to: 'preferences.earliest_start / latest_start (YYYY-MM-DD; ask for exact dates if "Other" is used; leave null for Flexible)' },
  { field: 'duration', answered_by: 'preferences.duration_weeks_min', header: 'Duration', multiSelect: false,
    question: 'How long should the role be?',
    options: [opt('4 to 8 weeks', ''), opt('8 to 12 weeks', ''), opt('3 to 6 months', ''), opt('Flexible', '')],
    maps_to: 'preferences.duration_weeks_min / max (integers; null for Flexible)' },
  { field: 'stipend', answered_by: 'preferences.min_stipend_text', header: 'Stipend', multiSelect: false,
    question: 'Do you have a pay requirement?',
    options: [opt('Paid only', 'Skip unpaid roles'), opt('Any, including unpaid', 'Pay is not a filter'), opt('Minimum amount', 'Choose Other and type it, e.g. 15000 INR per month')],
    maps_to: 'preferences.min_stipend_text (the user\'s words; null for Any)' },
  { field: 'work_authorization', answered_by: 'identity.work_authorization.status', header: 'Work permit', multiSelect: false,
    question: 'Which describes your work authorization?',
    options: [opt('Authorized in my own country only', 'No sponsorship needed there'), opt('Authorized in my country; open to sponsorship elsewhere', ''), opt('Need sponsorship everywhere', '')],
    maps_to: 'identity.work_authorization (status, countries, needs_sponsorship; countries from the user)' },
  { field: 'filters', answered_by: 'preferences.deal_breakers', header: 'Filters', multiSelect: true,
    question: 'Anything to exclude or avoid?',
    options: [opt('Unpaid roles', ''), opt('Roles needing relocation', ''), opt('Specific companies', 'Choose Other and list them'), opt('Nothing to exclude', '')],
    maps_to: 'preferences.deal_breakers / excluded_companies (the user\'s words; empty list for "Nothing")' },
].filter((q) => !(q.answered_by in (p.provenance ?? {})));

try {
  if (cmd === 'questions') {
    const qs = preferenceQuestions(readJson(profilePath));
    const batches = [];
    for (let i = 0; i < qs.length; i += 4) batches.push(qs.slice(i, i + 4));
    out({ unanswered: qs.map((q) => q.field), batches });
  } else if (cmd === 'show') {
    const p = readJson(profilePath);
    out({ data_dir: dir, readiness: checkReadiness(p), profile: p });
  } else if (cmd === 'attach-resume' && arg) {
    if (!existsSync(arg)) throw new Error(`file not found: ${arg}`);
    mkdirSync(join(dir, 'resumes'), { recursive: true });
    const name = basename(arg);
    let dest = join(dir, 'resumes', name);
    if (existsSync(dest)) dest = join(dir, 'resumes', `${basename(name, extname(name))}-${isoNow().replace(/[-:]/g, '')}${extname(name)}`);
    copyFileSync(arg, dest);
    out({ source_path: `resumes/${basename(dest)}` });
  } else if (cmd === 'save' && arg) {
    const next = readJson(arg);
    const errs = validateProfile(next);
    if (errs.length) { console.error(JSON.stringify({ saved: false, problems: errs }, null, 2)); process.exit(1); }
    next.updated_at = isoNow();
    if (next.resume.source_path && !next.resume.parsed_at) next.resume.parsed_at = next.updated_at;
    if (existsSync(profilePath)) {
      mkdirSync(join(dir, 'backups'), { recursive: true });
      copyFileSync(profilePath, join(dir, 'backups', `candidate-profile-${next.updated_at.replace(/[-:]/g, '')}.json`));
    }
    const tmp = `${profilePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, profilePath);
    out({ saved: true, path: profilePath, readiness: checkReadiness(next) });
  } else {
    console.error('usage: profile-store.mjs show | questions | attach-resume <file> | save <profile.json>');
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
