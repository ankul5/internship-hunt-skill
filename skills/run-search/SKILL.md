---
name: run-search
description: The `/run-search` pipeline. Agent Reach searches for internships, Scrapling extracts more from accessible job pages, employer job-board feeds, startup discovery and a career-page walker read companies' own pages, results are normalized, deduplicated, verified, scored against the confirmed profile and resume, and saved to jobs.csv. Also re-opens saved postings to verify them before approval. The user then reviews and approves opportunities before any application is prepared. Also the place for reading one public page or searching the web (provider chain: Agent Reach, official feeds, Scrapling, ScrapeGraphAI). Use when the user asks to search, find, refresh, or look for new internships, startups or company career pages, a role, an industry, remote or local openings, or recently posted opportunities, to verify a job, or to read a public posting or page. Never applies or messages anyone.
compatibility: Needs the repository root as working directory, Node 18+ for scripts/search-store.mjs, and Agent Reach (preferred), or another web search, fetch, browser, or connector tool in the harness. Reports honestly when none is available.
metadata:
  version: "0.3"
  rubric: "1"
---

# Run search

Read `AGENTS.md` and `references/safety-policy.md` first. This skill only reads the web and writes `jobs.csv`, `search-history.csv`, `run-history.csv`, `sync-state.json` in the private data directory. It never applies, sends, or messages.

## Pipeline

When the user runs `/run-search`:

1. **Agent Reach** searches its configured sources for internships.
2. **Scrapling** extracts additional information from accessible job pages.
3. **Normalizer** converts the results into a consistent job format.
4. **Deduplicator** removes repeated listings.
5. **Verifier** checks the source, application URL, posting date, eligibility, and other available details.
6. **Job matcher** scores each opportunity against the confirmed profile and resume.
7. **Tracker** saves the results to `jobs.csv`.
8. **You review and approve** suitable opportunities before the agent prepares applications.

Sections below say how each stage is done. Stages 3 to 7 are performed by `node scripts/search-store.mjs ingest`.

## 0. Preconditions and scope

1. Run `node scripts/search-store.mjs ready`. Exit code 2 means the profile is not ready: tell the user exactly what is missing and stop. The profile is created by the `profile-setup` skill: offer to run it. If Node is missing, say persistence needs Node 18+ and stop; do not hand-write CSV rows.
2. Read `candidate-profile.json` and `sync-state.json` from the private data directory.
2a. Run `node scripts/profile-store.mjs questions`. If `unanswered` is not empty, offer the user the `profile-setup` preference cards (step 4 of that skill) before searching. If they would rather skip, continue with the defaults below and say which preferences were unanswered.
3. If the request is complete, state your reading of it and go. Otherwise offer: all configured sources, selected platforms, a particular role or industry, remote or location-specific internships, recently posted opportunities, or refresh (section 8). Ask only for essentials that are missing. Otherwise use these defaults and **say which you used**: roles, locations, and work arrangement from the profile; posted within the last 30 days; at most 15 candidates per source.

## 1. Agent Reach searches

Run the vendored Agent Reach (`vendor/agent-reach/`, skill `skills/agent-reach/SKILL.md`) through the collector:

```
node scripts/agent-reach-search.mjs collect [--query "<q>"]... [--limit 10] [--max-reads 15]
```

Without `--query` it builds queries from the profile's `target_roles` and `locations`. For each query it runs `agent-reach web search`, then `agent-reach read <url>` on each result, and saves a **bundle** (path printed) containing exactly what Agent Reach returned, per-search status and error codes, and which reads failed. A `stopped` entry (`PLATFORM_BLOCKED`, `RATE_LIMITED`, `NEED_LOGIN`, `BUSY`) means act as Agent Reach's skill says. Use the bundle's `searches` for the `searches` entries of the ingest file. Desired sources are not integrations: check what actually works (one search or read per source, see `skills/run-search/references/sources.md`) and record the observed status of every source for the final report. Fall down the provider chain only as [references/reading-pages.md](references/reading-pages.md) says. Prefer employers' own career pages and public ATS pages as the place to verify.

- Include a `searches` entry for every attempt, including failed and zero-result searches.
- If no search tool is available, say so, record a failed search, and stop. Never write plausible-looking listings from memory.
- Do not bypass logins, CAPTCHAs, or blocks; hand the step to the user.

## 1a. Career-page and startup feeds (run these first)

Employers' own public feeds are better evidence than search results, so collect them before general web search. Both commands write a bundle and an ingest draft to the data directory and print the `check` command to run next (then `search-store.mjs ingest` on the `--fix` file, as in sections 2 to 7). They send only the query or the board slug, one request per second per host.

```
node scripts/feed-search.mjs freehire --param <facet>=<value>... [--limit 50] [--pages 1] [--label "<text>"]
node scripts/feed-search.mjs ats --file <data dir>/companies.txt [--match "<regex>"]
node scripts/feed-search.mjs ats greenhouse:<slug> lever:<slug> ashby:<name>
```

- **`freehire`** queries the public freehire.me API (no key; personal, non-commercial use; reference: `references/integrations.md`). It aggregates postings crawled from employers' own boards. Defaults to `employment_type=internship`; add facets with `--param`. Useful ones: `work_mode=remote`, `countries=IN`, `regions=global`, `collections=yc` (also `techstars`, `a16z-portfolio`, `indian-roots`), `company_type=startup`, `employment_type=part_time`, `category=...`, `skills=...`; values are listed in the API's facet table. These records are an aggregator's copy: they ingest as `discovered`, `opened_source: false`. Open the `source_url` before treating one as verified (refresh mode does this).
- **`ats`** reads one employer's own Greenhouse, Lever, Ashby, SmartRecruiters or Workable feed and keeps titles matching intern, trainee, apprentice, fresher, co-op, part-time or student (override with `--match`). The feed entry is the employer's own page data, so those records ingest as `verified` with the notes saying so (SmartRecruiters lists without descriptions: up to 20 matching postings are fetched one by one; the rest stay `discovered`). The company list is `companies.txt` in the data directory: add only boards you have seen work. A name without `=Company` is derived from the slug and flagged in `uncertainties`.
- For a "remote internships, global and India-based startups" request run: `freehire --param work_mode=remote`, `freehire --param countries=IN`, `freehire --param collections=yc`, `freehire --param company_type=startup --param work_mode=remote`, then `ats --file`. Use `--pages` for more than 50 results; the API refuses paging past 10,000 results.

## 1b. Startups and employers' own career pages

Platforms list only part of what is open. Two more ways in, both reading the employer's own pages:

**Startup discovery (grows `companies.txt`).** Run when the user wants startups, when `preferences.company_types` mentions startups, or about once a week:

```
node scripts/feed-search.mjs discover [--collections yc,techstars,indian-roots,a16z-portfolio] [--param countries=IN] [--max-probe 25]
```

It finds startups with internship listings in freehire's startup collections, works out each one's own job board from the listing (`greenhouse:<slug>` and so on), checks that the board answers (one read-only request each), and writes `board-suggestions-<time>.json` with ids `B1`, `B2`... Show the user the boards (company, collections, how many internship postings the board has now). **Add only the ones the user picks**, with their words:

```
node scripts/feed-search.mjs add-boards <board-suggestions.json> --pick B1,B4 --note "<user's words>"
```

It skips boards that did not answer or are already listed, backs up `companies.txt`, and appends the rest with a dated comment. The suggestions also list `leads_with_site`: startups on other systems whose own website is known; walk those (below).

**Career-page walk.** For employers whose site the user names, the leads above, or the sites of Agent Reach web-search results:

```
node scripts/career-walk.mjs find "<Company>=<https://site>"... [--file <data dir>/career-sites.txt] [--from-bundle <agent-reach bundle>] [--save]
```

It finds the careers page from the site's own links (then `/careers`, `/jobs`...), detects the job board behind it and reads internship postings through the board's public API, or else opens internship links on the careers page itself. JavaScript-only pages are read once more through Agent Reach. It writes a bundle and an ingest draft like the feeds, plus board suggestions for `add-boards`. `--save` runs the check and the ingest of sections 2 to 7 itself. Each site's report says what was reached and why nothing was found (no careers page, robots.txt, 429, JavaScript); repeat those in your report. Limits and rules: `references/reading-pages.md` (provider 2b).
- Record each command's outcome as a search. A `429` means stop and report it; never retry in a loop or switch IPs.
- Glassdoor, LinkedIn, Indeed and Naukri are not feeds: see `skills/run-search/references/sources.md`.

## 2. Scrapling extracts more

For each candidate worth keeping (cap by the 15-per-source default), use the **original listing** text in the bundle. Where `read_ok` is false (a snippet or page shell), add another provider's text to the bundle:

- Scrapling: `node scripts/agent-reach-search.mjs scrapling <bundle> <url>` (plain Fetcher via `scripts/scrapling_fetch.py`; details in [references/scrapling.md](references/scrapling.md)).
- ScrapeGraphAI or any other provider: save its output to a file and run `node scripts/agent-reach-search.mjs add-page <bundle> <url> <provider> <file>`, adding `--llm` for LLM-extracted output.

Fields may come from any provider's text in the bundle. Extract: title, company, location, remote/hybrid/onsite, employment type, duration, start date, stipend (verbatim, only if published), posting date, deadline, eligibility text, qualifications text, skills, keywords, industry, apply URL.

- Never fill a field you did not see in the bundle text. Leave it empty. Before ingesting, run `node scripts/agent-reach-search.mjs check <ingest.json> <bundle.json> --fix <ingest.checked.json>`: it removes any value that appears in no provider's text, refuses `opened_source` when no provider returned the page body, and keeps values seen only in LLM-extracted text (ScrapeGraphAI) but marks them unverified. Ingest the `--fix` file.
- `opened_source: true` only if you actually read the page content. Then `verification_notes` must quote what you saw.
- A search snippet alone stays unopened (`opened_source: false`); list its unconfirmed fields in `unverified_fields` and what is missing in `uncertainties`.
- Mark `closed: true` when the page says the role is filled, closed, or unavailable (or returns 404/410). Never trust snippet dates over the page.
- The structured `eligibility` object (`grad_years`, `countries`) is only for requirements the posting states explicitly.

## 3 to 7. Normalize, deduplicate, verify, match, track

Write the ingest JSON (format: `skills/run-search/references/ingest-format.md`) to a file in the private data directory, check it (above), then run `node scripts/search-store.mjs ingest <checked file>`. The helper:

- normalizes the records to the `jobs.csv` schema (3),
- assigns IDs and removes repeated listings (4),
- validates the record, the source, apply URL, dates and eligibility, and auto-rejects listings the profile is ineligible for (5),
- scores each job against the profile with the rubric `references/scoring-rubric.md` (6),
- backs up, writes atomically, and appends `search-history.csv` (7).

Do not edit the CSVs yourself.

- Exit 0: use the printed JSON for the report.
- Exit 2: refused (profile not ready, or another run holds the lock). Tell the user; never clear a lock without asking.
- Exit 1: validation or format error, nothing was written. Fix the input or report the error.

## 8. Refresh mode and verifying before approval

Only a `verified` job can be approved (`apply-store.mjs approve-job`). Aggregator records (freehire) and search snippets arrive as `discovered`. To verify, re-open the postings:

```
node scripts/career-walk.mjs verify <job_id>... --save          # the jobs the user wants to approve
node scripts/career-walk.mjs verify --status discovered --save  # refresh: every unverified job (--limit 20 by default)
node scripts/career-walk.mjs verify --status verified,shortlisted --save   # refresh: are approved jobs still open?
```

It reads the posting from the job board's public API when the URL is a known board (also a Greenhouse posting embedded in an employer page), otherwise the page itself. Outcomes: `verified` (the live text contains the title; the notes say how it was read), `closed` (404/410, a closed notice, or the board no longer lists it: the job becomes `expired`), `unverified` (page reached but too little text or no title; stays `discovered` with the reason), `not_reached` (network, robots.txt, 429: nothing is changed). `--save` runs the fact check and the ingest. The helper never overwrites user-owned statuses (`shortlisted`, `applied`, `archived`, a user's `rejected`), and `applied` or `archived` jobs are not re-opened.

Then, and only with the user's words: `node scripts/apply-store.mjs approve-job <job_id> --note "<user's words>"`.

## 9. Report and approval gate

From the helper's output, tell the user: sources searched (with query and status), results found, new records, updated/unchanged and duplicate counts, inaccessible sources with the error, skipped items with reasons, unverified listings, expired and auto-rejected listings (with the eligibility reason), and the top matches (title, company, score, link, any uncertainties). State the defaults you applied and that scores are not predictions of interview outcomes.

Then ask the user to review the list and say which jobs they approve. **Nothing is prepared or applied for until the user approves specific jobs.** Do not start tailoring or applications on your own. For an approved job that is still `discovered`, verify it first (section 8), then record the approval.

## 10. Reading one page, or searching the web without recording jobs

If the user only wants a public page read (a posting, an employer's careers or contact page) or a web search, follow [references/reading-pages.md](references/reading-pages.md) and report what you found. Nothing goes into `jobs.csv` unless they ask for it to be recorded, and then it goes through sections 3 to 7.
