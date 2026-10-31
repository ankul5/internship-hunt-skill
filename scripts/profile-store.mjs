#!/usr/bin/env node
// Internal helper used by the profile-setup skill (not a product CLI).
//   node scripts/profile-store.mjs show                    current profile and readiness
//   node scripts/profile-store.mjs questions               unanswered setup questions as choice cards (batches of 4)
//   node scripts/profile-store.mjs gaps [--text]           what is still missing, per stage (search, scoring, apply, outreach, submit)
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
// Lists and fields added after schema 1 profiles were saved: validated when present, never required.
const OPTIONAL_LISTS = { achievements: ['name'] };
const TOP = ['schema_version', 'updated_at', 'identity', 'education', 'experience', 'projects', 'skills', 'certifications', 'resume', 'preferences', 'provenance', 'open_questions'];
const OUTREACH = ['pitch', 'tone', 'sender_email', 'signature'];

/** Returns problems. Only confirmed facts (provenance resume or user_stated) may be saved. */
export function validateProfile(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['profile is not an object'];
  for (const k of TOP) if (!(k in p)) errs.push(`missing "${k}"`);
  if (errs.length) return errs;
  const lists = { ...LISTS, ...Object.fromEntries(Object.entries(OPTIONAL_LISTS).filter(([k]) => k in p)) };
  for (const [list, req] of Object.entries(lists)) {
    if (!Array.isArray(p[list])) { errs.push(`${list} must be an array`); continue; }
    p[list].forEach((e, i) => {
      for (const r of req) if (!e[r] || typeof e[r] !== 'string') errs.push(`${list}[${i}].${r} is required`);
      if (!PROV.includes(e.provenance)) errs.push(`${list}[${i}].provenance must be one of ${PROV.join('/')} (unconfirmed facts are not saved; put the question in open_questions)`);
    });
  }
  const pr = p.preferences;
  for (const k of ['target_roles', 'locations', 'remote_types', 'industries', 'excluded_companies', 'deal_breakers']) if (!Array.isArray(pr?.[k])) errs.push(`preferences.${k} must be an array`);
  for (const k of ['employment_types', 'company_types']) if (pr?.[k] !== undefined && !Array.isArray(pr[k])) errs.push(`preferences.${k} must be an array`);
  for (const r of pr?.remote_types ?? []) if (!REMOTE.includes(r)) errs.push(`preferences.remote_types: "${r}" not in ${REMOTE.join('/')}`);
  for (const k of ['earliest_start', 'latest_start']) if (pr?.[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(pr[k])) errs.push(`preferences.${k} must be YYYY-MM-DD or null`);
  if (pr?.earliest_start && pr?.latest_start && pr.earliest_start > pr.latest_start) errs.push('preferences.earliest_start is after latest_start');
  for (const k of ['duration_weeks_min', 'duration_weeks_max', 'weekly_hours_max']) if (pr?.[k] != null && !(Number.isInteger(pr[k]) && pr[k] > 0)) errs.push(`preferences.${k} must be a positive integer or null`);
  if (pr?.show_gpa != null && typeof pr.show_gpa !== 'boolean') errs.push('preferences.show_gpa must be true, false or null');
  if (pr?.resume_template != null && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(String(pr.resume_template))) errs.push('preferences.resume_template must be a template name (see apply-store.mjs templates) or null');
  if (pr?.relocation != null && typeof pr.relocation !== 'string') errs.push('preferences.relocation must be text or null');
  if (p.identity?.languages !== undefined && !Array.isArray(p.identity.languages)) errs.push('identity.languages must be an array');
  if (p.outreach !== undefined) {
    if (!p.outreach || typeof p.outreach !== 'object') errs.push('outreach must be an object');
    else for (const k of OUTREACH) if (p.outreach[k] != null && typeof p.outreach[k] !== 'string') errs.push(`outreach.${k} must be text or null`);
    if (p.outreach?.sender_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.outreach.sender_email)) errs.push('outreach.sender_email is not an email address');
  }
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

/**
 * Setup questions as choice cards, in the order they are asked. `answered_by` is the provenance key that marks a
 * question answered (even if the answer is "none"); `stage` says what the answer is used for.
 */
export const allQuestions = (p) => [
  // ---- search and scoring ----
  { field: 'target_roles', stage: 'search', answered_by: 'preferences.target_roles', header: 'Roles', multiSelect: true,
    question: 'Which kinds of roles do you want to look for?',
    options: [opt('Software engineering', 'Backend, full-stack, mobile'), opt('Machine learning / AI', 'ML, computer vision, data science'), opt('Data / analytics', 'Data engineering, analysis'), opt('Product / design / other', 'Choose Other and name them')],
    maps_to: 'preferences.target_roles (write the roles in the user\'s words)' },
  { field: 'employment_types', stage: 'search', answered_by: 'preferences.employment_types', header: 'Job type', multiSelect: true,
    question: 'Which kinds of positions should the search include?',
    options: [opt('Full-time internship', 'Including summer internships'), opt('Part-time internship', 'Alongside college'), opt('Freelance or contract', 'Paid project work'), opt('Apprenticeship or trainee', '')],
    maps_to: 'preferences.employment_types (the labels chosen; part-time roles are kept by scoring only when "Part-time" is here)' },
  { field: 'weekly_hours', stage: 'search', answered_by: 'preferences.weekly_hours_max', header: 'Hours', multiSelect: false,
    question: 'For part-time roles, how many hours a week can you work at most?',
    options: [opt('Up to 10 hours', ''), opt('Up to 20 hours', ''), opt('Up to 30 hours', ''), opt('Not looking for part-time', 'Skip')],
    maps_to: 'preferences.weekly_hours_max (integer; null when not looking for part-time). Ask only if employment_types includes part-time; otherwise mark it answered with null.' },
  { field: 'locations', stage: 'search', answered_by: 'preferences.locations', header: 'Location', multiSelect: true,
    question: 'Where do you want to work?',
    options: [opt(p.identity?.location ? `Near ${p.identity.location}` : 'My city', 'Onsite or hybrid close to home'), opt('Anywhere in my country', 'Any city'), opt('Outside my country', 'Needs work authorization there'), opt('Remote only', 'No relocation')],
    maps_to: 'preferences.locations (put the city or country first, e.g. "Pune, India"; scoring matches on it)' },
  { field: 'remote_types', stage: 'search', answered_by: 'preferences.remote_types', header: 'Work mode', multiSelect: true,
    question: 'Which work arrangements are acceptable?',
    options: [opt('Onsite', ''), opt('Hybrid', ''), opt('Remote', '')], maps_to: 'preferences.remote_types (onsite, hybrid, remote)' },
  { field: 'relocation', stage: 'search', answered_by: 'preferences.relocation', header: 'Relocation', multiSelect: false,
    question: 'Would you move for an internship?',
    options: [opt('No', 'Only near home or remote'), opt('Within my state', ''), opt('Anywhere in my country', ''), opt('Abroad too', 'If the employer can sponsor')],
    maps_to: 'preferences.relocation (the user\'s words). "No" also adds "Roles needing relocation" to deal_breakers.' },
  { field: 'industries', stage: 'search', answered_by: 'preferences.industries', header: 'Industries', multiSelect: true,
    question: 'Which industries interest you most?',
    options: [opt('AI / machine learning', ''), opt('Fintech', 'Payments, banking, trading'), opt('SaaS / developer tools', ''), opt('Any industry', 'Not a filter')],
    maps_to: 'preferences.industries (lowercase words, e.g. "fintech"; empty list for Any). Choose Other for health, education, e-commerce, gaming...' },
  { field: 'company_types', stage: 'search', answered_by: 'preferences.company_types', header: 'Companies', multiSelect: true,
    question: 'What kind of companies do you prefer?',
    options: [opt('Early-stage startups', 'Seed to Series A, YC, Techstars'), opt('Growth-stage startups', 'Series B and later, unicorns'), opt('Large companies / MNCs', ''), opt('Any', 'Not a filter')],
    maps_to: 'preferences.company_types (the labels chosen; empty for Any). Startup choices make run-search use startup discovery and freehire startup collections.' },
  { field: 'start_dates', stage: 'scoring', answered_by: 'preferences.earliest_start', header: 'Start date', multiSelect: false,
    question: 'When can you start?',
    options: [opt('Right away', 'Within the next month'), opt('In about 3 months', ''), opt('Next summer', 'May to July'), opt('Flexible', 'No fixed dates')],
    maps_to: 'preferences.earliest_start / latest_start (YYYY-MM-DD). Turn the choice into exact dates WITH the user ("Right away" = today to about a month from now: confirm both dates); leave null for Flexible.' },
  { field: 'duration', stage: 'scoring', answered_by: 'preferences.duration_weeks_min', header: 'Duration', multiSelect: false,
    question: 'How long should the role be?',
    options: [opt('4 to 8 weeks', ''), opt('8 to 12 weeks', ''), opt('3 to 6 months', ''), opt('Flexible', '')],
    maps_to: 'preferences.duration_weeks_min / max (integers: 4-8, 8-12, 13-26; null for Flexible)' },
  { field: 'stipend', stage: 'scoring', answered_by: 'preferences.min_stipend_text', header: 'Stipend', multiSelect: false,
    question: 'Do you have a pay requirement?',
    options: [opt('Paid only', 'Skip unpaid roles'), opt('Any, including unpaid', 'Pay is not a filter'), opt('Minimum amount', 'Choose Other and type it, e.g. 15000 INR per month')],
    maps_to: 'preferences.min_stipend_text (the user\'s words; null for Any). "Paid only" also adds "Unpaid roles" to deal_breakers.' },
  { field: 'work_authorization', stage: 'search', answered_by: 'identity.work_authorization.status', header: 'Work permit', multiSelect: false,
    question: 'Which describes your work authorization?',
    options: [opt('Authorized in my own country only', 'No sponsorship needed there'), opt('Authorized in my country; open to sponsorship elsewhere', ''), opt('Need sponsorship everywhere', '')],
    maps_to: 'identity.work_authorization (status, countries, needs_sponsorship; countries from the user)' },
  { field: 'filters', stage: 'search', answered_by: 'preferences.deal_breakers', header: 'Filters', multiSelect: true,
    question: 'Anything to exclude or avoid?',
    options: [opt('Unpaid roles', ''), opt('Roles needing relocation', ''), opt('Specific companies', 'Choose Other and list them'), opt('Nothing to exclude', '')],
    maps_to: 'preferences.deal_breakers / excluded_companies (the user\'s words; empty list for "Nothing")' },
  // ---- applications ----
  { field: 'achievements', stage: 'apply', answered_by: 'achievements', header: 'Awards', multiSelect: false,
    question: 'Do you have certifications, awards, hackathon results or scholarships that are not on your resume?',
    options: [opt('Yes, I will list them', 'Name, issuer or event, and date for each'), opt('No, the resume has everything', '')],
    maps_to: 'certifications[] / achievements[] entries with provenance user_stated, in the user\'s exact words (name, issuer or description, date). Never add one the user did not state.' },
  { field: 'show_gpa', stage: 'apply', answered_by: 'preferences.show_gpa', header: 'CGPA', multiSelect: false,
    question: 'Should tailored resumes show your CGPA or percentage?',
    options: [opt('Show it', ''), opt('Hide it', 'Only share when a form asks')],
    maps_to: 'preferences.show_gpa (true or false). The value itself comes only from the resume or the user.' },
  { field: 'resume_template', stage: 'apply', answered_by: 'preferences.resume_template', header: 'Resume look', multiSelect: false,
    question: 'Which resume template should tailored resumes use?',
    options: [opt("Jake's Resume", 'Classic one-page software-engineering layout, serif (default)'), opt('Harvard', 'Career-office classic, education first, serif'), opt('Modern', 'Clean sans-serif with an accent colour'), opt('My own template', 'Put template.json + template.css in resume-templates/<name>/ in the data folder')],
    maps_to: 'preferences.resume_template: jake, harvard, modern, or the folder name of a template the user added (null keeps the default, jake). Offer node scripts/apply-store.mjs preview-template <name> so the user can see each one with their own profile first.' },
  { field: 'languages', stage: 'apply', answered_by: 'identity.languages', header: 'Languages', multiSelect: true,
    question: 'Which languages can you work in?',
    options: [opt('English', ''), opt('Hindi', ''), opt('Another language', 'Choose Other and name it')],
    maps_to: 'identity.languages (names as the user gives them)' },
  // ---- outreach ----
  { field: 'pitch', stage: 'outreach', answered_by: 'outreach.pitch', header: 'Pitch', multiSelect: false,
    question: 'Do you want a one-line introduction for recruiter messages and cover letters?',
    options: [opt('Write one with me', 'Draft from confirmed facts, you edit and confirm it'), opt('Skip for now', '')],
    maps_to: 'outreach.pitch (the user\'s confirmed sentence; it may only mention confirmed profile facts)' },
  { field: 'tone', stage: 'outreach', answered_by: 'outreach.tone', header: 'Tone', multiSelect: false,
    question: 'What tone should recruiter messages use?',
    options: [opt('Formal', ''), opt('Friendly and professional', ''), opt('Short and direct', '')], maps_to: 'outreach.tone' },
  { field: 'sender', stage: 'outreach', answered_by: 'outreach.sender_email', header: 'Send from', multiSelect: false,
    question: 'Which email address should recruiter messages come from?',
    options: [opt(p.identity?.email ? `My resume email (${p.identity.email})` : 'My resume email', ''), opt('A different address', 'Choose Other and type it'), opt('I will send them myself', 'Copy-ready drafts only')],
    maps_to: 'outreach.sender_email (null for "send myself"). Connecting that mailbox is a separate step: /integrations.' },
  { field: 'signature', stage: 'outreach', answered_by: 'outreach.signature', header: 'Signature', multiSelect: false,
    question: 'How should messages be signed?',
    options: [opt('Name, phone and LinkedIn', ''), opt('Name and email', ''), opt('Name only', '')],
    maps_to: 'outreach.signature (the lines exactly; only confirmed identity fields)' },
  { field: 'follow_up', stage: 'outreach', answered_by: 'outreach.follow_up', header: 'Follow-up', multiSelect: false,
    question: 'If a recruiter does not reply, when should a follow-up be suggested?',
    options: [opt('After 7 days', 'Recommended'), opt('After 10 days', ''), opt('After 14 days', ''), opt('Never', '')],
    maps_to: 'run: node scripts/followup-store.mjs set-prefs --after-days N --note "<user words>" (skip for Never). Each follow-up is still approved one by one.' },
];

export const preferenceQuestions = (p) => allQuestions(p).filter((q) => !(q.answered_by in (p.provenance ?? {})));

/** What is still missing, per stage. Nothing here is guessed: each item says what to ask. */
export function profileGaps(p, { followPrefs = null, resumeExists = true } = {}) {
  const prov = p.provenance ?? {}, pr = p.preferences ?? {};
  const stages = { search: [], scoring: [], apply: [], outreach: [], submit: [] };
  const ask = (stage, field, why) => stages[stage].push({ field, why });
  for (const m of checkReadiness(p).missing) ask('search', m, 'required before /run-search can run');
  for (const q of preferenceQuestions(p)) ask(q.stage, q.field, `not asked yet: "${q.question}"`);
  if ('preferences.earliest_start' in prov && !pr.earliest_start && !pr.latest_start) ask('scoring', 'start_dates', 'no exact start dates, so start dates are not scored; confirm earliest and latest start (YYYY-MM-DD) unless the user is truly flexible');
  if ('preferences.duration_weeks_min' in prov && pr.duration_weeks_min == null && pr.duration_weeks_max == null) ask('scoring', 'duration', 'no duration range (Flexible), so duration is not scored; fine if intended');
  if ('preferences.industries' in prov && !(pr.industries ?? []).length) ask('scoring', 'industries', 'no industries, so the industry part of the score is skipped');
  if ((pr.target_roles ?? []).length === 1) ask('scoring', 'target_roles', `only one target role ("${pr.target_roles[0]}"); titles outside it score low on role fit`);
  if (!(p.education ?? []).some((e) => PROV.includes(e.provenance) && /^\d{4}/.test(e.end_date ?? ''))) ask('scoring', 'education.end_date', 'no confirmed graduation date, so graduation-year requirements stay unknown');
  for (const k of ['email', 'phone']) if (!p.identity?.[k] || !(`identity.${k}` in prov)) ask('apply', `identity.${k}`, 'not confirmed; resumes and forms need it');
  if (!(p.projects ?? []).length && !(p.experience ?? []).length) ask('apply', 'projects/experience', 'nothing to tailor from');
  if (!p.identity?.work_authorization?.status) ask('submit', 'work_authorization', 'forms ask; eligibility answers need the user\'s own words');
  if (!p.resume?.source_path || !resumeExists) ask('submit', 'resume', 'no resume file on record');
  if (!followPrefs && !('outreach.follow_up' in prov)) ask('outreach', 'follow_up', 'follow-up timing not set (followup-store set-prefs)');
  const dedupe = (l) => l.filter((x, i) => l.findIndex((y) => y.field === x.field) === i);
  const res = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, { complete: !dedupe(v).length, missing: dedupe(v) }]));
  return { complete: Object.values(res).every((s) => s.complete) && !(p.open_questions ?? []).length, stages: res, open_questions: p.open_questions ?? [],
    next: preferenceQuestions(p).length ? 'run profile-store.mjs questions and ask the unanswered cards (profile-setup step 4)' : null };
}

function gapsText(g) {
  const L = [`Profile gaps (${g.complete ? 'complete' : 'incomplete'})`];
  for (const [stage, s] of Object.entries(g.stages)) {
    L.push('', `${stage}: ${s.complete ? 'nothing missing' : `${s.missing.length} missing`}`);
    for (const m of s.missing) L.push(`  - ${m.field}: ${m.why}`);
  }
  if (g.open_questions.length) L.push('', 'Open questions:', ...g.open_questions.map((q) => `  - ${q}`));
  if (g.next) L.push('', `Next: ${g.next}`);
  return L.join('\n');
}

try {
  if (cmd === 'questions') {
    const qs = preferenceQuestions(readJson(profilePath));
    const batches = [];
    for (let i = 0; i < qs.length; i += 4) batches.push(qs.slice(i, i + 4));
    out({ unanswered: qs.map((q) => q.field), batches });
  } else if (cmd === 'gaps') {
    const p = readJson(profilePath);
    const fp = join(dir, 'preferences.json');
    const g = profileGaps(p, { followPrefs: existsSync(fp) ? readJson(fp) : null, resumeExists: !!p.resume?.source_path && existsSync(join(dir, p.resume.source_path)) });
    process.argv.includes('--text') ? console.log(gapsText(g)) : out(g);
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
    console.error('usage: profile-store.mjs show | questions | gaps [--text] | attach-resume <file> | save <profile.json>');
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
