# Internship Search Agent: rules for every agent

This repository is a skills-first internship search agent. The skills in `skills/` are the product. There is no app, server, dashboard, or custom CLI. Read this file fully before acting; it applies in every harness.

## Non-negotiable rules

1. **Never invent anything.** No jobs, employers, recruiters, email addresses, candidate experience, skills, dates, or submission results. If you cannot verify it, leave the field empty and say so.
2. **Never submit an application or send a message without explicit approval** of that exact item (the specific job and the specific document or draft) given by the user in the current conversation. Earlier approval for something else does not carry over. Details: [references/safety-policy.md](references/safety-policy.md).
3. **Record only observed results.** Mark an application `submitted` only with confirmation evidence you actually saw. Otherwise use `submission_unconfirmed` or `submission_failed`.
4. **Use only confirmed candidate facts** from `candidate-profile.json` when tailoring. Flag gaps; do not fill them.
5. **Keep private data private.** Everything personal lives in the private data directory, which is git-ignored. Never print credentials, tokens, or full email bodies into tracked files. Details: [references/privacy-policy.md](references/privacy-policy.md).
6. **Do not bypass** logins, CAPTCHAs, paywalls, rate limits, or a site's terms. Hand the step to the user instead.

## Where things are

| Path | Purpose |
|---|---|
| `skills/` | Canonical skills (`skills/<name>/SKILL.md`). Edit here only. |
| `references/` | Safety and privacy policy, data model, integration status, JSON/CSV schemas |
| `templates/data/` | Blank data files copied to the private data directory by setup |
| `templates/documents/` | Resume, cover letter, answers, and outreach templates |
| `templates/resume/` | Resume PDF templates (`jake`, `harvard`, `modern`); users add their own in `<data dir>/resume-templates/` |
| `tests/` | `node tests/validate.mjs` and fictional fixtures |
| `docs/` | Setup and harness compatibility |
| `private/` | **Git-ignored.** Default private data directory. Override with `INTERNSHIP_AGENT_HOME`. |
| `.claude/skills/`, `.agents/skills/` | **Generated** by `scripts/setup.*`. Do not edit or commit. |

## Working with data

- Read [references/data-model.md](references/data-model.md) before reading or writing any data file.
- Back up a file to `backups/` before rewriting it. Write to a temp file, then rename.
- IDs are never reused. Rows are never deleted; set a terminal `status` instead.
- Append a row to `run-history.csv` at the start of each run and finish it at the end.

## Status honesty for integrations

Describe every tool or integration as one of: **verified** (you called it and it worked in this session), **possible_unconfigured** (known to exist, not set up), or **unsupported_or_unverified**. Never claim a capability you have not exercised. See [references/integrations.md](references/integrations.md).
