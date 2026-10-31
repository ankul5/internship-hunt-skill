#!/usr/bin/env node
// Collects internship and part-time listings from public job feeds for run-search, and discovers startup job boards.
//   node scripts/feed-search.mjs freehire [--param key=value]... [--limit 50] [--pages 1] [--label "<text>"]
//   node scripts/feed-search.mjs ats <provider:slug[=Company Name]>... [--file companies.txt] [--match "<regex>"]
//   node scripts/feed-search.mjs discover [--collections yc,techstars,indian-roots] [--param key=value]... [--pages 1] [--max-probe 25]
//   node scripts/feed-search.mjs add-boards <board-suggestions.json> --pick B1,B3|all --note "<user words>"
// freehire: queries the public freehire.me API (no key, personal use) for listings crawled from employers' own boards.
// ats:      reads the employer's own public feed: greenhouse, lever, ashby, smartrecruiters or workable. Not login-gated, no key.
// discover: finds startups hiring interns (freehire collections and startup facets), works out each one's own job board,
//           checks that the board answers, and writes a suggestions file. Nothing is added until add-boards.
// add-boards: appends the suggestions the user approved to companies.txt (backup first).
// freehire and ats write a bundle (what the feed returned) and an ingest draft into the data directory, then print their paths.
// Next: agent-reach-search.mjs check <draft> <bundle> --fix <out>, then search-store.mjs ingest <out>.
// Requests are sequential, one per second per host, with an identifying User-Agent. Nothing is sent but the query.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, isoNow } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { makeGetJson, plain, day, parseCompany, readBoard, ADAPTERS } from './lib/ats.mjs';
import { knownBoards, groupFreehire, writeSuggestions, addBoards } from './lib/discovery.mjs';
import { skillsIn } from './lib/careerwalk.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const flagAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const FREEHIRE = 'https://freehire.me/api/v1/jobs/search';
const DEFAULT_MATCH = String.raw`\b(intern(ship)?s?|trainee|apprentice(ship)?s?|fresher|co-?op|part[- ]?time|student)\b`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = makeGetJson();
const clean = (u) => { try { const x = new URL(u); x.searchParams.delete('utm_source'); return x.toString(); } catch { return u; } };

function render(f) {
  const lines = [['Title', f.title], ['Company', f.company], ['Location', f.location], ['Work mode', f.remote_type], ['Employment type', f.employment_label],
    ['Posted', f.posted_date], ['Apply', f.apply_url], ['Skills', (f.skills ?? []).join(', ')]].filter(([, v]) => v);
  return `${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${(f.description ?? '').slice(0, 6000)}`;
}

function finish(label, runs) {
  const searches = [], candidates = [], jobs = [];
  runs.forEach((r, i) => {
    const key = `s${i + 1}`;
    searches.push({ key, source_name: r.source_name, query: r.query, filters: r.filters, status: r.error ? 'failed' : 'completed', ...(r.error ? { error: r.error } : {}), result_count: r.items.length });
    for (const f of r.items) {
      if (candidates.some((c) => c.url === f.source_url)) continue;
      candidates.push({ search_key: key, url: f.source_url, title: f.title, published_at: f.posted_date ?? null, read_ok: !!f.description,
        texts: [{ provider: r.provider, kind: 'page_text', text: render(f) }] });
      const { description, ...job } = f;
      jobs.push({ search_key: key, ...job });
    }
  });
  const stamp = isoNow().replace(/[:]/g, '');
  const dir = dataDir();
  const bundleFile = join(dir, `search-bundle-${label}-${stamp}.json`);
  const draftFile = join(dir, `ingest-${label}-${stamp}.json`);
  writeFileSync(bundleFile, JSON.stringify({ collected_at: isoNow(), tool: `feed-search:${label}`, searches, candidates }, null, 2));
  writeFileSync(draftFile, JSON.stringify({ run: { started_at: isoNow(), harness: 'claude-code' }, searches, jobs }, null, 2));
  out({ bundle: bundleFile, ingest_draft: draftFile, searches: searches.map(({ key, query, status, error, result_count }) => ({ key, query, status, error, result_count })), jobs: jobs.length,
    next: `node scripts/agent-reach-search.mjs check "${draftFile}" "${bundleFile}" --fix "${draftFile.replace('.json', '.checked.json')}"` });
}

// ---- freehire.me ----------------------------------------------------------------------------
const TYPE_MAP = { internship: 'internship', fellowship: 'other', part_time: 'other', contract: 'other', full_time: 'other' };

function fromFreehire(d) {
  const e = d.enrichment ?? {};
  const type = TYPE_MAP[e.employment_type] ?? 'unknown';
  const url = clean(d.url);
  // A Greenhouse posting embedded in an employer page (?gh_jid=<id>) has a board URL that the public API can verify;
  // freehire's external_id is "<board>:<id>". Used only when the ids agree, so it is never a guess.
  const [slug, gid] = String(d.external_id ?? '').split(':');
  let board = null;
  try { if (d.source === 'greenhouse' && /^\d+$/.test(gid ?? '') && (new URL(url).searchParams.get('gh_jid') === gid || /greenhouse\.io$/.test(new URL(url).hostname))) board = `https://job-boards.greenhouse.io/${slug}/jobs/${gid}`; } catch { /* not a URL */ }
  return {
    source_name: `freehire.me (${d.source})`, source_kind: 'job_board', source_url: url, apply_url: board ?? url,
    company: d.company, title: d.title, location: d.location || undefined, remote_type: ['remote', 'hybrid', 'onsite'].includes(d.work_mode) ? d.work_mode : 'unknown',
    employment_type: type, employment_label: e.employment_type, posted_date: day(d.posted_at) ?? undefined, description: plain(d.description),
    skills: d.skills ?? [], industry: (e.domains ?? [])[0],
    opened_source: false, closed: !!d.closed_at,
    uncertainties: 'Record from the freehire.me aggregator (crawled from the employer board); the original posting was not opened. Verify it with career-walk.mjs verify.',
  };
}

async function freehirePages(params, limit, pages) {
  const data = []; let error, total = null;
  for (let p = 0; p < pages; p++) {
    const qs = new URLSearchParams([...params, ['limit', String(limit)], ['offset', String(p * limit)]]);
    try {
      const r = await getJson(`${FREEHIRE}?${qs}`);
      total = r.meta?.total ?? total;
      data.push(...r.data);
      if (r.data.length < limit) break;
    } catch (e) { error = e.message; break; }
    await sleep(1000);
  }
  return { data, error, total };
}

async function freehire() {
  const params = flagAll('--param').map((p) => p.split(/=(.*)/s).slice(0, 2));
  if (!params.some(([k]) => k === 'employment_type')) params.unshift(['employment_type', 'internship']);
  const limit = Math.min(Number(flag('--limit') ?? 50), 100);
  const { data, error } = await freehirePages(params, limit, Number(flag('--pages') ?? 1));
  const filters = params.map(([k, v]) => `${k}=${v}`).join('&');
  finish('freehire', [{ provider: 'freehire-api', source_name: 'freehire.me API', query: flag('--label') ?? filters, filters, items: data.map(fromFreehire), ...(error ? { error } : {}) }]);
}

// ---- employer ATS feeds ---------------------------------------------------------------------

function toItem(m, provider, sourceName, named) {
  const remote = String(m.remote_type ?? '').toLowerCase();
  return {
    source_name: sourceName, source_kind: 'company_site', source_url: clean(m.source_url), apply_url: clean(m.apply_url ?? m.source_url),
    company: m.company, title: m.title, location: m.location || undefined, remote_type: ['remote', 'hybrid', 'onsite'].includes(remote) ? remote : 'unknown',
    employment_type: /intern|co-?op|apprentice|trainee/i.test(`${m.title} ${m.commitment}`) ? (/apprentice/i.test(m.title) ? 'apprenticeship' : 'internship') : 'other',
    employment_label: m.commitment || undefined, posted_date: m.posted_date ?? undefined, description: m.description, skills: skillsIn(m.description ?? ''),
    opened_source: !!m.description, verification_notes: m.description ? `Read the employer's own ${provider} feed entry; title, location and description are from it.` : undefined,
    uncertainties: named ? '' : 'Company name derived from the board slug; confirm it.',
  };
}

async function ats() {
  const specs = [...args.filter((a) => !a.startsWith('--') && /^[a-z]+:/.test(a))];
  const file = flag('--file');
  if (file) specs.push(...readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  if (!specs.length) { console.error('no companies: pass <provider>:<slug> or --file <list>'); process.exit(1); }
  const match = new RegExp(flag('--match') ?? DEFAULT_MATCH, 'i');
  const runs = [];
  for (const spec of specs) {
    const c = parseCompany(spec);
    const run = { provider: `${c.provider}-feed`, source_name: `${c.provider} feed: ${c.slug}`, query: `${c.provider}:${c.slug} /${match.source}/`, filters: `match=${match.source}`, items: [] };
    try {
      const { jobs } = await readBoard(getJson, c, { match, sleep });
      run.items = jobs.map((m) => toItem(m, c.provider, run.source_name, !!c.name));
    } catch (e) { run.error = `${c.provider}:${c.slug} ${e.message}`; }
    runs.push(run);
    await sleep(1000);
  }
  finish('ats', runs);
}

// ---- startup discovery ----------------------------------------------------------------------

const DEFAULT_COLLECTIONS = ['yc', 'techstars', 'indian-roots', 'a16z-portfolio'];

async function discover() {
  const dir = dataDir();
  const collections = (flag('--collections') ?? DEFAULT_COLLECTIONS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const extra = flagAll('--param').map((p) => p.split(/=(.*)/s).slice(0, 2));
  const pages = Number(flag('--pages') ?? 1), maxProbe = Number(flag('--max-probe') ?? 25);
  const queries = [...collections.map((c) => [['collections', c]]), [['company_type', 'startup']]].map((q) => [['employment_type', 'internship'], ...q, ...extra]);
  const searches = [], records = [];
  for (const q of queries) {
    const { data, error, total } = await freehirePages(q, 100, pages);
    searches.push({ query: q.map(([k, v]) => `${k}=${v}`).join('&'), status: error ? 'failed' : 'completed', error, listings: data.length, total });
    records.push(...data);
    await sleep(1000);
  }
  const { boards, leads } = groupFreehire(records, knownBoards(join(dir, 'companies.txt')));
  const match = new RegExp(DEFAULT_MATCH, 'i');
  for (const b of boards.slice(0, maxProbe)) {
    try {
      const { jobs, total } = await readBoard(getJson, parseCompany(b.spec), { match, details: 0 });
      b.probe = { ok: true, checked_at: isoNow(), postings: total, intern_matches: jobs.length, sample: jobs.slice(0, 3).map((j) => j.title) };
    } catch (e) { b.probe = { ok: false, checked_at: isoNow(), error: e.message }; }
    b.board_url = ADAPTERS[parseCompany(b.spec).provider].board(parseCompany(b.spec).slug);
    await sleep(1000);
  }
  for (const b of boards.slice(maxProbe)) b.probe = { ok: false, error: `not probed (over --max-probe ${maxProbe})` };
  const { file } = writeSuggestions(dir, 'startup discovery (freehire.me)', boards, leads.slice(0, 50));
  out({ suggestions: file, searches, boards: boards.map((b, i) => ({ id: `B${i + 1}`, spec: b.spec, company: b.company, collections: b.collections, freehire_listings: b.listings, probe: b.probe })),
    leads_without_supported_board: leads.length, leads_with_site: leads.filter((l) => l.site).slice(0, 15).map((l) => ({ company: l.company, site: l.site, source: l.source })),
    next: `Show the user the boards; after they approve: node scripts/feed-search.mjs add-boards "${file}" --pick B1,B2 --note "<their words>". Leads with a site can be walked: node scripts/career-walk.mjs find "<Company>=<site>"` });
}

try {
  if (cmd === 'freehire') await freehire();
  else if (cmd === 'ats') await ats();
  else if (cmd === 'discover') await discover();
  else if (cmd === 'add-boards') out(addBoards(dataDir(), args[0], (flag('--pick') ?? '').split(',').map((s) => s.trim()).filter(Boolean), flag('--note')));
  else { console.error('usage: feed-search.mjs freehire [--param k=v]... [--limit N] [--pages N] | ats <provider:slug>... [--file list] [--match regex] | discover [--collections a,b] [--param k=v]... [--max-probe N] | add-boards <suggestions.json> --pick B1,B2|all --note "<user words>"'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(e instanceof RefusedError ? 2 : 1); }
