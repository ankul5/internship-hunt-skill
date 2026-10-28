# Sources

Desired sources are not preconfigured integrations. This table records what was observed on **2026-10-26** in Claude Code (web search and page fetch tools, no browser, no connectors, no logged-in sessions). Codex and Kimi Code were not installed and are unverified. Re-check at run time: sites and robots.txt change.

Status labels: **verified** = worked when tried; **possible_unconfigured** = plausible but not set up; **unsupported_or_unverified** = blocked, not applicable, or not confirmed.

| Source | Status | What was observed | How to use it |
|---|---|---|---|
| Employer career pages and public ATS pages (for example Lever) | **verified** | A Lever posting fetched with full eligibility, location, work mode and requirements | Primary place to verify any listing. Prefer the original posting over aggregators. |
| Greenhouse, Lever, Ashby public feeds (`feed-search.mjs ats`) | **verified** 2026-10-27 | `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`, `api.lever.co/v0/postings/<slug>?mode=json` and `api.ashbyhq.com/posting-api/job-board/<name>` all returned HTTP 200 JSON without a key (Stripe, Databricks, GitLab, Palantir, Ramp, Notion). No endpoint lists all customers: the company list is yours | Primary source for startups and companies. Slug is the last part of the board URL. Terms not independently confirmed beyond the public, unauthenticated design; keep to 1 request/second. |
| freehire.me public API (`feed-search.mjs freehire`) | **verified** 2026-10-27 | `GET /api/v1/jobs/search` returned HTTP 200, limit 600 requests/minute per address. Same-day counts: 2,434 India internships, 452 YC-company internships, 62 global remote internships. Records are an aggregator copy; some `source` values are other boards (wuzzuf, jobstreet) | Free for personal, non-commercial use; a product showing the data needs an API plan. Open the original posting before treating a record as verified. |
| Glassdoor | unsupported_or_unverified | Not covered by the feeds above. Not tried: its terms and robots.txt have not been reviewed here, so it is treated as unsupported until they are | Do not scrape or bypass. Use as a manual lead only; ask the user to paste a URL. |
| General web search | **verified** | Returns listing pages and some postings; many results were stale or aggregator pages | Leads only. Open the original posting before recording as verified. |
| Internshala | **verified** (public pages) | robots.txt allows `/internship/detail/` (it disallows the plural `/internship/details/`). A listing page loaded; the sample one said "This internship isn't available" | Usable; treat the unavailable message as `closed`. India-focused. |
| Wellfound | **verified** for search leads; fetch **unverified** | robots.txt allows base `/jobs` paths (parameterized job URLs are disallowed). One fetched listing returned HTTP 410 (gone) | Leads from search; each listing must be opened; 410 means closed. |
| LinkedIn Jobs | unsupported_or_unverified for direct access | robots.txt: automated access without permission is prohibited. Web search shows public listing-page snippets only | Never fetch or scrape. Use snippets as leads and find the employer or ATS posting. |
| Indeed | unsupported_or_unverified for direct access | robots.txt disallows `/viewjob` for generic crawlers. Web search shows aggregator pages | Same as LinkedIn. |
| Naukri | unsupported_or_unverified | robots.txt and a listing page both returned HTTP 403 | Inaccessible; do not bypass. Offer the user manual copy-paste of a URL or text. |
| Devfolio | unsupported_or_unverified for internships | A hackathon platform; internships appear only as hackathon prizes. No job board found | Not an internship source. Mention only if the user wants hackathon leads. |
| startup.gallery | unsupported_or_unverified | Article site; no job listings found | Skip. |
| PeoplePerHour | unsupported_or_unverified for internships | Freelance project marketplace | Skip unless the user asks for freelance work. |
| Official job APIs and feeds | possible_unconfigured | Not checked for any source | Prefer them when found and permitted; verify terms first. |
| Browser automation (Claude-in-Chrome or built-in browser) | possible_unconfigured | Not exercised | Only for permitted public pages; never for login-gated or bot-protected ones. |
| Agent Reach (`agent-reach` skill) | possible_unconfigured | Reviewed, pinned, not installed (no Python or uv on this machine); public `web` and `github` channels only | Main provider for public reads once installed and `agent-reach doctor` passes. Login-gated channels are never enabled. |
| Page-reading chain: Scrapling, then ScrapeGraphAI | possible_unconfigured | Python libraries; not installed; Python was not found on this machine | Optional, one permitted page at a time; never to get past blocks or logins. See [reading-pages.md](reading-pages.md). |

## Reporting

In every run's report list each desired source with its observed status for that run: searched (how), skipped (why), or inaccessible (error). Do not copy this table's statuses forward without a check.

## Query patterns that worked

Plain-language queries plus the year or season ("software engineering intern summer 2027") and, to target a source, the site's domain. Add the candidate's role, location, or remote preference. Dates in snippets are unreliable.
