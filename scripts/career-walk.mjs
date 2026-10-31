#!/usr/bin/env node
// Walks employers' own career pages, and re-opens recorded postings to verify them. Our own fetcher: no extra installs.
//   node scripts/career-walk.mjs find <site>... [--file <data>/career-sites.txt] [--from-bundle <search-bundle.json>] [--max-pages 6] [--max-jobs 15] [--no-render] [--save]
//   node scripts/career-walk.mjs verify <job_id>... | --status discovered[,verified] [--limit 20] [--no-render] [--save]
// <site> is "example.com", "Company Name=https://example.com" or a careers URL ("Name=https://example.com/careers").
// find:   locates each site's careers page, detects the job board behind it (Greenhouse, Lever, Ashby, SmartRecruiters,
//         Workable) and reads its internship postings through the board's public API, otherwise opens internship
//         links on the careers page itself. Writes a bundle, an ingest draft, and a board-suggestions file.
//         --from-bundle walks the sites of the results of an earlier search (for example Agent Reach web search).
// verify: re-opens each job's posting (board API when the URL is a known board, else the page) and writes an ingest
//         draft that marks it verified (title found on the live page), expired (404/410 or a closed notice), or
//         leaves it unverified with the reason. Ingest that draft to update jobs.csv, then approve-job.
// Both honour robots.txt, send one request per second per host, and stop contacting a host after a 429. A page our
// fetch reached but that needs JavaScript is read once more through Agent Reach (Jina Reader) unless --no-render;
// pages behind a login, a robots.txt rule or a block are reported, never worked around and never guessed.
// Next: agent-reach-search.mjs check <draft> <bundle> --fix <out>, then search-store.mjs ingest <out>. --save does both.
// Logic: scripts/lib/careerwalk.mjs. Data directory: $INTERNSHIP_AGENT_HOME, else <repo>/private. Exit 0 ok, 2 refused, 1 error.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { dataDir, isoNow } from './lib/data.mjs';
import { RefusedError } from './lib/ingest.mjs';
import { agentReachReader } from './lib/walker.mjs';
import { writeSuggestions } from './lib/discovery.mjs';
import { parseSite, sitesFromBundle, findSites, rowsToVerify, verifyJobs, readJson } from './lib/careerwalk.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const out = (o) => console.log(JSON.stringify(o, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const positional = () => args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const reader = () => { if (args.includes('--no-render')) return null; const r = agentReachReader(); return r ? async (url) => r(url) : null; };

function writeDraft(dir, label, { searches, candidates, jobs }) {
  const s = isoNow().replace(/[:]/g, '');
  const bundleFile = join(dir, `search-bundle-${label}-${s}.json`);
  const draftFile = join(dir, `ingest-${label}-${s}.json`);
  writeFileSync(bundleFile, JSON.stringify({ collected_at: isoNow(), tool: `career-walk:${label}`, searches, candidates }, null, 2));
  writeFileSync(draftFile, JSON.stringify({ run: { started_at: isoNow(), harness: 'claude-code' }, searches, jobs }, null, 2));
  const files = { bundle: bundleFile, ingest_draft: draftFile, next: `node scripts/agent-reach-search.mjs check "${draftFile}" "${bundleFile}" --fix "${draftFile.replace('.json', '.checked.json')}"` };
  return args.includes('--save') ? { ...files, ...save(draftFile, bundleFile) } : files;
}

/** --save: run the same fact check and ingest the skill would run next, and report both. */
function save(draftFile, bundleFile) {
  const node = (script, ...a) => spawnSync(process.execPath, [join(import.meta.dirname, script), ...a], { encoding: 'utf8', env: process.env });
  const fixed = draftFile.replace('.json', '.checked.json');
  const c = node('agent-reach-search.mjs', 'check', draftFile, bundleFile, '--fix', fixed);
  let check; try { check = JSON.parse(c.stdout); } catch { return { saved: false, error: `check failed: ${c.stderr.slice(0, 300)}` }; }
  const i = node('search-store.mjs', 'ingest', fixed);
  if (i.status !== 0) return { saved: false, check_problems: check.problems, error: `ingest ${i.status === 2 ? 'refused' : 'failed'}: ${i.stderr.trim().slice(0, 300)}` };
  const r = JSON.parse(i.stdout);
  return { saved: true, check_problems: check.problems, run_id: r.run_id, stats: r.stats, decisions: r.decisions, skipped: r.skipped };
}

async function find() {
  const dir = dataDir();
  const specs = positional().map(parseSite);
  const file = flag('--file');
  if (file) specs.push(...readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(parseSite));
  if (flag('--from-bundle')) specs.push(...sitesFromBundle(readJson(flag('--from-bundle')), specs));
  if (!specs.length) { console.error('no sites: pass example.com or "Name=https://example.com", --file <list> or --from-bundle <bundle>'); process.exit(1); }
  const r = await findSites(dir, specs, { maxPages: Number(flag('--max-pages') ?? 6), maxJobs: Number(flag('--max-jobs') ?? 15) }, { reader: reader() });
  const sugg = r.boards.length ? writeSuggestions(dir, 'career-page walk', r.boards).file : null;
  out({ ...writeDraft(dir, 'walk', r), board_suggestions: sugg, sites: r.report, jobs: r.jobs.length, verified_candidates: r.jobs.filter((j) => j.opened_source).length,
    fetch_log: r.log.filter((l) => l.code !== 'OK').slice(0, 30),
    ...(sugg ? { add_boards: `After the user approves: node scripts/feed-search.mjs add-boards "${sugg}" --pick B1 --note "<their words>"` } : {}) });
}

async function verify() {
  const dir = dataDir();
  const ids = positional(), statuses = (flag('--status') ?? '').split(',').filter(Boolean);
  if (!ids.length && !statuses.length) { console.error('nothing to verify: pass job ids or --status discovered'); process.exit(1); }
  const { rows, skipped } = rowsToVerify(dir, ids, statuses, Number(flag('--limit') ?? 20));
  if (!rows.length) { out({ results: [], skipped_user_owned: skipped, note: 'no job to verify' }); return; }
  const r = await verifyJobs(rows, { reader: reader() });
  out({ ...(r.jobs.length ? writeDraft(dir, 'verify', r) : {}), results: r.results, skipped_user_owned: skipped,
    then: 'After ingest, approve a verified job only with the user\'s words: node scripts/apply-store.mjs approve-job <job_id> --note "<their words>"' });
}

try {
  if (cmd === 'find') await find();
  else if (cmd === 'verify') await verify();
  else { console.error('usage: career-walk.mjs find <site>... [--file list] [--from-bundle bundle] [--max-pages N] [--max-jobs N] [--no-render] [--save] | verify <job_id>... | --status discovered [--limit N] [--no-render] [--save]'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(e instanceof RefusedError ? 2 : 1); }
