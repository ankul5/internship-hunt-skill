---
name: job-status
description: Where the internship search stands, and whether the records behind it are sound. Checks the tracker files for wrong columns, bad IDs or timestamps, disallowed status moves, duplicates, conflicts, deleted rows and left-over locks, then summarizes new jobs, approved opportunities, prepared applications, confirmed submissions, interviews, assessments, offers, rejections and pending actions, saying clearly which statuses are unknown because a source was never checked. Repairs are proposed as a plan and applied only after the user approves, with backups and an audit trail; nothing is ever deleted. Use when the user asks for status, what is pending, what to do next, or to check, clean up or repair the tracker, or when another skill reports a CSV error, interrupted write or stale lock.
compatibility: Needs the repository root as working directory and Node 18+ for scripts/status-store.mjs and scripts/tracker-store.mjs. Local files only; fetches nothing.
metadata:
  version: "0.1"
---

# Job status

Read `AGENTS.md` and `references/data-model.md` first. Steps 1 and 2 only read. Step 3 changes data only after the user approves, and **no record is ever silently discarded**: rows are never deleted, IDs never renumbered, and a broken file is kept as a copy before anything replaces it.

## 1. Check the records

`node scripts/tracker-store.mjs check --text`. It finds:

- unreadable files (header not matching the schema), wrong cell counts, types, enums, required fields, placeholders such as `N/A`, stray spaces, broken references;
- repeated IDs, changed creation times, `updated_at` before `created_at`, times in the future;
- **status moves the lifecycle does not allow** since the latest backup;
- **rows that are in a backup but missing now**;
- duplicate jobs (same company, title and location, or same posting URL), the same email recorded twice, an email linked to the wrong job, two open applications for one job, a submitted application whose job is not marked applied;
- an interrupted write (journal left behind), a lock older than 2 hours, runs stuck `in_progress`.

If it is clean, go to step 2. If not, still give the summary, but say which parts may be wrong, and offer step 3.

## 2. Summarize

`node scripts/status-store.mjs --text` (JSON without `--text`; `--since <UTC time>` sets what counts as new, default 7 days). It reports jobs (new, by status, approved with deadlines), applications (being prepared, confirmed submissions, unconfirmed or failed, interviews, assessments, offers, rejections, closed), pending actions, and what was checked. For each submitted application the response is:

- `update_received`: an email was recorded (time and summary);
- `no_update`: the inbox was checked for the **whole** time since the application and nothing matched;
- `unknown`: part of that time was **never checked**, so silence proves nothing (the gaps are listed).

Lead with what needs the user, then the counts. **Never turn `unknown` into "no news"**: say which source was not checked and since when, and offer `/check-updates`. Say plainly when an integration could not be checked and why. Do not guess a status, an employer's plans or a timeline. Offer the next step that fits: `/check-updates` (unknown responses, due follow-ups), `apply` (approved jobs with no application), `/submit-application` (approved packages).

## 3. Repair, only with approval

`node scripts/tracker-store.mjs plan` saves `tracker/repair-plan-<time>.json` with each proposed fix and the hashes of the files it saw, and prints `plan_path` and `plan_hash`. Show **every** fix, risky ones first with their `why`, and every manual item (only the user can decide which duplicate ID is real or what a missing required value is). Never fill a value with a guess.

| Fix | Risky | What it does |
|---|---|---|
| `finish_write` | no | completes an interrupted write from its journal (refuses if a file changed since) |
| `set_field` (spaces, placeholder to empty) | no | one cell |
| `set_status` (stuck run to aborted, job to applied) | no | one status, allowed moves only |
| `set_status` (duplicate job to archived, duplicate email to processed) | yes | the row stays, with a note naming the one kept |
| `set_field` (restore a changed creation time, relink an email to the application's job) | yes | one cell |
| `restore_row` | yes | appends a deleted row exactly as it was in the backup |
| `restore_file` | yes | replaces an unreadable file with its latest readable backup; the broken file is kept in `backups/` |
| `release_lock` | yes | only if no other session is running |

Apply only what the user approved: `node scripts/tracker-store.mjs apply <plan_path> --plan-hash <plan_hash> --only I1,I3 --note "<their exact words>"`. It refuses if a file changed after the plan (run plan again and show the new one), if the plan was altered, or if the result would add any validation problem. Files are backed up first, written through the journal, and every change goes to `tracker/audit.jsonl` with before and after values, the plan and the user's words. Report `changes`, what was left (`not_applied`, manual items) and the `recheck` summary.
