# Privacy policy

This repository is meant to be public. Personal data must never enter it.

## What is private

Everything created while using the agent for a real person:

- `candidate-profile.json` and the original resume
- tailored resumes, cover letters, answers, and outreach drafts
- `jobs.csv`, `applications.csv`, `email-events.csv`, `search-history.csv`, `run-history.csv`, `sync-state.json` (these reveal where the person applied and who they contacted)
- email exports, attachments, calendar files
- credentials, API keys, OAuth tokens, client secrets, MCP config that may hold tokens

## Where private data lives

The **private data directory**: `$INTERNSHIP_AGENT_HOME` if set, otherwise `private/` at the repository root. Layout:

```
private/
  candidate-profile.json  jobs.csv  applications.csv  email-events.csv
  search-history.csv  run-history.csv  sync-state.json
  resumes/  tailored/<application_id>/  drafts/  email-exports/  backups/
```

For stronger isolation, point `INTERNSHIP_AGENT_HOME` at a folder outside the repository.

## How the repository enforces it

- `.gitignore` blocks the private directory, every data filename, personal document types (pdf, doc, docx, eml, mbox...), credential patterns, and local MCP/settings files. Only `templates/data/*` and `tests/fixtures/*` are re-allowed.
- `node tests/validate.mjs` checks that those rules work, that no tracked file is ignored-type, and that publishable files contain no non-example email addresses or credential-like strings.
- Fixtures and templates use fictional people (`Alex Example`), `example.com`/`example.org` domains, and the fictional phone range `555-01xx`.

## Rules for agents and contributors

1. Write personal data only inside the private data directory.
2. Never paste real names, emails, phone numbers, employers, or resume text into skills, docs, issues, commit messages, or tests. Use fictional values.
3. Never write credentials to any file. Authentication belongs in the harness's own secure store (for example OAuth through the MCP client).
4. Before the first `git push` in a new clone, run `node tests/validate.mjs` and `git status`.
5. If private data is committed by mistake: stop, do not push. If already pushed, rotate any exposed credentials first, then remove the data from history.

## Data minimization

Store only what a workflow needs. Keep summaries of emails, not bodies. Do not store government IDs, dates of birth, or financial details; if an application form asks for them, the user types them in.
