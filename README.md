# internship-hunt-skill

A portable, skills-first internship search agent for Claude Code, OpenAI Codex, Kimi Code, and other harnesses that read [Agent Skills](https://agentskills.io/specification). No website, dashboard, backend, or CLI: the `SKILL.md` files are the product, and your data stays in local CSV and JSON files.

**Status: working skills, tested with mocks and one live search; the browser and Gmail connections are not set up yet.** Ten skills: `profile-setup`, `run-search` (also reads single pages), `apply` (tailored PDF resume, cover letter, answers), `submit-application`, `contact-recruiter` (messages and replies), `check-updates` (inbox updates since the last sync or a date, and follow-ups), `job-status` (where everything stands, plus tracker checks and approved repairs), `integrations` (what is connected, and connecting it), the `internship-agent` router, and `agent-reach` (the read tool `run-search` uses). See [plan.md](plan.md).

## What it will do

Read your resume, ask for missing preferences, search for internships, verify and rank them, track everything in CSV files, prepare tailored application documents, and, only after your explicit approval of each item, submit applications and send recruiter emails. It will also read replies to track interviews, assessments, rejections, and offers.

## Principles

- Never invents jobs, experience, recruiters, or results.
- Never submits or sends without your explicit approval of that exact item.
- Personal data stays local and out of Git.

See [AGENTS.md](AGENTS.md), [safety policy](references/safety-policy.md), and [privacy policy](references/privacy-policy.md).

## Quick start

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
node tests\validate.mjs
node --test tests\search.test.mjs
```

On macOS/Linux use `scripts/setup.sh`. Full instructions: [docs/setup.md](docs/setup.md). Harness differences: [docs/compatibility.md](docs/compatibility.md).

## Layout

```
skills/            canonical skills (edit here)
references/        safety, privacy, data model, integrations, schemas
templates/data/    blank data files      templates/documents/  document templates
tests/             validate.mjs + fictional fixtures
docs/              setup and compatibility
scripts/           setup.ps1, setup.sh (link skills, create private data folder)
private/           YOUR data (git-ignored, created by setup)
.claude/skills/ .agents/skills/   generated, git-ignored
```

## Data files

`candidate-profile.json`, `jobs.csv`, `applications.csv`, `email-events.csv`, `search-history.csv`, `run-history.csv`, `sync-state.json`, and `preferences.json` (follow-up timing, once you set it). Definitions: [references/data-model.md](references/data-model.md).

## License

Not yet chosen. Add a `LICENSE` file before accepting contributions.
