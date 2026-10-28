// check-updates: fetch window, honest coverage, and checkpoints that move only after everything is persisted.
// The mail itself is read by the Gmail API client (gmail.mjs) or by a connector the harness provides; recording,
// matching and classification are inbox.mjs. This module decides WHICH time range was really checked.
// Coverage is kept as merged time intervals per source, so checking "yesterday" after a three-day gap never claims
// the gap was checked.
import { join } from 'node:path';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { readJson, writeAtomic, readTable, RefusedError } from './ingest.mjs';
import { loadCsvSchemas, isoNow } from './data.mjs';
import { str } from './apply.mjs';
import { ingestMessages } from './inbox.mjs';
import { AuthError, RateLimitError, normalizeMessage } from './gmail.mjs';
import { setIntegration, integrationStatus } from './outbound.mjs';
import { loadPlatforms } from './readiness.mjs';

/** Re-check this much before the last checkpoint: mail can be indexed late. Duplicates are skipped by message id. */
export const OVERLAP_MINUTES = 60;
export const MAX_INTERVALS = 50;
export const RANGES = ['last-sync', 'today', 'yesterday', '7d', 'YYYY-MM-DD'];

/**
 * Sources and what each can really do.
 *   window: how a time range is applied. 'query' = the source's own search filters by time (Gmail search after:/before:
 *   with epoch seconds); 'observed' = only trusted when the caller saw the filter work; 'none' = no range at all.
 *   checkpoint: whether a complete check can move the checkpoint.
 */
export const SOURCES = {
  'gmail-api': { integration: 'gmail-read', window: 'query', checkpoint: true, label: 'Gmail (this repository\'s read-only API client)' },
  'gmail-connector': { integration: 'gmail-connector', window: 'observed', checkpoint: true, label: 'Gmail through a Claude connector' },
  pasted: { integration: null, window: 'none', checkpoint: false, label: 'Emails the user pasted' },
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const syncPath = (dir) => join(dir, 'sync-state.json');
const logPath = (dir) => join(dir, 'updates', 'check-log.jsonl');

/** "+05:30" -> minutes east of UTC. */
export function tzMinutes(tz) {
  const m = String(tz ?? '+00:00').match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) throw new Error(`timezone offset "${tz}" must look like +05:30 or -04:00`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
const localMidnight = (ms, tzMin) => { const shifted = ms + tzMin * 60000; return shifted - (shifted % 86400000) - tzMin * 60000; };

export function updatesState(dir) {
  const s = readJson(syncPath(dir));
  return { tz_offset: s.updates?.tz_offset ?? null, sources: s.updates?.sources ?? {} };
}

/** Merge [from, to] intervals (ISO strings) that overlap or touch. */
export function mergeIntervals(list) {
  const xs = list.filter(([a, b]) => ISO.test(a) && ISO.test(b) && a < b).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const out = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) { if (b > last[1]) last[1] = b; } else out.push([a, b]);
  }
  return out.slice(-MAX_INTERVALS);
}

/** Gaps inside [from, to] that no interval covers. */
export function gaps(intervals, from, to) {
  const out = [];
  let cur = from;
  for (const [a, b] of mergeIntervals(intervals)) {
    if (b <= cur) continue;
    if (a >= to) break;
    if (a > cur) out.push([cur, a < to ? a : to]);
    if (b > cur) cur = b;
    if (cur >= to) break;
  }
  if (cur < to) out.push([cur, to]);
  return out;
}

/**
 * Resolve a range to an exact UTC window [from, to). "today" and "yesterday" use the user's timezone offset, which is
 * stated in the result so the user can see what was checked.
 */
export function resolveWindow(dir, since, { source, now = isoNow(), tz = null } = {}) {
  const spec = SOURCES[source];
  if (!spec) throw new Error(`source must be ${Object.keys(SOURCES).join('|')}`);
  const st = updatesState(dir);
  const tzOff = tz ?? st.tz_offset ?? '+00:00';
  const tzMin = tzMinutes(tzOff);
  const nowMs = Date.parse(now);
  let from, to = nowMs, basis;
  const s = String(since ?? 'last-sync');
  if (s === 'last-sync') {
    const cov = st.sources[source]?.covered ?? [];
    if (!cov.length) throw new RefusedError(`${source} has never been checked completely, so there is no "last sync" to start from. Ask the user for a range: today, yesterday, 7d or a date (YYYY-MM-DD).`);
    const end = cov[cov.length - 1][1];
    from = Date.parse(end) - OVERLAP_MINUTES * 60000;
    basis = `since the last complete check (${end}), minus ${OVERLAP_MINUTES} minutes of overlap`;
  } else if (s === 'today') { from = localMidnight(nowMs, tzMin); basis = `today from local midnight (UTC${tzOff})`; }
  else if (s === 'yesterday') { to = localMidnight(nowMs, tzMin); from = to - 86400000; basis = `yesterday, local midnight to midnight (UTC${tzOff})`; }
  else if (/^\d+d$/.test(s)) { const n = Number(s.slice(0, -1)); if (n < 1 || n > 90) throw new Error('a day range must be 1d to 90d'); from = nowMs - n * 86400000; basis = `the last ${n} days`; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(d)) throw new Error(`not a date: ${s}`);
    from = d - tzMin * 60000;
    if (from >= nowMs) throw new RefusedError(`${s} is in the future`);
    basis = `since ${s} local midnight (UTC${tzOff})`;
  } else throw new Error(`--since must be one of ${RANGES.join(', ')}`);
  return { source, from: iso(from), to: iso(to), basis, tz_offset: tzOff, window_support: spec.window };
}

/** The search to run for a window. Gmail search accepts epoch seconds in after:/before:. -from:me drops the user's own mail. */
export const gmailQuery = (w, extra = '') => `after:${Math.floor(Date.parse(w.from) / 1000)} before:${Math.ceil(Date.parse(w.to) / 1000)} -from:me${extra ? ` ${extra}` : ''}`;

/** What happens before fetching: the exact window, the query, the integration status, and what will NOT be checked. */
export function planCheck(dir, { since, source, now = isoNow(), tz = null }) {
  const w = resolveWindow(dir, since, { source, now, tz });
  const spec = SOURCES[source];
  const integ = spec.integration ? integrationStatus(dir, spec.integration, now) : null;
  const st = updatesState(dir).sources[source];
  return {
    window: w, query: source === 'pasted' ? null : gmailQuery(w),
    integration: integ, ready: source === 'pasted' || !!integ?.usable,
    previous: st ? { covered: st.covered ?? [], last_success_at: st.last_success_at ?? null } : null,
    not_checked: notCheckable(),
    rules: source === 'gmail-connector'
      ? ['Search with the connector using exactly this query, and page until the connector reports no more results.', 'Pass --complete only if you reached the last page.', 'Pass --date-filter-evidence only if every returned message is inside the window and the connector honoured after:/before:. Without it the checkpoint does not move.']
      : source === 'pasted' ? ['Pasted emails never move a checkpoint: nobody can tell whether every email in the range was pasted.'] : [],
  };
}

/** Platforms with no read integration here: application portals and job sites must be checked by the user. */
export function notCheckable() {
  return loadPlatforms().platforms.filter((p) => !['gmail', 'outlook'].includes(p.id)).map((p) => ({ id: p.id, name: p.name, reason: 'no supported read integration for application updates; check it yourself' }));
}

function logAttempt(dir, entry) {
  mkdirSync(join(dir, 'updates'), { recursive: true });
  appendFileSync(logPath(dir), `${JSON.stringify(entry)}\n`);
}
export const readCheckLog = (dir) => (existsSync(logPath(dir)) ? readFileSync(logPath(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Move the checkpoint. Only after every record of the check is on disk. */
function advanceCheckpoint(dir, source, w, now) {
  const s = readJson(syncPath(dir));
  const up = s.updates ?? { tz_offset: null, sources: {} };
  const prev = up.sources?.[source] ?? { covered: [] };
  const covered = mergeIntervals([...(prev.covered ?? []), [w.from, w.to]]);
  up.sources = { ...(up.sources ?? {}), [source]: { covered, last_success_at: now, last_window: [w.from, w.to] } };
  if (!up.tz_offset) up.tz_offset = w.tz_offset;
  s.updates = up;
  if (source === 'gmail-api') s.gmail = { ...(s.gmail ?? {}), last_sync_at: now, cursor: String(Math.floor(Date.parse(w.to) / 1000) - OVERLAP_MINUTES * 60) };
  writeAtomic(syncPath(dir), JSON.stringify(s, null, 2) + '\n');
  return covered;
}

/** Save the user's timezone offset (used for today/yesterday/dates). */
export function setTimezone(dir, tz) {
  tzMinutes(tz);
  const s = readJson(syncPath(dir));
  s.updates = { ...(s.updates ?? { sources: {} }), tz_offset: tz };
  writeAtomic(syncPath(dir), JSON.stringify(s, null, 2) + '\n');
  return { tz_offset: tz };
}

/**
 * Record one check. messages: normalised messages (inbox.mjs shape). complete: the fetch reached the end of the window.
 * The checkpoint moves only when: the source supports checkpoints, the fetch was complete, the date filter is
 * trustworthy, and every recorded event is found on disk afterwards. Otherwise the result says exactly why not.
 */
export function recordCheck(dir, { source, window: w, messages, complete = false, dateFilterEvidence = null, now = isoNow() }) {
  const spec = SOURCES[source];
  if (!spec) throw new Error(`source must be ${Object.keys(SOURCES).join('|')}`);
  if (!w || !ISO.test(w.from) || !ISO.test(w.to) || w.from >= w.to) throw new Error('window must have from < to (UTC YYYY-MM-DDTHH:MM:SSZ); use the window from plan');
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  // Two minutes of tolerance at each edge: providers round search times to the second or minute.
  const lo = iso(Date.parse(w.from) - 120000), hi = iso(Date.parse(w.to) + 120000);
  const inWin = [], outside = [];
  for (const m of messages) (m.received_at && m.received_at >= lo && m.received_at <= hi ? inWin : outside).push(m);
  // A message outside the window proves the source did not apply the range as asked.
  const filterOk = spec.window === 'query' ? outside.length === 0 : spec.window === 'observed' ? !!str(dateFilterEvidence) && outside.length === 0 : false;
  logAttempt(dir, { at: now, event: 'check_started', source, window: [w.from, w.to], fetched: messages.length, complete });

  let r;
  try { r = ingestMessages(dir, source === 'pasted' ? messages : inWin, { now, source: source === 'gmail-api' ? 'gmail' : source === 'pasted' ? 'pasted' : 'connector', skill: 'check-updates' }); }
  catch (e) { logAttempt(dir, { at: now, event: 'check_failed', source, error: String(e.message).split('\n')[0] }); throw e; }

  // Persisted? Every id the ingest reported must now be in email-events.csv.
  const S = loadCsvSchemas();
  const onDisk = new Set(readTable(dir, 'email-events.csv', S['email-events.csv']).records.map((e) => e.provider_message_id));
  const missing = r.recorded.filter((x) => !onDisk.has(x.provider_message_id)).map((x) => x.event_id);
  const reasons = [];
  if (!spec.checkpoint) reasons.push(`${spec.label} cannot prove that every email in the range was seen`);
  if (!complete) reasons.push('the fetch did not reach the end of the window (stopped early, rate limited, or paging not finished)');
  if (spec.window === 'observed' && !str(dateFilterEvidence)) reasons.push('the connector\'s date filter was not observed working (no --date-filter-evidence)');
  if (outside.length && source !== 'pasted') reasons.push(`${outside.length} message(s) were outside the window, so the date filter did not work as asked`);
  if (missing.length) reasons.push(`recorded events not found on disk afterwards: ${missing.join(', ')}`);
  let covered = null;
  if (!reasons.length) covered = advanceCheckpoint(dir, source, w, now);
  logAttempt(dir, { at: now, event: covered ? 'checkpoint_advanced' : 'checkpoint_kept', source, window: [w.from, w.to], run_id: r.run_id, recorded: r.recorded.length, duplicates: r.duplicates, reasons });
  return {
    ok: true, source, window: w, fetched: messages.length, in_window: source === 'pasted' ? messages.length : inWin.length, outside_window: source === 'pasted' ? 0 : outside.length,
    complete, checkpoint_advanced: !!covered, checkpoint_kept_because: reasons, covered, filter_trusted: filterOk, ...r,
  };
}

/**
 * Full check through this repository's Gmail API client. A missing or revoked permission records the integration as
 * needing authorization and returns ok:false: nothing is recorded and the checkpoint stays.
 */
export async function checkGmailApi(dir, client, { since, now = isoNow(), tz = null, max = 200, extraQuery = '' }) {
  const w = resolveWindow(dir, since, { source: 'gmail-api', now, tz });
  const q = gmailQuery(w, extraQuery);
  const messages = [];
  let complete = true, stopped = null, page = null;
  try {
    do {
      const l = await client.listMessages({ query: q, max: Math.min(50, max - messages.length), pageToken: page });
      for (const id of l.ids) messages.push(normalizeMessage(await client.getMessage(id)));
      page = l.next;
    } while (page && messages.length < max);
    if (page) { complete = false; stopped = `stopped at the limit of ${max} messages; check again for the rest`; }
  } catch (e) {
    if (e instanceof AuthError) {
      setIntegration(dir, 'gmail-read', 'possible_unconfigured', `${e.code}: ${e.message}`, now);
      logAttempt(dir, { at: now, event: 'check_failed', source: 'gmail-api', window: [w.from, w.to], error: `${e.code}: ${e.message}` });
      return { ok: false, code: e.code, message: e.message, window: w, recorded: [], checkpoint_advanced: false, checkpoint_kept_because: [`Gmail access is not usable (${e.code})`] };
    }
    if (e instanceof RateLimitError) { complete = false; stopped = `rate limited (retry after ${e.retryAfter ?? 'a while'}); recorded what was fetched`; } else throw e;
  }
  return { query: q, stopped, ...recordCheck(dir, { source: 'gmail-api', window: w, messages, complete, now }) };
}
