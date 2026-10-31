# Scoring rubric (v1)

Implemented in `scripts/lib/scoring.mjs`; tested in `tests/search.test.mjs`. Two separate things are computed for every job:

1. **Hard eligibility gates** → `eligibility_check` = `pass`, `fail`, or `unknown`. Objective requirements only.
2. **Fit score** → `fit_score` 0-100, a weighted measure of how well the posting matches the candidate. Subjective by nature.

A hard failure is never offset by a good fit score: the score is left empty, the job is set to `rejected` with an `[auto-rejected]` note and the reasons, and the user can override (`rejected → shortlisted`).

## 1. Hard eligibility gates

| Gate | Fails when | Unknown when |
|---|---|---|
| Employment type | `employment_type` is `other` (for example a full-time senior role). A part-time role passes when `preferences.employment_types` includes part-time and the title or the feed's employment label says part-time | `unknown` |
| Excluded company | company is in `preferences.excluded_companies` | never |
| Graduation year | posting lists accepted years and the profile's latest confirmed `education[].end_date` year is not among them | profile has no confirmed graduation date |
| Work authorization | posting lists countries and none is in `identity.work_authorization.countries` | profile has none confirmed |
| Deal-breaker | a `preferences.deal_breakers` term appears (whole word) in title, eligibility, qualifications, or stipend text. Two card answers are checks instead: "Unpaid roles" fails when that text says unpaid; "Roles needing relocation" fails for an onsite or hybrid role whose location names none of the user's places (below) | never; relocation is not checked when the work mode or location is unknown |

**Places.** The user's places are the first part of each `preferences.locations` entry without "near", "around" or "in": "Near Pune, India" gives `pune`, "Anywhere in India" gives `india`. Entries such as "Remote only" or "Anywhere in my country" give none. Location fit (below) uses the same places.

Result: any fail → `fail`; else any unknown → `unknown`; else at least one pass → `pass`; else `unknown`. Requirements the posting does not state are not checked, so `pass` means "no stated requirement is violated", not "guaranteed eligible". `unknown` means a stated requirement could not be confirmed against the profile; ask the user.

A deadline in the past or a closed page is **not** an eligibility failure; it sets status `expired`.

## 2. Fit score

Only confirmed profile facts count (provenance `resume` or `user_stated`); `inferred_unconfirmed` items are ignored.

| Component | Weight | How it is measured |
|---|---|---|
| skills | 30 | share of the posting's skills found among confirmed skills and project technologies |
| role | 25 | best share of a target role's words (excluding "intern") found in the job title |
| location | 15 | work arrangement allowed by `remote_types`, and location matches `locations`; full / partial / none |
| availability | 10 | start date inside the preferred window, and duration inside the preferred range |
| projects | 10 | share of posting keywords found in confirmed projects and experience |
| industry | 10 | posting industry is in `preferences.industries` |

A component with no usable data on either side is **n/a**: it is left out, not scored as zero. The score is `round(100 × earned / weight of the components that could be evaluated)`.

`fit_rationale` lists every component (`skills 15/30 (matched 1/2: Python)` or `location n/a`), the share of rubric weight that was evaluable, and the line "not a prediction of interview outcomes". A low evaluable share means a thin, less trustworthy score: under 50% of the weight is prefixed `LOW COVERAGE`. Unverified listings (never opened) are prefixed `PROVISIONAL`.

## Limits

- It does not predict whether anyone is interviewed or hired. Never describe a score as a chance or a guarantee.
- Stipend is not scored (free text); it is recorded verbatim for the user.
- Keyword and skill matching is literal after normalization. Synonyms are missed; that lowers a score rather than inventing a match.
- Weights are fixed in v1. Changing them means bumping the rubric version and updating tests.
