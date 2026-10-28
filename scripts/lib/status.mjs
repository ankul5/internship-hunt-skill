// job-status: one read-only summary of the tracker. Local records only; it never fetches anything.
// It keeps two things apart that are easy to blur: "no update" (the inbox WAS checked for the whole time since the
// application and nothing came) and "unknown" (part of that time was never checked, so silence proves nothing).
import { loadAll, versions } from './apply.mjs';
import { readTable } from './ingest.mjs';
import { loadCsvSchemas, isoNow } from './data.mjs';
import { updatesState, gaps, notCheckable, SOURCES } from './updates.mjs';
import { integrationStatus } from './outbound.mjs';
import { followUpReport } from './followups.mjs';

const WEEK = 7 * 86400000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SUBMITTED = ['submitted', 'acknowledged', 'interview', 'assessment', 'offer', 'accepted', 'declined', 'rejected'];

export function jobStatus(dir, { now = isoNow(), since = null } = {}) {
  const S = loadCsvSchemas();
  const { jobsT, appsT } = loadAll(dir);
  const evs = readTable(dir, 'email-events.csv', S['email-events.csv']).records;
  const from = since ?? iso(Date.parse(now) - WEEK);
  const jobOf = (id) => jobsT.records.find((j) => j.job_id === id);
  const brief = (a) => { const j = jobOf(a.job_id); return { application_id: a.application_id, job_id: a.job_id, company: j?.company ?? null, role: j?.title ?? null, status: a.status }; };
  const byStatus = (st) => appsT.records.filter((a) => st.includes(a.status));

  // Inbox coverage across every source that keeps checkpoints.
  const st = updatesState(dir);
  const covered = Object.values(st.sources).flatMap((s) => s.covered ?? []);
  const integrations = Object.entries(SOURCES).filter(([, s]) => s.integration).map(([id, s]) => {
    const i = integrationStatus(dir, s.integration, now);
    const c = st.sources[id];
    return { source: id, label: s.label, integration: s.integration, status: i.status, usable_now: i.usable, reason: i.usable ? null : i.reason, last_complete_check: c?.last_success_at ?? null };
  });

  const responseState = (a) => {
    const start = a.submitted_at || a.approved_at || a.created_at;
    const last = evs.filter((e) => e.application_id === a.application_id && e.direction === 'inbound').sort((x, y) => (x.occurred_at < y.occurred_at ? 1 : -1))[0];
    const g = gaps(covered, start, now);
    if (last) return { response: 'update_received', last_update_at: last.occurred_at, last_update: last.summary, unchecked_since_then: gaps(covered, last.occurred_at, now).length > 0 };
    if (!covered.length) return { response: 'unknown', why: 'the inbox has never been checked by check-updates' };
    if (g.length) return { response: 'unknown', why: `the inbox was not checked for ${g.length} period(s) since ${start.slice(0, 10)}: ${g.slice(0, 3).map(([x, y]) => `${x} to ${y}`).join('; ')}` };
    return { response: 'no_update', why: `the inbox was checked for the whole time since ${start.slice(0, 10)} and nothing matched this application` };
  };

  const pendingEmails = evs.filter((e) => e.direction === 'inbound' && e.status === 'received');
  const unverifiedSends = evs.filter((e) => /\[send-unverified\]/.test(e.action_required));
  const draftsWaiting = evs.filter((e) => e.direction === 'outbound' && e.status === 'draft');
  const fu = followUpReport(dir, { now });
  const deadlines = jobsT.records.filter((j) => j.status === 'shortlisted' && j.deadline && j.deadline >= now.slice(0, 10) && Date.parse(j.deadline) - Date.parse(now) <= WEEK)
    .map((j) => ({ job_id: j.job_id, company: j.company, role: j.title, deadline: j.deadline, has_application: appsT.records.some((a) => a.job_id === j.job_id) }));

  const actions = [
    ...pendingEmails.map((e) => ({ what: 'confirm an email', event_id: e.event_id, detail: e.action_required })),
    ...unverifiedSends.map((e) => ({ what: 'verify a send before anything else', event_id: e.event_id, detail: e.action_required })),
    ...byStatus(['submission_unconfirmed']).map((a) => ({ what: 'verify a submission', application_id: a.application_id, detail: 'outcome unknown; check the portal or confirmation email' })),
    ...byStatus(['ready_for_review']).map((a) => ({ what: 'review a prepared application', application_id: a.application_id })),
    ...draftsWaiting.map((e) => ({ what: 'approve or discard a draft message', event_id: e.event_id, detail: e.subject })),
    ...fu.due.map((x) => ({ what: 'a follow-up may be appropriate', application_id: x.application_id, detail: `${x.days_since} days since ${x.message.event_id}${x.warning ? `; ${x.warning}` : ''}` })),
    ...appsT.records.filter((a) => a.next_action && !['rejected', 'withdrawn', 'declined', 'accepted'].includes(a.status)).map((a) => ({ what: 'next action', application_id: a.application_id, detail: a.next_action, due: a.next_action_due || null })),
    ...deadlines.filter((d) => !d.has_application).map((d) => ({ what: 'deadline within 7 days, no application yet', job_id: d.job_id, detail: `${d.company}, ${d.role}: ${d.deadline}` })),
  ];

  const submitted = byStatus(SUBMITTED).map((a) => ({ ...brief(a), submitted_at: a.submitted_at || null, method: a.submission_method || null, ...responseState(a) }));
  return {
    as_of: now, new_since: from,
    jobs: {
      new: jobsT.records.filter((j) => j.discovered_at >= from).map((j) => ({ job_id: j.job_id, company: j.company, role: j.title, status: j.status, fit_score: j.fit_score || null })),
      by_status: Object.fromEntries(['discovered', 'verified', 'shortlisted', 'applied', 'rejected', 'expired', 'archived'].map((s) => [s, jobsT.records.filter((j) => j.status === s).length])),
      approved: jobsT.records.filter((j) => j.status === 'shortlisted').map((j) => ({ job_id: j.job_id, company: j.company, role: j.title, deadline: j.deadline || null, application: appsT.records.find((a) => a.job_id === j.job_id)?.application_id ?? null })),
    },
    applications: {
      preparing: byStatus(['drafting', 'ready_for_review', 'approved']).map((a) => ({ ...brief(a), versions: versions(dir, a.application_id).length })),
      submission_unconfirmed: byStatus(['submission_unconfirmed']).map(brief),
      submission_failed: byStatus(['submission_failed']).map(brief),
      confirmed_submissions: submitted,
      interviews: byStatus(['interview']).map(brief), assessments: byStatus(['assessment']).map(brief), offers: byStatus(['offer']).map(brief),
      rejections: byStatus(['rejected']).map(brief), closed: byStatus(['accepted', 'declined', 'withdrawn']).map(brief),
    },
    pending_actions: actions,
    checked: { integrations, inbox_covered: covered, not_checked: notCheckable() },
    notes: [
      'unknown means part of the time since the application was never checked; it is not the same as no update.',
      ...integrations.filter((i) => !i.usable_now).map((i) => `${i.label} could not be checked: ${i.reason}`),
      'Job sites and application portals are not checked by this tool; their statuses come only from emails and what you record.',
    ],
  };
}

/** Short text for the user. */
export function renderStatus(r) {
  const L = [];
  const n = (x) => x.length;
  L.push(`Status as of ${r.as_of} (new since ${r.new_since})`, '');
  L.push(`Jobs: ${n(r.jobs.new)} new; ${Object.entries(r.jobs.by_status).filter(([, c]) => c).map(([s, c]) => `${c} ${s}`).join(', ') || 'none'}`);
  L.push(`Approved opportunities: ${n(r.jobs.approved)}`);
  const a = r.applications;
  L.push(`Applications: ${n(a.preparing)} being prepared, ${n(a.confirmed_submissions)} confirmed submitted, ${n(a.submission_unconfirmed)} unconfirmed, ${n(a.submission_failed)} failed`);
  L.push(`Interviews ${n(a.interviews)}, assessments ${n(a.assessments)}, offers ${n(a.offers)}, rejections ${n(a.rejections)}`);
  if (n(a.confirmed_submissions)) {
    L.push('', 'Responses:');
    for (const s of a.confirmed_submissions) L.push(`- ${s.application_id} ${s.company ?? ''} (${s.status}): ${s.response.replace('_', ' ')}${s.why ? `, ${s.why}` : ''}${s.last_update_at ? ` at ${s.last_update_at}` : ''}`);
  }
  L.push('', `Pending actions: ${n(r.pending_actions)}`);
  for (const x of r.pending_actions) L.push(`- ${x.what}: ${x.application_id ?? x.event_id ?? x.job_id}${x.detail ? `, ${x.detail}` : ''}${x.due ? ` (due ${x.due})` : ''}`);
  L.push('', 'Checked:');
  for (const i of r.checked.integrations) L.push(`- ${i.label}: ${i.usable_now ? 'verified' : i.status}${i.last_complete_check ? `, last complete check ${i.last_complete_check}` : ', never checked completely'}`);
  for (const note of r.notes) L.push(`Note: ${note}`);
  return L.join('\n');
}
