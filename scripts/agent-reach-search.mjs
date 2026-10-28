#!/usr/bin/env node
// Runs the vendored Agent Reach CLI for run-search and guards what reaches jobs.csv.
//   node scripts/agent-reach-search.mjs collect [--query "<q>"]... [--limit N] [--max-reads N]
//   node scripts/agent-reach-search.mjs check <ingest.json> <bundle.json> [--fix <out.json>]
// collect: searches with `agent-reach web search`, reads each result with `agent-reach read`,
//          and writes a bundle of exactly what Agent Reach returned (nothing added by us).
// check:   every text field of every job must appear in the bundle text for its source_url.
//          --fix writes a copy with unmatched fields removed and listed in unverified_fields.
// Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Prints JSON. Exit 0 ok, 1 error/mismatch.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dataDir, isoNow } from './lib/data.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const flagAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

function agentReach(...a) {
  const name = process.platform === 'win32' ? 'agent-reach.exe' : 'agent-reach';
  const local = join(homedir(), '.local', 'bin', name);
  const exe = existsSync(local) ? local : name;
  const r = spawnSync(exe, a, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (r.error) return { ok: false, error: { code: 'NOT_INSTALLED', hint: `${r.error.message}; install with: uv tool install --force vendor/agent-reach` } };
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); }
  catch { return { ok: false, error: { code: 'BAD_OUTPUT', hint: (r.stderr || r.stdout || '').slice(0, 300) } }; }
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function collect() {
  const queries = flagAll('--query');
  const limit = Number(flag('--limit') ?? 10);
  const maxReads = Number(flag('--max-reads') ?? 15);
  if (!queries.length) {
    const profile = readJson(join(dataDir(), 'candidate-profile.json'));
    const roles = profile.preferences?.target_roles ?? [];
    const locs = profile.preferences?.locations ?? [];
    for (const r of roles) queries.push(`${r} internship${locs.length ? ' ' + locs.join(' ') : ''}`);
  }
  if (!queries.length) { console.error('no queries: pass --query "<text>" or set preferences.target_roles in the profile'); process.exit(1); }

  const searches = [];
  const candidates = new Map();
  queries.forEach((q, i) => {
    const key = `s${i + 1}`;
    const res = agentReach('web', 'search', q, '--limit', String(limit));
    const items = res.ok ? (res.items ?? []) : [];
    searches.push({ key, source_name: 'Agent Reach web search', query: q, status: res.ok ? 'completed' : 'failed',
      ...(res.ok ? {} : { error: `${res.error?.code}: ${res.error?.hint ?? res.error?.message ?? ''}`.trim() }), result_count: items.length });
    for (const it of items) {
      if (!it.url || candidates.has(it.url)) continue;
      candidates.set(it.url, { search_key: key, url: it.url, title: it.title ?? null, published_at: it.published_at ?? null,
        texts: it.text ? [{ provider: 'agent-reach', kind: 'search_text', text: it.text }] : [] });
    }
  });

  let reads = 0;
  const list = [...candidates.values()];
  for (const c of list) {
    if (reads >= maxReads) { c.read_ok = false; c.read_error = 'not read: --max-reads reached'; continue; }
    reads += 1;
    const r = agentReach('read', c.url);
    c.read_ok = !!(r.ok && r.items?.[0]?.text);
    if (c.read_ok) c.texts.push({ provider: 'agent-reach', kind: 'page_text', backend: r.backend ?? null, text: r.items[0].text });
    if (!c.read_ok) c.read_error = r.ok ? 'empty text' : `${r.error?.code}: ${r.error?.hint ?? ''}`.trim();
    if (r.error && ['PLATFORM_BLOCKED', 'RATE_LIMITED', 'NEED_LOGIN', 'BUSY'].includes(r.error.code)) c.stop_code = r.error.code;
  }

  const file = join(dataDir(), `search-bundle-${isoNow().replace(/[:]/g, '')}.json`);
  const bundle = { collected_at: isoNow(), tool: 'agent-reach', searches, candidates: list };
  writeFileSync(file, JSON.stringify(bundle, null, 2));
  out({ bundle: file, searches: searches.map(({ key, query, status, error, result_count }) => ({ key, query, status, error, result_count })),
    candidates: list.length, read_ok: list.filter((c) => c.read_ok).length, stopped: list.filter((c) => c.stop_code).map((c) => ({ url: c.url, code: c.stop_code })) });
}

const TEXT_FIELDS = ['title', 'company', 'location', 'duration', 'stipend_text', 'eligibility_text', 'qualifications_text', 'apply_url'];
const DATE_FIELDS = ['start_date', 'posted_date', 'deadline'];

function check() {
  const [ingestFile, bundleFile] = args;
  if (!ingestFile || !bundleFile) { console.error('usage: check <ingest.json> <bundle.json> [--fix <out.json>]'); process.exit(1); }
  const input = readJson(ingestFile);
  const bundle = readJson(bundleFile);
  const byUrl = new Map(bundle.candidates.map((c) => [c.url, c]));
  const problems = [];
  const fixed = structuredClone(input);

  fixed.jobs = (fixed.jobs ?? []).map((j) => {
    const c = byUrl.get(j.source_url);
    if (!c) { problems.push({ source_url: j.source_url, field: 'source_url', reason: 'not in the bundle' }); return null; }
    const haystack = norm(`${c.title ?? ''} ${c.texts.filter((t) => t.kind !== 'llm_extracted').map((t) => t.text).join(' ')}`);
    const llmHay = norm(c.texts.filter((t) => t.kind === 'llm_extracted').map((t) => t.text).join(' '));
    const bodyOk = !!c.read_ok;
    const removed = [];
    for (const f of TEXT_FIELDS) {
      if (j[f] == null || j[f] === '') continue;
      const v = norm(j[f]);
      if (haystack.includes(v) || (f === 'apply_url' && v === norm(j.source_url))) continue;
      if (llmHay.includes(v)) { removed.push(f); problems.push({ source_url: j.source_url, field: f, value: j[f], reason: 'only in LLM-extracted text (ScrapeGraphAI); kept, marked unverified', kept: true }); continue; }
      problems.push({ source_url: j.source_url, field: f, value: j[f], reason: 'value not found in any provider text' });
      delete j[f]; removed.push(f);
    }
    for (const f of DATE_FIELDS) {
      if (!j[f]) continue;
      const [y, m, d] = String(j[f]).split('-');
      const ok = haystack.includes(norm(j[f])) || (haystack.includes(y) && new RegExp(`\\b0?${Number(m)}\\b|${['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][Number(m) - 1]}`, 'i').test(haystack) && new RegExp(`\\b0?${Number(d)}\\b`).test(haystack));
      if (!ok) { problems.push({ source_url: j.source_url, field: f, value: j[f], reason: 'date not found in any provider text' }); delete j[f]; removed.push(f); }
    }
    if (j.opened_source && !bodyOk) {
      problems.push({ source_url: j.source_url, field: 'opened_source', reason: `no provider returned the page body (${c.read_error ?? 'no read'})` });
      j.opened_source = false; removed.push('opened_source');
    }
    if (removed.length) j.unverified_fields = [...new Set([...(j.unverified_fields ?? []), ...removed.filter((x) => x !== 'opened_source')])];
    return j;
  }).filter(Boolean);

  const outFile = flag('--fix');
  if (outFile) writeFileSync(outFile, JSON.stringify(fixed, null, 2));
  out({ ok: problems.length === 0, checked_jobs: (input.jobs ?? []).length, problems, fixed_file: outFile ?? null });
  process.exit(problems.length ? 1 : 0);
}

// Record text from another provider for a URL already in the bundle.
//   add-page <bundle.json> <url> <provider> <textfile> [--llm]
// --llm marks the text as LLM-extracted (ScrapeGraphAI): values found only there stay unverified.
function addText(bundleFile, url, provider, text, llm) {
  const bundle = readJson(bundleFile);
  let c = bundle.candidates.find((x) => x.url === url);
  if (!c) { c = { search_key: bundle.searches[0]?.key, url, title: null, published_at: null, texts: [] }; bundle.candidates.push(c); }
  c.texts.push({ provider, kind: llm ? 'llm_extracted' : 'page_text', text });
  if (!llm && text.length >= 200) { c.read_ok = true; delete c.read_error; }
  writeFileSync(bundleFile, JSON.stringify(bundle, null, 2));
  return { url, provider, kind: llm ? 'llm_extracted' : 'page_text', chars: text.length, read_ok: !!c.read_ok };
}

function addPage() {
  const [bundleFile, url, provider, textFile] = args;
  if (!bundleFile || !url || !provider || !textFile) { console.error('usage: add-page <bundle.json> <url> <provider> <textfile> [--llm]'); process.exit(1); }
  out(addText(bundleFile, url, provider, readFileSync(textFile, 'utf8'), args.includes('--llm')));
}

// Fetch one page with Scrapling's plain Fetcher (scripts/scrapling_fetch.py) and record it.
//   scrapling <bundle.json> <url>
function scrapling() {
  const [bundleFile, url] = args;
  if (!bundleFile || !url) { console.error('usage: scrapling <bundle.json> <url>'); process.exit(1); }
  const py = process.env.SCRAPLING_PYTHON || join(homedir(), '.venvs', 'scrapling', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const r = spawnSync(py, ['-I', join(import.meta.dirname, 'scrapling_fetch.py'), url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  let res;
  try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { res = { ok: false, error: r.error?.message || r.stderr?.slice(0, 300) || 'no output' }; }
  if (!res.ok) { out({ ok: false, url, provider: 'scrapling', error: res.error }); process.exit(1); }
  out({ ok: true, ...addText(bundleFile, url, 'scrapling', res.text, false), http_status: res.status });
}

try {
  if (cmd === 'collect') collect();
  else if (cmd === 'check') check();
  else if (cmd === 'add-page') addPage();
  else if (cmd === 'scrapling') scrapling();
  else { console.error('usage: agent-reach-search.mjs collect [--query q]... | scrapling <bundle> <url> | add-page <bundle> <url> <provider> <file> [--llm] | check <ingest.json> <bundle.json> [--fix out.json]'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(1); }

