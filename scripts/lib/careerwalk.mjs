// Career-page search and posting verification (the logic behind scripts/career-walk.mjs).
// Network access only through deps: { fetchImpl, reader, sleep }. Tests pass fakes; the CLI passes the real ones.
// Returns the searches, bundle candidates and ingest jobs; writing files and ingesting is the caller's job.
import { join } from 'node:path';
import { isoNow, loadCsvSchemas } from './data.mjs';
import { readJson, readTable, RefusedError } from './ingest.mjs';
import { makeGetJson, detectBoards, parseCompany, readBoard, postingLookup, titleCase, ADAPTERS } from './ats.mjs';
import { createWalker, findCareerPages, internLinks, siteOrigin, INTERN, CLOSED } from './walker.mjs';
import { knownBoards, AGGREGATORS } from './discovery.mjs';

export const MIN_TEXT = 200;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const has = (text, v) => !!norm(v) && ` ${norm(text)} `.includes(` ${norm(v)} `);
const CORP = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|co)\b\.?/gi;

// Technology terms looked for, as whole words, in posting text. Scoring compares them with the profile's skills.
const VOCAB = ['Python', 'Java', 'JavaScript', 'TypeScript', 'C++', 'C#', 'Go', 'Golang', 'Rust', 'Kotlin', 'Swift', 'Ruby', 'PHP', 'Scala', 'R', 'SQL', 'NoSQL', 'HTML', 'CSS',
  'React', 'React.js', 'Next.js', 'Angular', 'Vue', 'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot', '.NET', 'Rails', 'Flutter', 'React Native', 'Android', 'iOS',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Kafka', 'Elasticsearch', 'GraphQL', 'REST', 'gRPC', 'Docker', 'Kubernetes', 'Terraform', 'AWS', 'GCP', 'Azure', 'Linux', 'Git', 'CI/CD',
  'Machine Learning', 'Deep Learning', 'NLP', 'Computer Vision', 'LLM', 'LLMs', 'PyTorch', 'TensorFlow', 'Keras', 'scikit-learn', 'Pandas', 'NumPy', 'Spark', 'Hadoop', 'Airflow', 'Tableau', 'Power BI', 'Excel',
  'OpenCV', 'Hugging Face', 'LangChain', 'RAG', 'Data Analysis', 'Statistics', 'Figma', 'Selenium', 'Playwright', 'Jest', 'Embedded C', 'MATLAB', 'Solidity', 'Blockchain'];
const vocabRe = VOCAB.map((t) => [t, new RegExp(`(^|[^\\p{L}\\p{N}+#.])${t.replace(/[.+*?^${}()|[\]\\/]/g, '\\$&')}(?![\\p{L}\\p{N}+#]|\\.[\\p{L}\\p{N}])`, `u${t.length <= 3 ? '' : 'i'}`)]);
export const skillsIn = (text) => vocabRe.filter(([, re]) => re.test(text)).map(([t]) => t);

/** "Location: Bengaluru, India" style lines; the value must then appear in the text, which the check confirms. */
export function locationIn(text) {
  const m = /^\s*(?:job\s+)?location\s*[:\-–]\s*([^\n]{2,80})$/im.exec(text);
  const loc = m?.[1].trim().replace(/[.;]$/, '');
  const remote = /\b(fully remote|remote[- ]first|work from home|100% remote)\b/i.test(text) || /^remote$/i.test(loc ?? '') ? 'remote' : /\bhybrid\b/i.test(loc ?? '') ? 'hybrid' : undefined;
  return { location: loc && !/^remote$/i.test(loc) ? loc : undefined, remote_type: remote };
}

const pageText = (p) => [`URL: ${p.url}`, p.title ? `Page title: ${p.title}` : '', '', p.text].filter((x) => x !== '').join('\n');
const siteName = (html) => (/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i.exec(html) ?? [])[1] ?? null;

/** "Company=https://site", "site.com" or a careers URL. */
export function parseSite(spec) {
  const [a, b] = String(spec).split(/=(.*)/s);
  return b ? { name: a.trim(), site: b.trim() } : { name: null, site: a.trim() };
}

/** Employer sites behind the results of an earlier search bundle (aggregators and social sites left out). */
export function sitesFromBundle(bundle, already = []) {
  const seen = new Set(already.map((s) => siteOrigin(s.site)));
  const out = [];
  for (const c of bundle.candidates ?? []) {
    try { const u = new URL(c.url); if (!seen.has(u.origin) && !AGGREGATORS.test(u.hostname)) { seen.add(u.origin); out.push({ name: null, site: u.origin }); } } catch { /* not a URL */ }
  }
  return out;
}

const defaults = (deps) => ({ fetchImpl: deps.fetchImpl ?? fetch, reader: deps.reader ?? null, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) });

/** Walk each site's careers page. Returns { searches, candidates, jobs, boards, report, log }. */
export async function findSites(dir, specs, { maxPages = 6, maxJobs = 15 } = {}, deps = {}) {
  const { fetchImpl, reader, sleep } = defaults(deps);
  const walker = createWalker({ fetchImpl, sleep });
  const getJson = makeGetJson(fetchImpl);
  const known = knownBoards(join(dir, 'companies.txt'));
  const searches = [], candidates = [], jobs = [], boards = [], report = [];

  for (const [i, s] of specs.entries()) {
    const key = `s${i + 1}`;
    const search = { key, source_name: `career page: ${s.name ?? s.site}`, query: `careers page of ${s.site}`, filters: 'internship-like titles', status: 'completed', notes: '' };
    searches.push(search);
    const rep = { site: s.site, company: s.name, careers_pages: [], boards: [], postings: 0, problems: [] };
    report.push(rep);
    let found;
    try { found = await findCareerPages(walker, s.site, { maxPages }); } catch (e) { search.status = 'failed'; search.error = e.message; rep.problems.push(e.message); continue; }
    rep.careers_pages = found.pages.map((p) => p.url);
    if (!found.pages.length) {
      search.status = 'failed';
      search.error = `no careers page reached (${found.tried.map((t) => `${t.url} ${t.code}`).join('; ').slice(0, 250)})`;
      rep.problems.push(search.error);
      continue;
    }
    // A careers page built by JavaScript arrives as an empty shell: read it once more, rendered, through Agent Reach.
    if (reader && !found.pages.some((p) => detectBoards(p.html).length || internLinks(p).length)) {
      const shell = found.pages.find((p) => p.text.length < 1500) ?? found.pages[0];
      const r = await reader(shell.url);
      if (r.ok) { found.pages.push(r); rep.rendered = `${shell.url} via ${r.via}`; }
      else rep.render_error = `${shell.url}: ${r.code} ${r.error}`;
    }
    const meta = siteName(found.pages[0].html);
    const company = s.name ?? (meta && meta.length <= 30 && !/[|:–]/.test(meta) ? meta : null) ?? titleCase(new URL(siteOrigin(s.site)).hostname.replace(/^www\./, '').split('.')[0]);
    const named = !!s.name;

    // 1. Job boards behind the careers page: read them through their public API.
    const specsHere = [...new Set(found.pages.flatMap((p) => detectBoards(p.html)))].slice(0, 2);
    for (const spec of specsHere) {
      const c = { ...parseCompany(spec), name: company };
      const b = { spec: `${spec}=${company}`, company, found_on: found.pages[0].url, board_url: ADAPTERS[c.provider].board(c.slug), listings: 0, collections: [], countries: [], work_modes: [], titles: [] };
      try {
        const { jobs: list, total } = await readBoard(getJson, c, { match: INTERN, sleep });
        b.probe = { ok: true, checked_at: isoNow(), postings: total, intern_matches: list.length, sample: list.slice(0, 3).map((j) => j.title) };
        for (const m of list.slice(0, maxJobs)) {
          if (candidates.some((x) => x.url === m.source_url)) continue;
          const read = (m.description ?? '').length >= MIN_TEXT;
          const text = [`Title: ${m.title}`, `Company: ${company}`, m.location ? `Location: ${m.location}` : '', m.remote_type ? `Work mode: ${m.remote_type}` : '', m.commitment ? `Employment type: ${m.commitment}` : '',
            m.posted_date ? `Posted: ${m.posted_date}` : '', `Apply: ${m.apply_url ?? m.source_url}`, '', m.description ?? ''].filter((x) => x !== '').join('\n');
          candidates.push({ search_key: key, url: m.source_url, title: m.title, published_at: m.posted_date ?? null, read_ok: read, texts: [{ provider: `${c.provider}-api`, kind: 'page_text', text }] });
          const remote = String(m.remote_type ?? '').toLowerCase();
          jobs.push({ search_key: key, source_name: `${c.provider} board of ${company}`, source_kind: 'company_site', source_url: m.source_url, apply_url: m.apply_url ?? m.source_url,
            company, title: m.title, location: m.location || undefined, remote_type: ['remote', 'hybrid', 'onsite'].includes(remote) ? remote : 'unknown',
            employment_type: /intern|co-?op|trainee/i.test(`${m.title} ${m.commitment}`) ? 'internship' : /apprentice/i.test(m.title) ? 'apprenticeship' : 'other', employment_label: m.commitment || undefined,
            posted_date: m.posted_date ?? undefined, opened_source: read, skills: skillsIn(m.description ?? ''),
            verification_notes: read ? `Found via ${found.pages[0].url}; read the employer's own ${c.provider} board entry (title and description).` : undefined,
            uncertainties: named ? '' : 'Company name taken from the site, not given by the user; confirm it.' });
          rep.postings += 1;
        }
      } catch (e) { b.probe = { ok: false, checked_at: isoNow(), error: e.message }; rep.problems.push(`${spec}: ${e.message}`); }
      rep.boards.push(spec);
      if (!known.has(spec.toLowerCase())) boards.push(b);
      await sleep(1000);
    }

    // 2. No usable board: open internship links on the careers page itself.
    if (!specsHere.length) {
      const links = found.pages.flatMap((p) => internLinks(p, maxJobs)).filter((l, k, a) => a.findIndex((x) => x.url === l.url) === k).slice(0, maxJobs);
      if (!links.length) search.notes = `careers page reached (${found.pages.map((p) => p.url).join(', ')}) but no internship links on it${found.pages.every((p) => p.text.length < MIN_TEXT) ? '; the page has almost no text, it probably needs JavaScript' : ''}`;
      for (const l of links) {
        const lookup = postingLookup(l.url);
        let text = '', title = l.text, ok = false, closed = false, how = '';
        if (lookup) {
          const r = await lookup.read(getJson).catch((e) => ({ error: e.message }));
          if (r.error) { rep.problems.push(`${l.url}: ${r.error}`); continue; }
          ({ text, closed } = r); title = r.title ?? title; ok = text.length >= MIN_TEXT; how = `${lookup.provider} board API`;
        } else {
          let p = await walker.get(l.url);
          if (!p.ok) { rep.problems.push(`${l.url}: ${p.error}`); if (p.code === 'RATE_LIMITED') break; continue; }
          if (p.text.length < MIN_TEXT && reader) { const r = await reader(l.url); if (r.ok) p = r; }
          text = pageText(p); ok = p.text.length >= MIN_TEXT; closed = CLOSED.test(p.text); how = p.via ? `the page, rendered by ${p.via}` : 'the page';
          if (!has(p.text, title) && p.title && INTERN.test(p.title)) title = p.title.split(/\s[|–-]\s/)[0].trim();
        }
        if (!title || !INTERN.test(title)) continue;
        const seen = has(text, title);
        candidates.push({ search_key: key, url: l.url, title, published_at: null, read_ok: ok, texts: [{ provider: 'career-walk', kind: 'page_text', text: `Company: ${company}\nLinked from ${found.pages[0].url} as "${l.text}"\n${text}` }] });
        const where = ok ? locationIn(text) : {};
        jobs.push({ search_key: key, source_name: `career page of ${company}`, source_kind: 'company_site', source_url: l.url, apply_url: l.url, company, title,
          location: where.location, remote_type: where.remote_type ?? 'unknown', skills: ok ? skillsIn(text) : [],
          employment_type: /intern|co-?op|trainee/i.test(title) ? 'internship' : /apprentice/i.test(title) ? 'apprenticeship' : 'other',
          opened_source: ok && seen, closed,
          verification_notes: ok && seen ? `Opened ${l.url} (${how}) on ${isoNow().slice(0, 10)}; the text contains the title "${title}"${closed ? ' and a closed notice' : ''}.` : undefined,
          uncertainties: [named ? '' : 'Company name taken from the site; confirm it.', ok ? '' : 'Page returned little text (may need JavaScript); not verified.', seen ? '' : 'Title not found in the page text.'].filter(Boolean).join(' ') });
        rep.postings += 1;
      }
    }
    if (rep.problems.length && search.status === 'completed') { search.status = 'partial'; search.error = rep.problems.join('; ').slice(0, 300); }
  }
  return { searches, candidates, jobs, boards, report, log: walker.log };
}

/** Rows to verify: given ids (refused if unknown), or every job with one of the statuses. applied/archived are skipped. */
export function rowsToVerify(dir, ids = [], statuses = [], limit = 20) {
  const all = readTable(dir, 'jobs.csv', loadCsvSchemas()['jobs.csv']).records;
  let rows = ids.length ? ids.map((id) => all.find((j) => j.job_id === id) ?? { job_id: id, missing: true }) : all.filter((j) => statuses.includes(j.status));
  const missing = rows.filter((r) => r.missing).map((r) => r.job_id);
  if (missing.length) throw new RefusedError(`no such job: ${missing.join(', ')}`);
  const skipped = rows.filter((r) => ['applied', 'archived'].includes(r.status)).map((r) => `${r.job_id} (${r.status})`);
  rows = rows.filter((r) => !['applied', 'archived'].includes(r.status)).slice(0, limit);
  return { rows, skipped };
}

/**
 * Re-open each posting. Outcomes: verified (live text contains the title), closed (404/410, closed notice, or the board
 * no longer lists it), unverified (reached, but too little text or no title), not_reached (nothing is changed).
 */
export async function verifyJobs(rows, deps = {}) {
  const { fetchImpl, reader, sleep } = defaults(deps);
  const walker = createWalker({ fetchImpl, sleep });
  const getJson = makeGetJson(fetchImpl);
  const today = (deps.now ?? isoNow()).slice(0, 10);
  const searches = [{ key: 's1', source_name: 'career-walk verify', query: `re-open ${rows.length} recorded posting(s)`, filters: '', status: 'completed', notes: '' }];
  const candidates = [], jobs = [], results = [];
  for (const j of rows) {
    const res = { job_id: j.job_id, company: j.company, title: j.title, url: j.source_url };
    let text = '', closed = false, how = '', ok = false, code = null;
    let lookup = postingLookup(j.source_url) ?? (j.apply_url ? postingLookup(j.apply_url) : null);
    if (!lookup) {
      let p = await walker.get(j.source_url);
      if (p.ok) {
        lookup = postingLookup(p.url, p.html);
        if (!lookup && reader && (p.text.length < MIN_TEXT || !has(p.text, j.title))) { const r = await reader(j.source_url); if (r.ok) p = { ...r, url: p.url }; }
        text = pageText(p); ok = p.text.length >= MIN_TEXT; closed = CLOSED.test(p.text); how = `opened ${p.url}${p.via ? ` (rendered by ${p.via})` : ''}`;
      } else {
        code = p.code;
        if (['HTTP_404', 'HTTP_410'].includes(p.code)) { closed = true; how = `${j.source_url} returned ${p.code.replace('_', ' ')}`; }
        else { res.outcome = 'not_reached'; res.reason = `${p.code}: ${p.error}`; results.push(res); continue; }
      }
    }
    // A board posting (also one embedded in an employer page via gh_jid) is read from the board's public API.
    if (lookup && (!ok || !has(text, j.title))) {
      const r = await lookup.read(getJson).catch((e) => ({ error: e.message }));
      if (r.error) { if (!how) { res.outcome = 'not_reached'; res.reason = r.error; results.push(res); continue; } }
      else { text = [text, `Board record (${lookup.provider} public API):`, r.text].filter(Boolean).join('\n\n'); closed = closed || r.closed; ok = ok || r.text.length >= MIN_TEXT || r.closed; how = [how, `${lookup.provider} board API`].filter(Boolean).join('; '); }
    }
    const seen = has(text, j.title);
    const companySeen = has(text, j.company.replace(CORP, ''));
    candidates.push({ search_key: 's1', url: j.source_url, title: j.title, published_at: null, read_ok: ok, ...(code ? { read_error: code } : {}),
      texts: text ? [{ provider: 'career-walk', kind: 'page_text', text }] : [] });
    const job = { search_key: 's1', existing_job_id: j.job_id, source_name: j.source_name, source_kind: j.source_kind, source_url: j.source_url, company: j.company, title: j.title };
    if (closed) {
      Object.assign(job, { closed: true, opened_source: ok, verification_notes: ok ? `Re-opened on ${today} via ${how}: the posting is closed or gone.` : undefined });
      res.outcome = 'closed'; res.reason = how;
    } else if (ok && seen) {
      Object.assign(job, { opened_source: true, verification_notes: `Re-opened on ${today} via ${how}; the live text contains the title "${j.title}"${companySeen ? ` and "${j.company}"` : ''}.`,
        uncertainties: companySeen ? '' : `The company name "${j.company}" was not seen on the page; confirm it.` });
      res.outcome = 'verified';
    } else {
      Object.assign(job, { opened_source: false, uncertainties: ok ? `Re-opened on ${today}: the title was not found on the page.` : `Re-opened on ${today}: the page returned too little text (likely needs JavaScript or a login).` });
      res.outcome = 'unverified'; res.reason = job.uncertainties;
    }
    jobs.push(job);
    results.push(res);
  }
  const notReached = results.filter((r) => r.outcome === 'not_reached');
  if (notReached.length) { searches[0].status = notReached.length === results.length ? 'failed' : 'partial'; searches[0].error = notReached.map((r) => `${r.job_id}: ${r.reason}`).join('; ').slice(0, 300); }
  return { searches, candidates, jobs, results, log: walker.log };
}

export { readJson };
