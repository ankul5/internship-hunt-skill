#!/usr/bin/env node
// Collects internship and part-time listings from public job feeds for run-search.
//   node scripts/feed-search.mjs freehire [--param key=value]... [--limit 50] [--pages 1] [--label "<text>"]
//   node scripts/feed-search.mjs ats <provider:slug[=Company Name]>... [--file companies.txt] [--match "<regex>"]
// freehire: queries the public freehire.me API (no key, personal use) for listings crawled from employers' own boards.
// ats:      reads the employer's own public feed: greenhouse, lever or ashby. Not login-gated, no key.
// Both write a bundle (what the feed returned) and an ingest draft into the data directory, then print their paths.
// Next: agent-reach-search.mjs check <draft> <bundle> --fix <out>, then search-store.mjs ingest <out>.
// Requests are sequential, one per second per host, with an identifying User-Agent. Nothing is sent but the query.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, isoNow } from './lib/data.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const flagAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const UA = 'internship-agent-personal/0.1 (personal job search; read-only)';
const FREEHIRE = 'https://freehire.me/api/v1/jobs/search';
const DEFAULT_MATCH = String.raw`\b(intern(ship)?s?|trainee|apprentice(ship)?s?|fresher|co-?op|part[- ]?time|student)\b`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTITIES[e]);
const plain = (html) => decode(decode(String(html ?? '')).replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const day = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const clean = (u) => { try { const x = new URL(u); x.searchParams.delete('utm_source'); return x.toString(); } catch { return u; } };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429) throw new Error(`HTTP 429 rate limited (Retry-After ${res.headers.get('retry-after') ?? '?'})`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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
      const { description, employment_label, ...job } = f;
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
  return {
    source_name: `freehire.me (${d.source})`, source_kind: 'job_board', source_url: url, apply_url: url,
    company: d.company, title: d.title, location: d.location || undefined, remote_type: ['remote', 'hybrid', 'onsite'].includes(d.work_mode) ? d.work_mode : 'unknown',
    employment_type: type, employment_label: e.employment_type, posted_date: day(d.posted_at) ?? undefined, description: plain(d.description),
    skills: d.skills ?? [], industry: (e.domains ?? [])[0],
    opened_source: false, closed: !!d.closed_at,
    uncertainties: 'Record from the freehire.me aggregator (crawled from the employer board); the original posting was not opened.',
  };
}

async function freehire() {
  const params = flagAll('--param').map((p) => p.split(/=(.*)/s).slice(0, 2));
  if (!params.some(([k]) => k === 'employment_type')) params.unshift(['employment_type', 'internship']);
  const limit = Math.min(Number(flag('--limit') ?? 50), 100);
  const pages = Number(flag('--pages') ?? 1);
  const items = []; let error;
  for (let p = 0; p < pages; p++) {
    const qs = new URLSearchParams([...params, ['limit', String(limit)], ['offset', String(p * limit)]]);
    try {
      const r = await getJson(`${FREEHIRE}?${qs}`);
      items.push(...r.data.map(fromFreehire));
      if (r.data.length < limit) break;
    } catch (e) { error = e.message; break; }
    await sleep(1000);
  }
  const filters = params.map(([k, v]) => `${k}=${v}`).join('&');
  finish('freehire', [{ provider: 'freehire-api', source_name: 'freehire.me API', query: flag('--label') ?? filters, filters, items, ...(error ? { error } : {}) }]);
}

// ---- employer ATS feeds ---------------------------------------------------------------------
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const ADAPTERS = {
  greenhouse: {
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
    list: (r) => r.jobs ?? [],
    map: (j, company) => ({ title: j.title, source_url: j.absolute_url, location: j.location?.name, posted_date: day(j.first_published ?? j.updated_at), description: plain(j.content), company: j.company_name || company, commitment: '' }),
  },
  lever: {
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    list: (r) => (Array.isArray(r) ? r : []),
    map: (j, company) => ({ title: j.text, source_url: j.hostedUrl, apply_url: j.applyUrl, location: j.categories?.location, posted_date: day(j.createdAt), commitment: j.categories?.commitment ?? '',
      remote_type: j.workplaceType, description: [j.descriptionPlain, j.additionalPlain].filter(Boolean).join('\n'), company }),
  },
  ashby: {
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    list: (r) => r.jobs ?? [],
    map: (j, company) => ({ title: j.title?.trim(), source_url: j.jobUrl, apply_url: j.applyUrl, location: j.location, posted_date: day(j.publishedAt), commitment: j.employmentType ?? '',
      remote_type: j.isRemote ? 'remote' : undefined, description: j.descriptionPlain, company }),
  },
};

function parseCompany(spec) {
  const [ref, name] = spec.split(/=(.*)/s);
  const [provider, slug] = ref.split(':');
  if (!ADAPTERS[provider] || !slug) throw new Error(`bad company "${spec}": use greenhouse:<slug>, lever:<slug> or ashby:<name>`);
  return { provider, slug, name: name?.trim() || null };
}

async function ats() {
  const specs = [...args.filter((a) => !a.startsWith('--') && /^[a-z]+:/.test(a))];
  const file = flag('--file');
  if (file) specs.push(...readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  if (!specs.length) { console.error('no companies: pass greenhouse:<slug> lever:<slug> ashby:<name> or --file <list>'); process.exit(1); }
  const match = new RegExp(flag('--match') ?? DEFAULT_MATCH, 'i');
  const runs = [];
  for (const spec of specs) {
    const { provider, slug, name } = parseCompany(spec);
    const ad = ADAPTERS[provider];
    const run = { provider: `${provider}-feed`, source_name: `${provider} feed: ${slug}`, query: `${provider}:${slug} /${match.source}/`, filters: `match=${match.source}`, items: [] };
    try {
      const raw = ad.list(await getJson(ad.url(slug)));
      for (const j of raw) {
        const m = ad.map(j, name ?? titleCase(slug));
        if (!m.title || !m.source_url || !match.test(`${m.title} ${m.commitment}`)) continue;
        const remote = String(m.remote_type ?? '').toLowerCase();
        run.items.push({
          source_name: run.source_name, source_kind: 'company_site', source_url: clean(m.source_url), apply_url: clean(m.apply_url ?? m.source_url),
          company: m.company, title: m.title, location: m.location || undefined, remote_type: ['remote', 'hybrid', 'onsite'].includes(remote) ? remote : 'unknown',
          employment_type: /intern|co-?op|apprentice/i.test(`${m.title} ${m.commitment}`) ? (/apprentice/i.test(m.title) ? 'apprenticeship' : 'internship') : 'other',
          employment_label: m.commitment || undefined, posted_date: m.posted_date ?? undefined, description: m.description, skills: [],
          opened_source: !!m.description, verification_notes: m.description ? `Read the employer's own ${provider} feed entry; title, location and description are from it.` : undefined,
          uncertainties: name ? '' : 'Company name derived from the board slug; confirm it.',
        });
      }
    } catch (e) { run.error = `${provider}:${slug} ${e.message}`; }
    runs.push(run);
    await sleep(1000);
  }
  finish('ats', runs);
}

try {
  if (cmd === 'freehire') await freehire();
  else if (cmd === 'ats') await ats();
  else { console.error('usage: feed-search.mjs freehire [--param k=v]... [--limit N] [--pages N] | ats <provider:slug>... [--file list] [--match regex]'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(1); }
