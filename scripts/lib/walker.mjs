// Career-page walker: fetches public employer pages politely, finds the careers page, the job board behind it,
// and internship postings on it. robots.txt is honoured; each host gets at most one request per second;
// nothing is sent but the GET itself. Network access only through the injected fetchImpl (tests pass a fake).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UA, plain, detectBoards } from './ats.mjs';

export const INTERN = /\b(intern(ship)?s?|trainee|apprentice(ship)?s?|fresher|co-?op|part[- ]?time|student|working student|graduate program)\b/i;
const CAREER_LINK = /\b(careers?|jobs|join (us|our team|the team)|work with us|we('| a)re hiring|open (roles|positions)|openings|vacancies|hiring)\b/i;
const CAREER_PATHS = ['/careers', '/jobs', '/company/careers', '/about/careers', '/join-us', '/work-with-us'];
export const CLOSED = /\b(no longer (accepting applications|available|open|active)|(position|role|job|posting|vacancy) (has been |is )?(filled|closed|expired)|this (job|posting|position) (has )?(expired|closed)|applications (are )?closed|job not found)\b/i;
const MAX_CHARS = 3_000_000;
const AGENT = 'internship-agent-personal';

/** Parse robots.txt and decide whether `path` may be fetched. Longest matching rule wins; Allow wins a tie. */
export function robotsAllows(txt, path, agent = AGENT) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [k, v] = [m[1].toLowerCase(), m[2].trim()];
    if (k === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else if ((k === 'allow' || k === 'disallow') && cur) {
      lastWasAgent = false;
      if (v) cur.rules.push({ allow: k === 'allow', path: v });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    const re = new RegExp(`^${r.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$')}`);
    if (!re.test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

/** Links in a page, resolved against its URL: [{ url, text }]. Same-page anchors and non-http links are dropped. */
export function pageLinks(html, base) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url; try { url = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, text: plain(m[2]).replace(/\s+/g, ' ').slice(0, 200) });
  }
  return out;
}

const pageTitle = (html) => plain((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? [])[1] ?? '').replace(/\s+/g, ' ');

/**
 * A polite fetcher. get(url) resolves to { ok, status, url (final), html, text, title } or { ok: false, code, error }.
 * Codes: ROBOTS_DISALLOWED, HTTP_<status>, RATE_LIMITED, NOT_HTML, NETWORK.
 */
export function createWalker({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), perHostMs = 1000, timeoutMs = 20000 } = {}) {
  const robots = new Map(), last = new Map(), stopped = new Set();
  const log = [];

  async function polite(host) {
    const wait = (last.get(host) ?? 0) + perHostMs - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());
  }

  async function raw(url, accept) {
    const u = new URL(url);
    await polite(u.host);
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    return res;
  }

  async function allowed(url) {
    const u = new URL(url);
    if (!robots.has(u.origin)) {
      let txt = '';
      try {
        const r = await raw(`${u.origin}/robots.txt`, 'text/plain');
        // 4xx means no rules; 5xx or a network failure means stay away (RFC 9309).
        if (r.ok) txt = (await r.text()).slice(0, 500_000);
        else if (r.status >= 500) txt = 'User-agent: *\nDisallow: /';
      } catch { txt = 'User-agent: *\nDisallow: /'; }
      robots.set(u.origin, txt);
    }
    return robotsAllows(robots.get(u.origin), u.pathname + u.search);
  }

  async function get(url) {
    try {
      // After a 429 the host is left alone for the rest of the run: no retries, no more pages.
      if (stopped.has(new URL(url).host)) { log.push({ url, code: 'RATE_LIMITED' }); return { ok: false, url, code: 'RATE_LIMITED', error: 'this site asked us to slow down (429) earlier in the run; not contacted again' }; }
      if (!(await allowed(url))) { log.push({ url, code: 'ROBOTS_DISALLOWED' }); return { ok: false, url, code: 'ROBOTS_DISALLOWED', error: 'robots.txt disallows this page' }; }
      const res = await raw(url, 'text/html,application/xhtml+xml');
      if (res.status === 429) { stopped.add(new URL(url).host); log.push({ url, code: 'RATE_LIMITED' }); return { ok: false, url, status: 429, code: 'RATE_LIMITED', error: `HTTP 429 (Retry-After ${res.headers.get('retry-after') ?? '?'})` }; }
      if (!res.ok) { log.push({ url, code: `HTTP_${res.status}` }); return { ok: false, url, status: res.status, code: `HTTP_${res.status}`, error: `HTTP ${res.status}` }; }
      const type = res.headers.get('content-type') ?? '';
      if (type && !/html|xml|text\/plain/i.test(type)) { log.push({ url, code: 'NOT_HTML' }); return { ok: false, url, status: res.status, code: 'NOT_HTML', error: `content-type ${type}` }; }
      const html = (await res.text()).slice(0, MAX_CHARS);
      log.push({ url, code: 'OK' });
      return { ok: true, status: res.status, url: res.url || url, html, text: plain(html), title: pageTitle(html) };
    } catch (e) {
      log.push({ url, code: 'NETWORK' });
      return { ok: false, url, code: 'NETWORK', error: e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : e.message };
    }
  }

  return { get, log, allowed };
}

/**
 * Rendered reading through Agent Reach (`agent-reach read`, Jina Reader backend), for pages that need JavaScript.
 * Only for pages robots.txt allowed and that our fetch reached; never to get past a block, login or 429.
 * Returns a reader (url) => page like walker.get, or null when Agent Reach is not installed.
 * The URL is sent to Agent Reach's reader service: public career pages only, never anything private.
 */
export function agentReachReader({ spawn = spawnSync, exe = null } = {}) {
  const name = process.platform === 'win32' ? 'agent-reach.exe' : 'agent-reach';
  const local = join(homedir(), '.local', 'bin', name);
  const bin = exe ?? (existsSync(local) ? local : null);
  if (!bin) return null;
  return (url) => {
    const r = spawn(bin, ['read', url], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    let res;
    try { res = JSON.parse(String(r.stdout ?? '').trim().split('\n').pop()); } catch { return { ok: false, url, code: 'READER_FAILED', error: (r.error?.message ?? r.stderr ?? 'no output').slice(0, 200) }; }
    const md = res.ok ? res.items?.[0]?.text ?? '' : '';
    if (!md) return { ok: false, url, code: res.error?.code ?? 'READER_FAILED', error: res.error?.hint ?? res.error?.message ?? 'empty text' };
    // Markdown links become anchors so the same link and board detection applies.
    const html = md.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]{1,200})\]\((https?:[^)\s]+)[^)]*\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
    return { ok: true, status: 200, url, html, text: plain(html), title: (/^Title:\s*(.+)$/m.exec(md) ?? [])[1] ?? '', via: `agent-reach ${res.backend ?? ''}`.trim() };
  };
}

/** Normalise "example.com", "https://example.com/x" to an origin URL. */
export function siteOrigin(site) {
  const s = String(site).trim();
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return u.origin;
}

/**
 * Find a company's careers page(s): the site's own careers links first, then common paths.
 * Returns { pages: [{ url, html, text, title }], tried: [{ url, code }] }. At most `maxPages` fetches.
 */
export async function findCareerPages(walker, site, { maxPages = 6 } = {}) {
  const origin = siteOrigin(site);
  const tried = [], pages = [];
  let budget = maxPages;
  const visit = async (url) => {
    if (budget <= 0 || tried.some((t) => t.url === url)) return null;
    budget -= 1;
    const r = await walker.get(url);
    tried.push({ url, code: r.ok ? 'OK' : r.code });
    return r.ok ? r : null;
  };
  const isCareerish = (r) => CAREER_LINK.test(`${r.title} ${new URL(r.url).hostname.split('.')[0]} ${new URL(r.url).pathname}`) || detectBoards(r.html).length > 0;

  // A careers URL given directly (a path, or a careers./jobs. host) is used as is.
  if (/^https?:\/\//i.test(site) && (new URL(site).pathname.length > 1 || /^(careers?|jobs)\./i.test(new URL(site).hostname))) {
    const r = await visit(new URL(site).toString());
    if (r) pages.push(r);
    return { pages, tried };
  }
  const home = await visit(`${origin}/`);
  const queue = home ? pageLinks(home.html, home.url).filter((l) => CAREER_LINK.test(`${l.text} ${new URL(l.url).pathname}`)).map((l) => l.url) : [];
  if (home && detectBoards(home.html).length) pages.push(home);
  for (const p of CAREER_PATHS) queue.push(`${origin}${p}`);
  for (const url of [...new Set(queue)]) {
    if (pages.length >= 2 || budget <= 0) break;
    const r = await visit(url);
    if (r && isCareerish(r) && !pages.some((p) => p.url === r.url)) pages.push(r);
  }
  return { pages, tried };
}

/** Internship-like posting links on a careers page (same site or a known job board). */
export function internLinks(page, max = 15) {
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  return pageLinks(page.html, page.url)
    .filter((l) => INTERN.test(l.text) || INTERN.test(decodeURIComponent(new URL(l.url).pathname).replace(/[-_/]+/g, ' ')))
    .filter((l) => { const h = new URL(l.url).hostname.replace(/^www\./, ''); return h === host || h.endsWith(`.${host}`) || detectBoards(l.url).length > 0; })
    .slice(0, max);
}
