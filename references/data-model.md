# Data model

Machine-readable definitions (columns, types, enums, required fields, transitions) are the single source of truth:

- CSV files: [schemas/csv-schemas.json](schemas/csv-schemas.json)
- Candidate profile: [schemas/candidate-profile.schema.json](schemas/candidate-profile.schema.json)
- Sync state: [schemas/sync-state.schema.json](schemas/sync-state.schema.json)

This page holds the rules that the schemas cannot express. `node tests/validate.mjs` checks fixtures and blank templates against the schemas.

## Files

| File | One row is | ID |
|---|---|---|
| `jobs.csv` | a posting | `job-0001` |
| `applications.csv` | one application to one job | `app-0001` |
| `email-events.csv` | one email or message (draft, sent, or received) | `eml-0001` |
| `search-history.csv` | one search against one source | `srch-0001` |
| `run-history.csv` | one agent run | `run-0001` |
| `candidate-profile.json` | the candidate (single document) | none |
| `sync-state.json` | cursors, lock, integration status, check-updates coverage (`updates`) | none |
| `preferences.json` | follow-up timing the user approved (`follow_up`); created by `followup-store.mjs set-prefs` | none |
| `companies.txt` | employer job boards searched by `feed-search.mjs ats --file` (`provider:slug=Company`); grown only through `add-boards` with the user's words | none |
| `career-sites.txt` | optional: employer sites for `career-walk.mjs find --file` (`Company=https://site`) | none |

Blank copies are in `templates/data/`; fictional examples are in `tests/fixtures/`. Search runs also leave working files beside these: `search-bundle-*.json` (what each provider returned), `ingest-*.json` and `*.checked.json` (drafts before and after the fact check), and `board-suggestions-*.json` (startup boards awaiting the user's choice). They hold only public posting text and can be deleted once ingested.

Folders the helpers keep in the private data directory: `updates/check-log.jsonl` (every update check and why its checkpoint moved or not), `tracker/repair-plan-<time>.json` and `tracker/audit.jsonl` (proposed and applied repairs), `.pending-write.json` (present only while a multi-file write is in progress, or after it was interrupted).

### Schema versions

- **2** (2026-10-28): `email-events.csv` `kind` gains `follow_up`. Existing files stay valid; no migration needed. `sync-state.json` gains the optional `updates` object.
- 2026-10-30, `candidate-profile.json` (still `schema_version` 1, additive only): optional `achievements[]`, `outreach` (`pitch`, `tone`, `sender_email`, `signature`), `identity.languages`, and `preferences.employment_types`, `weekly_hours_max`, `relocation`, `company_types`, `show_gpa`. Older profiles stay valid; `profile-store.mjs questions` asks for the new fields.
- 2026-10-31, `candidate-profile.json` (still `schema_version` 1, additive only): optional `preferences.resume_template` (a built-in template name or a folder in `<data dir>/resume-templates/`). Tailored versions' `meta.json` records `template`. Preview PDFs go to `<data dir>/template-previews/`.

## Format conventions

- UTF-8, no BOM, LF endings, RFC 4180 quoting, header row always present, columns in schema order.
- Timestamps: UTC, `YYYY-MM-DDTHH:MM:SSZ`. Dates: `YYYY-MM-DD`. Lists: `a;b;c`.
- Paths are relative to the private data directory, never absolute, never containing `..`.
- Unrecognized columns are an error. Schema changes bump `schema_version` and ship a migration note.

## Identifiers

- Format `<prefix>-<number>`, at least four digits.
- Next ID = highest existing number in that file + 1. Never reuse an ID, never renumber.
- Rows are never deleted. Retire them with a terminal status (`archived`, `withdrawn`, `discarded`).
- Foreign keys (`job_id`, `application_id`, `run_id`, `search_id`) must point to an existing row or be empty where optional.
- `dedupe_key` in `jobs.csv` is `company|title|location`, lowercased, punctuation removed, spaces collapsed. Before adding a job, search for the same key or the same `source_url`; update the existing row instead of adding a duplicate.

## Missing and unverified information

- **Empty cell = unknown or not applicable.** Never write `N/A`, `TBD`, `null`, `unknown?`, or a guess. (The enums `remote_type` and `employment_type` do have an explicit `unknown` value.)
- A value copied from a search snippet or inferred rather than read from the posting is **unverified**: keep it if useful, and list its column in `unverified_fields`. Remove the column name from the list only after confirming it from the source.
- `stipend_text` is copied verbatim; never converted or estimated.
- `eligibility_check` (hard gates) is separate from `fit_score` (weighted rubric). After a hard failure `fit_score` is empty. `fit_score` may be computed for an unverified (`discovered`) listing but is then marked `PROVISIONAL` in `fit_rationale`. See [scoring-rubric.md](scoring-rubric.md). `fit_rationale` must cite profile facts and posting text.
- `last_checked_at` is every look at a listing; `last_verified_at` is when the original posting was opened and its facts confirmed. `uncertainties` is free text for missing or doubtful facts.
- Search rows are written only by `scripts/search-store.mjs` (see `skills/run-search/references/ingest-format.md`); it applies the match, merge, and ownership rules below.
- In the profile, `null`/empty means unknown. Every list entry has a `provenance`; scalar fields are tracked in the `provenance` map, and a field absent from it is unconfirmed. Questions still open go in `open_questions`.

## Status lifecycles

Allowed moves are listed under `transitions` in the schema. Any other move needs the user's explicit instruction and a note.

- **Jobs:** `discovered → verified → shortlisted → applied → archived`. `rejected` and `expired` can occur from earlier stages; `rejected → shortlisted` is allowed when the user overrides.
- **Applications:** `drafting → ready_for_review → approved → submitted → acknowledged → interview/assessment → offer → accepted/declined`; `rejected` and `withdrawn` can end it. Editing any document after approval moves it back to `drafting` and clears `approved_at` and `approval_note`.
- **Email events:** outbound `draft → approved → sent`; inbound `received → processed`. `failed` and `discarded` are the other exits.
- **Runs:** `in_progress → completed | partial | failed | aborted`.

Required fields per status (for example `approved_at` before `approved`, `confirmation_evidence` before `submitted`) are declared in `requiredWhen` and enforced by the test script.

## Search merge rules

- A sighting matches an existing job when canonical URLs are equal, or `dedupe_key` is equal, or company and title are equal and one location is empty.
- Search fills empty fields and never blanks a filled one. A differing value is overwritten only when the original posting was opened in that run, and the change is appended to `notes`.
- User-owned statuses (`shortlisted`, `applied`, `archived`, and a `rejected` set by the user) are never changed by search; only expiry may move `shortlisted` to `expired`.
- A hard eligibility failure sets `rejected` with an `[auto-rejected]` note. Search may restore such a row if a refresh shows it now qualifies. A rejection without that marker is the user's and is left alone.

## Update rules

1. Acquire the lock: if `sync-state.json` `lock.holder` is empty, set it to the current `run_id` with `acquired_at`; otherwise ask the user. Release it at the end of the run, even on failure.
2. Copy the file to `backups/<name>.<timestamp>` before the first write in a run.
3. Write through a temp file and rename. Never leave a half-written CSV. When one run writes several files, the helpers write `.pending-write.json` first (each file's before and after hash, and the new contents), then the files, then remove it (`scripts/lib/journal.mjs`). The next run finishes an interrupted write, or refuses if a file changed in between.
4. Update `updated_at` on every changed row. Never change `created_at`, `discovered_at`, or an ID.
5. Append to `run-history.csv` at the start (`in_progress`) and update that same row at the end.
6. Log each search in `search-history.csv`, including failures and zero-result searches.
7. After writing, re-read the file and confirm the row count and header match what you intended.

## Recovery

- A CSV that fails validation: stop, tell the user which line and column, and offer to restore the latest file in `backups/`. Do not silently repair data. `job-status` (`scripts/tracker-store.mjs check | plan | apply`) finds these problems and applies only the repairs the user approved, with an audit trail.
- A check-updates checkpoint moves only after every recorded event is on disk. After any failure the next check re-reads the same range; message ids and the sender|subject|time key keep it from recording anything twice.
- A stale lock (older than 2 hours): show it to the user and release it only with their consent.
- A run row stuck at `in_progress` from an earlier session: mark it `aborted` with a note when the next run starts.
