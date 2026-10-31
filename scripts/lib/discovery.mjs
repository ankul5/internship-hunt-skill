// Startup discovery: turns freehire.me records and career-page findings into job-board suggestions,
// and adds the ones the user approves to companies.txt. Suggestions are never added without the user's words.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { boardFromFreehire, parseCompany } from './ats.mjs';
import { isoNow } from './data.mjs';
import { RefusedError } from './ingest.mjs';

/** Job boards, aggregators and social sites: not an employer's own website. */
export const AGGREGATORS = /(^|\.)(freehire\.me|linkedin\.com|indeed\.[a-z.]+|naukri\.com|iimjobs\.com|internshala\.com|wellfound\.com|glassdoor\.[a-z.]+|workatastartup\.com|ycombinator\.com|startup\.jobs|simplyhired\.[a-z.]+|builtin\.com|thejobcompany\.[a-z.]+|foundit\.in|shine\.com|unstop\.com|cutshort\.io|instahyre\.com|google\.com|youtube\.com|reddit\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|medium\.com|github\.com|himalayas\.app|t\.me|telegram\.[a-z]+|jobstreet\.[a-z.]+|whatjobs\.com|djinni\.co|career\.habr\.com|wuzzuf\.net|join\.com|dover\.com|careers-page\.com|keka\.com|freshteam\.com|recruitee\.com|applytojob\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|myworkdayjobs\.com|oraclecloud\.com|successfactors\.[a-z.]+)$/i;

const key = (spec) => spec.split('=')[0].trim().toLowerCase();

/** Board specs already in companies.txt (lowercased provider:slug). */
export function knownBoards(file) {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(key));
}

/**
 * Group freehire records by employer board. Returns { boards: [...], leads: [...] }:
 * boards use a supported ATS; leads are startups on other systems, with the employer's own site when the posting URL shows it.
 */
export function groupFreehire(records, known = new Set()) {
  const boards = new Map(), leads = new Map();
  for (const d of records) {
    const spec = boardFromFreehire(d);
    const entry = (map, k, extra) => {
      if (!map.has(k)) map.set(k, { company: d.company, collections: new Set(), countries: new Set(), work_modes: new Set(), titles: [], sample_url: d.url, ...extra });
      const e = map.get(k);
      (d.collections ?? []).forEach((c) => e.collections.add(c));
      (d.countries ?? []).forEach((c) => e.countries.add(c));
      if (d.work_mode) e.work_modes.add(d.work_mode);
      if (e.titles.length < 5 && !e.titles.includes(d.title)) e.titles.push(d.title);
      e.listings = (e.listings ?? 0) + 1;
    };
    if (spec) { if (!known.has(spec.toLowerCase())) entry(boards, spec.toLowerCase(), { spec }); continue; }
    let site = null;
    try { const u = new URL(d.url); if (!AGGREGATORS.test(u.hostname)) site = u.origin; } catch { /* no usable URL */ }
    if (d.company) entry(leads, String(d.company).toLowerCase(), { source: d.source, site });
  }
  const done = (e) => ({ ...e, collections: [...e.collections], countries: [...e.countries], work_modes: [...e.work_modes] });
  return {
    boards: [...boards.values()].map(done).sort((a, b) => b.listings - a.listings),
    leads: [...leads.values()].map(done).sort((a, b) => b.listings - a.listings),
  };
}

/** Write a suggestions file. Entries get ids B1, B2...; only entries whose probe succeeded can be added. */
export function writeSuggestions(dir, origin, boards, leads = [], now = isoNow()) {
  const file = join(dir, `board-suggestions-${now.replace(/[:]/g, '')}.json`);
  const doc = { created_at: now, origin, boards: boards.map((b, i) => ({ id: `B${i + 1}`, ...b })), leads };
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, doc };
}

/**
 * Append approved suggestions to companies.txt. `picks` is "all" or ids such as ["B1", "B3"].
 * Refuses without the user's words, skips entries whose probe failed or that are already listed. Backs up first.
 */
export function addBoards(dir, suggestionsFile, picks, note, { now = isoNow() } = {}) {
  if (!String(note ?? '').trim()) throw new RefusedError('adding boards needs the user\'s words as --note');
  if (!picks?.length) throw new RefusedError('pass --pick B1,B2 (or all) with the suggestions the user approved');
  const doc = JSON.parse(readFileSync(suggestionsFile, 'utf8').replace(/^﻿/, ''));
  const file = join(dir, 'companies.txt');
  const known = knownBoards(file);
  const chosen = picks[0] === 'all' ? doc.boards : picks.map((id) => doc.boards.find((b) => b.id === id) ?? { id, missing: true });
  const added = [], skipped = [];
  for (const b of chosen) {
    if (b.missing) { skipped.push({ id: b.id, reason: 'no such suggestion' }); continue; }
    if (!b.probe?.ok) { skipped.push({ id: b.id, spec: b.spec, reason: `the board was not confirmed to answer (${b.probe?.error ?? 'not probed'})` }); continue; }
    parseCompany(b.spec);
    if (known.has(key(b.spec))) { skipped.push({ id: b.id, spec: b.spec, reason: 'already in companies.txt' }); continue; }
    known.add(key(b.spec));
    added.push(b);
  }
  if (added.length) {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (before) {
      mkdirSync(join(dir, 'backups'), { recursive: true });
      copyFileSync(file, join(dir, 'backups', `companies.txt.${now.replace(/[-:]/g, '')}`));
    }
    const lines = [`# Added ${now.slice(0, 10)} from ${doc.origin} (user: ${String(note).replace(/\s+/g, ' ').trim().slice(0, 120)}); feed answered ${doc.created_at.slice(0, 10)}`,
      ...added.map((b) => (b.spec.includes('=') || !b.company ? b.spec : `${b.spec}=${b.company}`))];
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
    renameSync(tmp, file);
  }
  return { companies_file: file, added: added.map((b) => ({ id: b.id, spec: b.spec, company: b.company })), skipped };
}
