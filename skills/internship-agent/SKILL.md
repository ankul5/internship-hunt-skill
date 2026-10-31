---
name: internship-agent
description: Entry point and router for the internship search agent. Use when the user wants to find, verify, rank, apply to, or track internships, manage their candidate profile, or resume an earlier internship-search session. Reads local state, enforces the safety gates, and decides the next step.
compatibility: Run with the repository root as the working directory. Uses only file read/write and, when available, web search and browsing tools.
metadata:
  version: "0.2"
---

# Internship agent (router)

This is the router. Implemented workflow skills: `profile-setup` (resume and preferences to a confirmed profile), `run-search` (live discovery, verification, scoring, CSV persistence, and reading single public pages), `apply` (tailored resume, cover letter and answers for one approved job, prepared and never submitted), `submit-application` and `contact-recruiter` (outward actions: user-started only, one approved item at a time), `check-updates` (inbox updates and follow-ups: user-started only), `job-status` (read-only summary plus tracker checks and approved repairs), `integrations` (what is connected, and connecting it) and `agent-reach` (the read tool `run-search` uses). For anything else, tell the user that workflow is not available yet and stop. Do not improvise a missing workflow.

## Always, before any action

1. Read `AGENTS.md` and `references/safety-policy.md`. They are binding.
2. Resolve the private data directory: `$INTERNSHIP_AGENT_HOME` if set, else `private/` at the repository root. If it does not exist, ask the user to run `scripts/setup.ps1` (Windows) or `scripts/setup.sh`, then stop.
3. Read `sync-state.json` there. If `lock.holder` is set, tell the user another run may be active and ask before continuing.
4. Read `references/data-model.md` before touching any CSV or JSON data file.

## Routing

| User intent | Next step |
|---|---|
| Add or update resume / skills / preferences; `run-search` says the profile is not ready | `profile-setup` |
| What is missing from my profile? | `profile-setup` (`node scripts/profile-store.mjs gaps --text`) |
| Find or refresh internships, startups, or a company's career page | Use the `run-search` skill (feeds, startup discovery, career-page walk) |
| Approve a job the user picked | If it is `discovered`, verify it first (`run-search` section 8: `career-walk.mjs verify <job_id> --save`); then `apply-store.mjs approve-job <job_id> --note "<user's words>"` |
| Read a public page, search the public web, or extract details from one permitted page | `run-search` (see its `references/reading-pages.md`: Agent Reach, official feeds, Scrapling, ScrapeGraphAI; installs need the user's agreement) |
| Install or check Agent Reach | `run-search` (`references/agent-reach-install.md`; public content only; install needs the user's agreement) |
| What is connected? Connect Gmail, a connector or a browser | `integrations` |
| Check recruiter replies, inbox updates, or follow-ups | Tell the user to run `/check-updates` (user-started; reading is read-only; a follow-up needs approval of its exact text) |
| Prepare an application for an approved job (tailor resume, cover letter, answers) | `apply` (by job ID; shortlisted jobs only; prepares, never submits) |
| Submit a prepared application | Tell the user to run `/submit-application` for that application (it needs their explicit approval of the exact package; the router never starts it) |
| Message or email a recruiter | Tell the user to run `/contact-recruiter` (same: user-started, per-message approval; LinkedIn is copy-ready only) |
| Show current state, what is pending, what to do next | `job-status` (read-only) |
| Check, validate or repair the tracker; a CSV error, interrupted write or stale lock | `job-status` (repairs only after the user approves the plan) |

## Rules that never bend

- Never invent jobs, experience, recruiters, or results.
- Never submit an application or send a message without the user's explicit approval of that exact item in this conversation.
- Never write personal data outside the private data directory.
