// Public employer job boards (applicant tracking systems): board feeds, single-posting lookups, and board detection.
// Used by feed-search.mjs (board feeds, startup discovery) and career-walk.mjs (career pages, verification).
// Network access only through the injected getJson; every endpoint here is a public, unauthenticated posting API.

export const UA = 'internship-agent-personal/0.1 (personal job search; read-only)';
export const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTITIES[e]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
export const plain = (html) => decode(decode(String(html ?? '')).replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr|\/section)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
export const day = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

export function makeGetJson(fetchImpl = fetch) {
  return async (url) => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429) throw Object.assign(new Error(`HTTP 429 rate limited (Retry-After ${res.headers.get('retry-after') ?? '?'})`), { status: 429 });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
}

const where = (...p) => p.filter(Boolean).join(', ');

/** Board feeds. `map` returns the common shape; `detail` (optional) fetches a description the list leaves out. */
export const ADAPTERS = {
  greenhouse: {
    board: (s) => `https://job-boards.greenhouse.io/${s}`,
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
    list: (r) => r.jobs ?? [],
    map: (j, company) => ({ title: j.title, source_url: j.absolute_url, location: j.location?.name, posted_date: day(j.first_published ?? j.updated_at), description: plain(j.content), company: j.company_name || company, commitment: '' }),
  },
  lever: {
    board: (s) => `https://jobs.lever.co/${s}`,
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    list: (r) => (Array.isArray(r) ? r : []),
    map: (j, company) => ({ title: j.text, source_url: j.hostedUrl, apply_url: j.applyUrl, location: j.categories?.location, posted_date: day(j.createdAt), commitment: j.categories?.commitment ?? '',
      remote_type: j.workplaceType, description: [j.descriptionPlain, j.additionalPlain].filter(Boolean).join('\n'), company }),
  },
  ashby: {
    board: (s) => `https://jobs.ashbyhq.com/${s}`,
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    list: (r) => r.jobs ?? [],
    map: (j, company) => ({ title: j.title?.trim(), source_url: j.jobUrl, apply_url: j.applyUrl, location: j.location, posted_date: day(j.publishedAt), commitment: j.employmentType ?? '',
      remote_type: j.isRemote ? 'remote' : undefined, description: j.descriptionPlain, company }),
  },
  smartrecruiters: {
    board: (s) => `https://careers.smartrecruiters.com/${s}`,
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`,
    list: (r) => r.content ?? [],
    map: (j, company, s) => ({ title: j.name, source_url: `https://jobs.smartrecruiters.com/${s}/${j.id}`, location: j.location?.fullLocation, posted_date: day(j.releasedDate),
      commitment: j.typeOfEmployment?.label ?? '', remote_type: j.location?.remote ? 'remote' : j.location?.hybrid ? 'hybrid' : undefined, description: '', company: j.company?.name && !company ? j.company.name : company, id: j.id }),
    detail: async (m, s, getJson) => srText(await getJson(`https://api.smartrecruiters.com/v1/companies/${s}/postings/${m.id}`)),
  },
  workable: {
    board: (s) => `https://apply.workable.com/${s}`,
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    list: (r) => r.jobs ?? [],
    map: (j, company, s) => ({ title: j.title, source_url: `https://apply.workable.com/${s}/j/${j.shortcode}/`, apply_url: j.application_url, location: where(j.city, j.state, j.country) || undefined,
      posted_date: day(j.published_on ?? j.created_at), commitment: j.employment_type ?? '', remote_type: j.telecommuting ? 'remote' : undefined, description: plain(j.description), company }),
  },
};

const srText = (d) => {
  const sec = d?.jobAd?.sections ?? {};
  return plain(['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'].map((k) => sec[k]?.text).filter(Boolean).join('\n'));
};

export function parseCompany(spec) {
  const [ref, name] = String(spec).split(/=(.*)/s);
  const [provider, slug] = ref.trim().split(':');
  if (!ADAPTERS[provider] || !slug) throw new Error(`bad company "${spec}": use <provider>:<slug>[=Company Name] with provider ${PROVIDERS.join(', ')}`);
  return { provider, slug, name: name?.trim() || null };
}

/** Read one board. Returns { jobs: [common shape], total } or throws (HTTP status on the error). */
export async function readBoard(getJson, { provider, slug, name }, { match = null, details = 20, sleep = async () => {} } = {}) {
  const ad = ADAPTERS[provider];
  const raw = ad.list(await getJson(ad.url(slug)));
  const jobs = [];
  for (const j of raw) {
    const m = ad.map(j, name ?? titleCase(slug), slug);
    if (!m.title || !m.source_url) continue;
    if (match && !match.test(`${m.title} ${m.commitment}`)) continue;
    if (ad.detail && !m.description && details > 0) {
      details -= 1; await sleep(1000);
      try { m.description = await ad.detail(m, slug, getJson); } catch { m.description = ''; }
    }
    jobs.push(m);
  }
  return { jobs, total: raw.length };
}

export const titleCase = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---- board detection in career pages ------------------------------------------------------

const BOARD_PATTERNS = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?(?:[^"'\s]*&)?for=)?([A-Za-z0-9_-]+)/g],
  ['greenhouse', /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/g],
  ['lever', /jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/g],
  ['lever', /api\.lever\.co\/v0\/postings\/([A-Za-z0-9_.-]+)/g],
  ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g],
  ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9_.%-]+)/g],
  ['smartrecruiters', /(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g],
  ['workable', /apply\.workable\.com\/([a-z0-9_-]+)/g],
];
const NOT_SLUG = new Set(['embed', 'v1', 'v0', 'api', 'j', 'js', 'css', 'static', 'assets', 'jobs', 'favicon.ico', 'oneclick-ui']);

/** Job boards referenced by a page (links, embeds, scripts). Returns ["provider:slug", ...]. */
export function detectBoards(html) {
  const found = new Set();
  for (const [provider, re] of BOARD_PATTERNS) {
    for (const m of String(html).matchAll(re)) {
      const slug = decodeURIComponent(m[1]).replace(/\.+$/, '');
      if (slug && !NOT_SLUG.has(slug.toLowerCase())) found.add(`${provider}:${slug}`);
    }
  }
  return [...found];
}

/** Board spec from a freehire.me record (its `source` names the ATS and `external_id` starts with the board slug). */
export function boardFromFreehire(d) {
  if (!PROVIDERS.includes(d?.source)) return null;
  const slug = String(d.external_id ?? '').split(':')[0];
  return slug && !/\s|\//.test(slug) ? `${d.source}:${slug}` : null;
}

// ---- single posting lookups (verification) -------------------------------------------------

/**
 * Find the public API record behind a posting URL. Returns null when the URL is not a known board posting.
 * Otherwise { provider, slug, id, read: async (getJson) => ({ title, text, closed }) }. A 404 or a missing id means closed.
 */
export function postingLookup(url, html = '') {
  let u; try { u = new URL(url); } catch { return null; }
  const path = u.pathname;
  const gone = (e) => { if (e.status === 404 || e.status === 410) return { title: null, text: '', closed: true }; throw e; };
  let m, ghSlug = null, ghId = null;
  if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(u.hostname) && (m = /^\/([\w-]+)\/jobs\/(\d+)/.exec(path))) [, ghSlug, ghId] = m;
  else if (/^\d+$/.test(u.searchParams.get('gh_jid') ?? '')) { ghId = u.searchParams.get('gh_jid'); ghSlug = detectBoards(html).find((b) => b.startsWith('greenhouse:'))?.split(':')[1] ?? null; }
  if (ghSlug && ghId) {
    const slug = ghSlug, id = ghId;
    return { provider: 'greenhouse', slug, id, read: async (g) => { try { const j = await g(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`); return { title: j.title, text: [j.title, j.location?.name, plain(j.content)].filter(Boolean).join('\n'), closed: false }; } catch (e) { return gone(e); } } };
  }
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(u.hostname) && (m = /^\/([\w.-]+)\/([0-9a-f-]{36})/.exec(path))) {
    const [, slug, id] = m;
    return { provider: 'lever', slug, id, read: async (g) => { try { const j = await g(`https://api.lever.co/v0/postings/${slug}/${id}`); return { title: j.text, text: [j.text, j.categories?.location, j.categories?.commitment, j.descriptionPlain, j.additionalPlain].filter(Boolean).join('\n'), closed: false }; } catch (e) { return gone(e); } } };
  }
  if (u.hostname === 'jobs.ashbyhq.com' && (m = /^\/([^/]+)\/([0-9a-f-]{36})/.exec(path))) {
    const [, slug, id] = m;
    return { provider: 'ashby', slug, id, read: async (g) => {
      try { const j = (await g(ADAPTERS.ashby.url(slug))).jobs?.find((x) => x.id === id); return j ? { title: j.title, text: [j.title, j.location, j.employmentType, j.descriptionPlain].filter(Boolean).join('\n'), closed: false } : { title: null, text: '', closed: true }; } catch (e) { return gone(e); } } };
  }
  if (u.hostname === 'jobs.smartrecruiters.com' && (m = /^\/([\w-]+)\/(\d+)/.exec(path))) {
    const [, slug, id] = m;
    return { provider: 'smartrecruiters', slug, id, read: async (g) => { try { const j = await g(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`); return { title: j.name, text: [j.name, j.location?.fullLocation, j.typeOfEmployment?.label, srText(j)].filter(Boolean).join('\n'), closed: j.active === false }; } catch (e) { return gone(e); } } };
  }
  if (u.hostname === 'apply.workable.com' && (m = /^\/([\w-]+)\/j\/([A-Z0-9]+)/i.exec(path))) {
    const [, slug, id] = m;
    return { provider: 'workable', slug, id, read: async (g) => {
      try { const j = (await g(ADAPTERS.workable.url(slug))).jobs?.find((x) => x.shortcode === id); return j ? { title: j.title, text: [j.title, where(j.city, j.state, j.country), j.employment_type, plain(j.description)].filter(Boolean).join('\n'), closed: false } : { title: null, text: '', closed: true }; } catch (e) { return gone(e); } } };
  }
  return null;
}
