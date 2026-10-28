<!-- GENERATED from references/platforms.json by: node scripts/integrations-store.mjs render-platforms --write. Edit the JSON, not this file. -->

# Platform capabilities

What each platform supports for search, application and messaging, how it is authorized, its limits, and what was actually verified. A status of **verified** means it was exercised, with the date and evidence shown. Everything else is **possible_unconfigured** or **unsupported_or_unverified**. Nothing here permits scraping a site its rules forbid or getting past a login, CAPTCHA or rate limit; those steps go to the user.

| Platform | Search | Application | Messaging |
|---|---|---|---|
| Employer career pages on Greenhouse, Lever, Ashby | verified | unsupported_or_unverified | unsupported_or_unverified |
| freehire.me public API | verified | unsupported_or_unverified | unsupported_or_unverified |
| Internshala | verified | unsupported_or_unverified | unsupported_or_unverified |
| Wellfound | possible_unconfigured | unsupported_or_unverified | unsupported_or_unverified |
| LinkedIn | unsupported_or_unverified | unsupported_or_unverified | unsupported_or_unverified |
| Indeed | unsupported_or_unverified | unsupported_or_unverified | unsupported_or_unverified |
| Naukri.com | unsupported_or_unverified | unsupported_or_unverified | unsupported_or_unverified |
| Glassdoor | unsupported_or_unverified | unsupported_or_unverified | unsupported_or_unverified |
| Gmail | unsupported_or_unverified | unsupported_or_unverified | possible_unconfigured |
| Outlook / Microsoft 365 mail | unsupported_or_unverified | unsupported_or_unverified | unsupported_or_unverified |

## Employer career pages on Greenhouse, Lever, Ashby

| | Method | Status |
|---|---|---|
| Search | Employer's own public JSON feed per company (boards-api.greenhouse.io, api.lever.co, api.ashbyhq.com); no key. The company list is the user's (companies.txt) | verified |
| Application | On the employer's page, by the user or a permitted browser session. Greenhouse's application API needs the employer's own API key (per third-party documentation, not checked), so it is not available to candidates | unsupported_or_unverified |
| Messaging | none | unsupported_or_unverified |

- **Authentication:** None for reading
- **Permissions and limitations:** Read-only; one request per second per host; no endpoint lists all customers
- **Verification:** 2026-10-27. Six boards (Stripe, Databricks, GitLab, Palantir, Ramp, Notion) returned HTTP 200 JSON; 84 intern postings parsed

## freehire.me public API

| | Method | Status |
|---|---|---|
| Search | GET /api/v1/jobs/search with facets (employment_type, work_mode, countries, collections, company_type); no key | verified |
| Application | Records link to the original posting; apply there | unsupported_or_unverified |
| Messaging | none | unsupported_or_unverified |

- **Authentication:** None for the public read endpoints
- **Permissions and limitations:** Personal, non-commercial use; 600 requests per minute per address; records are an aggregator copy, open the original before treating as verified
- **Verification:** 2026-10-27. HTTP 200; 2,434 India internships, 452 YC-company internships, 62 global remote internships that day

## Internshala

| | Method | Status |
|---|---|---|
| Search | Public listing pages (/internship/detail/) read one at a time; robots.txt allows that path | verified |
| Application | On the site, signed in as the user, by the user. Not automated | unsupported_or_unverified |
| Messaging | none outside the site | unsupported_or_unverified |

- **Authentication:** User's own account for applying; none for reading public pages
- **Permissions and limitations:** India-focused; a listing that says it is unavailable is closed
- **Verification:** 2026-10-26. A public listing page loaded and reported itself unavailable; robots.txt read

## Wellfound

| | Method | Status |
|---|---|---|
| Search | Leads from web search; listing fetch is unreliable | possible_unconfigured |
| Application | On the site, by the user | unsupported_or_unverified |
| Messaging | none | unsupported_or_unverified |

- **Authentication:** User's own account for applying
- **Permissions and limitations:** Parameterised job URLs are disallowed by robots.txt; one fetched listing returned HTTP 410 (gone)
- **Verification:** 2026-10-26. robots.txt read; one listing returned 410

## LinkedIn

| | Method | Status |
|---|---|---|
| Search | Public web-search snippets as leads only; linkedin.com is never fetched or scraped. No official job-search API was found or checked | unsupported_or_unverified |
| Application | The user, in their own signed-in browser | unsupported_or_unverified |
| Messaging | Copy-ready draft; the user sends it in LinkedIn. Gmail cannot send LinkedIn messages | unsupported_or_unverified |

- **Authentication:** The user's own login in their own browser; the agent never receives credentials
- **Permissions and limitations:** robots.txt prohibits automated access without permission; the agent never reads profiles or people search
- **Verification:** 2026-10-26. robots.txt read; only search snippets seen

## Indeed

| | Method | Status |
|---|---|---|
| Search | Leads from web search only | unsupported_or_unverified |
| Application | The user, on the site | unsupported_or_unverified |
| Messaging | none | unsupported_or_unverified |

- **Authentication:** User's own account
- **Permissions and limitations:** robots.txt disallows /viewjob for generic crawlers; any partner or publisher API was not checked
- **Verification:** 2026-10-26. robots.txt read

## Naukri.com

| | Method | Status |
|---|---|---|
| Search | None: robots.txt and a listing page both returned HTTP 403 | unsupported_or_unverified |
| Application | The user, on the site | unsupported_or_unverified |
| Messaging | none | unsupported_or_unverified |

- **Authentication:** User's own account
- **Permissions and limitations:** Inaccessible to automated reads; do not bypass. The user can paste a URL or the posting text
- **Verification:** 2026-10-26. HTTP 403 on robots.txt and on a listing

## Glassdoor

| | Method | Status |
|---|---|---|
| Search | None tried. Its terms and robots.txt were not reviewed, so it is treated as unsupported until they are | unsupported_or_unverified |
| Application | The user, on the site | unsupported_or_unverified |
| Messaging | none | unsupported_or_unverified |

- **Authentication:** User's own account
- **Permissions and limitations:** Manual leads only: the user pastes a link
- **Verification:** not verified. Not tried

## Gmail

| | Method | Status |
|---|---|---|
| Search | Not a job source | unsupported_or_unverified |
| Application | Not an application channel | unsupported_or_unverified |
| Messaging | Gmail API: read with gmail.readonly (restricted scope), send with gmail.send (sensitive scope); each authorized separately. Replies thread with In-Reply-To and References headers | possible_unconfigured |

- **Authentication:** OAuth 2.0 loopback flow with PKCE, using a Desktop-app OAuth client the user creates in their own Google Cloud project; tokens stay outside the repository
- **Permissions and limitations:** No compose, modify or delete scope is requested, so mail is never altered. For a personal Google Cloud project the consent screen shows an unverified-app notice. How long refresh tokens last for an app in Testing status was not verified; re-authorize if access stops working
- **Verification:** not verified. Not configured; documented in Google's Gmail API and OAuth 2.0 desktop-app guides (read 2026-10-27)

## Outlook / Microsoft 365 mail

| | Method | Status |
|---|---|---|
| Search | Not a job source | unsupported_or_unverified |
| Application | Not an application channel | unsupported_or_unverified |
| Messaging | Not implemented. Microsoft Graph exists but was not checked | unsupported_or_unverified |

- **Authentication:** Not applicable
- **Permissions and limitations:** Copy-ready drafts only
- **Verification:** not verified. Not tried
