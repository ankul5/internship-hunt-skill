# Ingest format

Input for `node scripts/search-store.mjs ingest <file>`. UTF-8 JSON.

```json
{
  "run": { "started_at": "2026-10-26T10:00:00Z", "harness": "claude-code" },
  "searches": [
    { "key": "s1", "source_name": "Example Careers", "query": "software intern 2027",
      "filters": "remote=any", "status": "completed", "notes": "" },
    { "key": "s2", "source_name": "Blocked Board", "query": "intern",
      "status": "failed", "error": "HTTP 403 Forbidden" }
  ],
  "jobs": [
    {
      "search_key": "s1",
      "source_name": "Example Careers", "source_kind": "company_site",
      "source_url": "https://careers.example.com/jobs/1001",
      "apply_url": "https://careers.example.com/jobs/1001/apply",
      "company": "Example Robotics Inc.", "title": "Software Engineering Intern",
      "location": "Springfield, XX", "remote_type": "hybrid", "employment_type": "internship",
      "duration": "12 weeks", "start_date": "2027-06-01", "stipend_text": "$30/hour",
      "posted_date": "2026-10-01", "deadline": "2026-12-15",
      "eligibility_text": "Currently enrolled undergraduate graduating 2027 or 2028",
      "qualifications_text": "Python; basic robotics",
      "eligibility": { "grad_years": [2027, 2028], "countries": [] },
      "skills": ["Python", "ROS"], "keywords": ["robotics"], "industry": "robotics",
      "opened_source": true, "closed": false,
      "verification_notes": "Opened posting; title, location and deadline match page text.",
      "unverified_fields": [], "uncertainties": ""
    }
  ]
}
```

## Searches (required, at least one)

| Field | Rule |
|---|---|
| `key` | unique within the file; jobs refer to it with `search_key` |
| `source_name`, `query` | required |
| `status` | `completed`, `partial`, or `failed` |
| `error` | required when `partial` or `failed` |
| `filters`, `notes`, `executed_at` (UTC datetime), `result_count` | optional; the helper counts results itself unless `result_count` is an integer |

Jobs that refer to a `failed` search are refused. Record an attempted search even when it found nothing.

## Jobs

Required: `search_key`, `source_url` (http/https), `company`, `title`, `source_kind` (`job_board`, `company_site`, `search_engine`, `referral`, `user_provided`). An item missing any of these is skipped and reported, never recorded.

Optional text fields are copied after whitespace normalization; leave out anything not seen. `remote_type` is `onsite|hybrid|remote|unknown`; `employment_type` is `internship|co-op|apprenticeship|other|unknown`. Dates must be `YYYY-MM-DD`; invalid dates are dropped and noted in `uncertainties`.

Scoring-only inputs (not stored as columns): `eligibility.grad_years`, `eligibility.countries` (only requirements the posting states), `skills`, `keywords`, `industry`.

Verification inputs:

- `opened_source: true` plus non-empty `verification_notes` → status `verified`. `opened_source` without notes stays `discovered` with a warning.
- `closed: true`, or a `deadline` earlier than today → status `expired`.
- `unverified_fields`: column names not confirmed from the page. For unopened listings the helper defaults this to the fields that came from the snippet.

## What the helper does with existing records

A job matches an existing row when the canonical URL equals its `source_url` or `apply_url` (host lowercased, tracking parameters, fragment and trailing slash removed), or the `dedupe_key` is equal, or company and title are equal while one location is empty.

- Empty fields are filled; a differing value overwrites only when `opened_source` is true, and the change is appended to `notes`.
- Unopened sightings never blank fields, change scores, or downgrade status.
- User-owned statuses (`shortlisted`, `applied`, `archived`, a user's `rejected`) are kept; only expiry may move `shortlisted` to `expired`.
- Rows with the `[auto-rejected]` marker are re-evaluated and restored to `verified` or `discovered` if they now qualify.
- Unchanged re-sightings only update `last_checked_at`.

## Output

JSON: `run_id`, `outcome`, `sources_searched`, `inaccessible_sources`, `stats` (`new`, `updated`, `unchanged`, `duplicates_in_batch`), per-job `decisions`, `skipped`, `unverified`, `expired`, `rejected`.
