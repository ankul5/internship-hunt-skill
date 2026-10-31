# Setup

The short version is in the [README quick start](../README.md#quick-start). This page has the details. Windows paths are shown first; macOS/Linux equivalents follow.

## Prerequisites

- git (needed for project-root detection by Kimi Code, and for the ignore checks)
- Node 18+ (the helper scripts and tests; no dependencies to install)
- Chrome or Edge (used headless to make the resume and cover letter PDFs)
- At least one harness: Claude Code, OpenAI Codex, or Kimi Code

## 1. Get the repository and run setup

```powershell
git clone https://github.com/ankul5/internship-hunt-skill.git
cd internship-hunt-skill
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1      # add -Copy to copy instead of linking
node tests\validate.mjs
```

```bash
scripts/setup.sh            # add --copy to copy instead of linking
node tests/validate.mjs
```

Setup does two things:

1. Links every folder in `skills/` into `.claude/skills/` and `.agents/skills/` (both are git-ignored and regenerated on each run). On Windows it uses directory junctions, which need no admin rights, and falls back to copying. After editing a skill, re-run setup only if you used `-Copy`.
2. Creates the private data directory (default `private/`) from `templates/data/`. Existing files are never overwritten.

To keep private data outside the repository, set `INTERNSHIP_AGENT_HOME` to that folder before running setup and before starting the harness.

## 2. Start your harness in the repository root

| Harness | Skill location used | Invoke | Instructions file |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `/internship-agent` | `CLAUDE.md` (imports `AGENTS.md`) |
| Codex | `.agents/skills/` | `$internship-agent` or `/skills` | `AGENTS.md` |
| Kimi Code | `.agents/skills/` | `/skill:internship-agent` | `AGENTS.md` (unverified, see compatibility) |

The agent must run with this repository as the working directory, because skills refer to `references/` and `templates/` by repository-relative path. User-level installs (`~/.claude/skills`, `~/.agents/skills`) are not supported yet.

## 3. First run check

Ask the harness to run the skill. Expected: it reads `AGENTS.md`, locates the private data directory, reads `sync-state.json`, and offers the next step (usually `/profile-setup`). If it does not list the skill, see [compatibility.md](compatibility.md#troubleshooting).

## Where your data goes

Everything personal stays in the private data directory and is git-ignored. See [../references/privacy-policy.md](../references/privacy-policy.md). Never put your resume anywhere else in the repository.

## Publishing safely

Before any `git push`: run `node tests/validate.mjs` and `git status`. The test fails if a private path is not ignored, if an ignored-type file is tracked, or if a publishable file contains a non-example email or a credential-like string.
