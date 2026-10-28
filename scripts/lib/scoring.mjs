// Deterministic eligibility gates and fit scoring. Rubric: references/scoring-rubric.md (v1).
// Pure functions: no file or network access.

export const RUBRIC_VERSION = 1;
export const WEIGHTS = { skills: 30, role: 25, location: 15, availability: 10, projects: 10, industry: 10 };

const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
export const norm = (s) =>
  String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean).map(stem);
const skillNorm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s+#]/gu, ' ').replace(/\s+/g, ' ').trim();

export const dedupeKey = (company, title, location) => `${norm(company)}|${norm(title)}|${norm(location)}`;

const TRACKING = /^(utm_|ref$|referrer$|source$|src$|fbclid$|gclid$|trk|tracking|campaign)/i;
/** Lowercase host, drop hash, tracking params, and trailing slash. Returns '' for invalid input. */
export function canonicalUrl(u) {
  try {
    const url = new URL(String(u).trim());
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    url.searchParams.sort();
    let path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch { return ''; }
}

const sameSkill = (a, b) => {
  const x = skillNorm(a), y = skillNorm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
  const [small, big] = tx.size <= ty.size ? [tx, ty] : [ty, tx];
  return small.size >= 2 && [...small].every((t) => big.has(t));
};

const confirmed = (p) => p === 'resume' || p === 'user_stated';

function profileYear(profile) {
  const years = (profile.education ?? [])
    .filter((e) => confirmed(e.provenance) && /^\d{4}/.test(e.end_date ?? ''))
    .map((e) => Number(e.end_date.slice(0, 4)));
  return years.length ? Math.max(...years) : null;
}

function weeksFrom(text) {
  const m = String(text ?? '').toLowerCase().match(/(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(week|wk|month|mo)/);
  if (!m) return null;
  const mult = m[3].startsWith('w') ? 1 : 4.345;
  const a = Number(m[1]) * mult, b = m[2] ? Number(m[2]) * mult : a;
  return [a, b];
}

/** Hard gates. Returns { result: 'pass'|'fail'|'unknown', checks: [{name, result, detail}] }. */
export function eligibility(profile, job) {
  const checks = [];
  const add = (name, result, detail) => checks.push({ name, result, detail });

  const et = job.employment_type ?? 'unknown';
  if (['internship', 'co-op', 'apprenticeship'].includes(et)) add('employment type', 'pass', et);
  else if (et === 'other') add('employment type', 'fail', 'employment type is other (not an internship)');
  else add('employment type', 'unknown', 'employment type not confirmed');

  const excluded = (profile.preferences?.excluded_companies ?? []).map(norm);
  if (excluded.includes(norm(job.company))) add('excluded company', 'fail', `company ${job.company} is on the excluded list`);

  const elig = job.eligibility ?? {};
  if (elig.grad_years?.length) {
    const y = profileYear(profile);
    if (y === null) add('graduation year', 'unknown', 'posting states graduation years but the profile has no confirmed graduation date');
    else if (elig.grad_years.map(Number).includes(y)) add('graduation year', 'pass', `profile graduation year ${y} is accepted`);
    else add('graduation year', 'fail', `posting requires graduation in ${elig.grad_years.join('/')}; profile says ${y}`);
  }
  if (elig.countries?.length) {
    const mine = (profile.identity?.work_authorization?.countries ?? []).map(norm);
    if (!mine.length) add('work authorization', 'unknown', 'posting requires work authorization but the profile has none confirmed');
    else if (elig.countries.map(norm).some((c) => mine.includes(c))) add('work authorization', 'pass', 'authorization matches');
    else add('work authorization', 'fail', `posting requires work authorization in ${elig.countries.join('/')}; profile has ${mine.join('/')}`);
  }

  const blob = norm([job.title, job.eligibility_text, job.qualifications_text, job.stipend_text].join(' '));
  for (const term of profile.preferences?.deal_breakers ?? []) {
    const t = norm(term);
    if (t && new RegExp(`(^| )${t}( |$)`).test(blob)) add('deal-breaker', 'fail', `posting text contains deal-breaker "${term}"`);
  }

  const result = checks.some((c) => c.result === 'fail') ? 'fail'
    : checks.some((c) => c.result === 'unknown') ? 'unknown'
      : checks.some((c) => c.result === 'pass') ? 'pass' : 'unknown';
  return { result, checks };
}

/** Weighted fit score over the components that can be evaluated. */
export function fitScore(profile, job) {
  const comps = [];
  const add = (name, earned, note) => comps.push({ name, max: WEIGHTS[name], earned: earned === null ? null : Math.round(earned), note });

  // skills: confirmed profile skills and project technologies vs the posting's skills
  const mySkills = [
    ...(profile.skills ?? []).filter((s) => confirmed(s.provenance)).map((s) => s.name),
    ...(profile.projects ?? []).filter((p) => confirmed(p.provenance)).flatMap((p) => p.technologies ?? []),
  ];
  const jobSkills = job.skills ?? [];
  if (jobSkills.length && mySkills.length) {
    const hit = jobSkills.filter((js) => mySkills.some((ms) => sameSkill(js, ms)));
    add('skills', WEIGHTS.skills * hit.length / jobSkills.length, `matched ${hit.length}/${jobSkills.length}${hit.length ? `: ${hit.join(', ')}` : ''}`);
  } else add('skills', null, 'n/a');

  // role alignment: share of target-role words found in the title
  const roles = profile.preferences?.target_roles ?? [];
  if (roles.length && job.title) {
    const titleTok = new Set(tokens(job.title));
    let best = 0;
    for (const r of roles) {
      const rt = tokens(r).filter((t) => !['intern', 'internship'].includes(t));
      if (!rt.length) continue;
      best = Math.max(best, rt.filter((t) => titleTok.has(t)).length / rt.length);
    }
    add('role', WEIGHTS.role * best, `best target-role overlap ${Math.round(best * 100)}%`);
  } else add('role', null, 'n/a');

  // location / work arrangement
  const prefTypes = profile.preferences?.remote_types ?? [];
  const prefLocs = (profile.preferences?.locations ?? []).map(norm);
  const rt = job.remote_type ?? 'unknown';
  if ((prefTypes.length || prefLocs.length) && (rt !== 'unknown' || job.location)) {
    const locHit = job.location && prefLocs.some((l) => norm(job.location).includes(l) || l.includes(norm(job.location)));
    let f;
    if (rt === 'remote') f = !prefTypes.length || prefTypes.includes('remote') ? 1 : 0;
    else if (rt !== 'unknown' && prefTypes.length && !prefTypes.includes(rt)) f = 0;
    else f = locHit ? 1 : prefLocs.length ? 0.33 : 1;
    add('location', WEIGHTS.location * f, `${rt}${job.location ? `, ${job.location}` : ''}`);
  } else add('location', null, 'n/a');

  // availability: start date window and duration range
  const sub = [];
  const pref = profile.preferences ?? {};
  if (job.start_date && (pref.earliest_start || pref.latest_start)) {
    sub.push(job.start_date >= (pref.earliest_start ?? '0000') && job.start_date <= (pref.latest_start ?? '9999') ? 1 : 0);
  }
  const wk = weeksFrom(job.duration);
  if (wk && (pref.duration_weeks_min != null || pref.duration_weeks_max != null)) {
    const lo = pref.duration_weeks_min ?? 0, hi = pref.duration_weeks_max ?? Infinity;
    sub.push(wk[1] >= lo && wk[0] <= hi ? 1 : 0);
  }
  if (sub.length) add('availability', WEIGHTS.availability * sub.reduce((a, b) => a + b, 0) / sub.length, `${sub.filter(Boolean).length}/${sub.length} checks fit`);
  else add('availability', null, 'n/a');

  // projects / experience relevance: posting keywords found in confirmed projects and experience
  const kws = [...(job.keywords ?? [])];
  const corpus = new Set(tokens([
    ...(profile.projects ?? []).filter((p) => confirmed(p.provenance)).flatMap((p) => [p.name, p.description, ...(p.technologies ?? []), ...(p.highlights ?? [])]),
    ...(profile.experience ?? []).filter((e) => confirmed(e.provenance)).flatMap((e) => [e.title, ...(e.highlights ?? [])]),
  ].join(' ')));
  if (kws.length && corpus.size) {
    const hit = kws.filter((k) => tokens(k).length && tokens(k).every((t) => corpus.has(t)));
    add('projects', WEIGHTS.projects * hit.length / kws.length, `keywords matched ${hit.length}/${kws.length}${hit.length ? `: ${hit.join(', ')}` : ''}`);
  } else add('projects', null, 'n/a');

  // industry preference
  const inds = (profile.preferences?.industries ?? []).map(norm);
  if (inds.length && job.industry) add('industry', inds.includes(norm(job.industry)) ? WEIGHTS.industry : 0, job.industry);
  else add('industry', null, 'n/a');

  const known = comps.filter((c) => c.earned !== null);
  const knownMax = known.reduce((a, c) => a + c.max, 0);
  const earned = known.reduce((a, c) => a + c.earned, 0);
  const score = knownMax ? Math.round((100 * earned) / knownMax) : null;
  return { score, coverage: knownMax / 100, components: comps };
}

/** Full evaluation: gates first; the weighted score is withheld after a hard failure. */
export function evaluate(profile, job, { provisional = false } = {}) {
  const gate = eligibility(profile, job);
  if (gate.result === 'fail') {
    const reasons = gate.checks.filter((c) => c.result === 'fail').map((c) => c.detail);
    return { eligibility: 'fail', failReasons: reasons, score: null, coverage: 0, rationale: `Hard eligibility failure: ${reasons.join('; ')}. Not scored.` };
  }
  const fit = fitScore(profile, job);
  const parts = fit.components.map((c) => (c.earned === null ? `${c.name} n/a` : `${c.name} ${c.earned}/${c.max} (${c.note})`));
  const unknowns = gate.checks.filter((c) => c.result === 'unknown').map((c) => c.detail);
  let rationale;
  if (fit.score === null) rationale = `Rubric v${RUBRIC_VERSION}: nothing could be scored from the available facts.`;
  else rationale = `Rubric v${RUBRIC_VERSION}: ${parts.join('; ')}. Score ${fit.score}/100 from ${Math.round(fit.coverage * 100)}% of the rubric weight; not a prediction of interview outcomes.`;
  if (unknowns.length) rationale += ` Eligibility unconfirmed: ${unknowns.join('; ')}.`;
  if (fit.score !== null && fit.coverage < 0.5) rationale = `LOW COVERAGE (under half of the rubric weight could be evaluated; treat the score as weak). ${rationale}`;
  if (provisional) rationale = `PROVISIONAL (listing not opened). ${rationale}`;
  return { eligibility: gate.result, failReasons: [], score: fit.score, coverage: fit.coverage, rationale };
}
