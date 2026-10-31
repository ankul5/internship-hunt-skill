---
name: integrations
description: Show which integrations (Gmail read and send, Gmail connectors, browser automation, Google Drive, public job feeds) and job platforms (LinkedIn, Indeed, Naukri, Internshala, Wellfound and others) are available and verified, need account authorization, need configuration, or are unsupported, and guide the user through connecting what is missing without ever handling their secrets. Use when the user asks what is connected or set up, wants to connect Gmail or another service, or when another skill reports an integration is unavailable.
compatibility: Needs the repository root as working directory and Node 18+ for scripts/integrations-store.mjs and scripts/gmail-store.mjs. Connecting Gmail directly needs a Google account and a Google Cloud project the user owns; alternatively a Gmail connector in the harness.
metadata:
  version: "0.1"
---

# Integrations

Read `AGENTS.md`, `references/privacy-policy.md` and `references/integrations.md` first. Never say a service is connected until a real authorization and a real test have succeeded in this session. Do not assume Gmail, LinkedIn, Indeed, Naukri, Internshala or any other service is connected.

The other skills do this for you: `contact-recruiter` (sending, and checking replies) and `submit-application` each start with `node scripts/integrations-store.mjs preflight <task>`, which returns the question to ask the user (which email or connector, or copy-ready) and the connection steps. This skill is for checking everything at once or connecting ahead of time.

## 1. Show readiness

`node scripts/integrations-store.mjs readiness --text` prints the checklist in four groups: **available and verified**, **requires account authorization**, **requires configuration**, **unsupported or unverified**. It reads local state only (no network, no mailbox) and prints no secrets. Show it to the user as it is, then offer to set up what is missing. `node scripts/integrations-store.mjs platforms --text` shows what each job platform supports for search, applying and messaging, how it is authorized, its limits, and what was actually verified (`references/platforms.md`).

## 2. When something is missing: ask the user, do not improvise

For every item that is not verified, tell the user plainly what is missing, ask whether they want it, and walk them through the `next_steps` the checklist gives. Ask for the things in `ask_user`. Always:

- **Secrets never go through you.** Never ask the user to paste a password, an OAuth client secret, a refresh token or an API key into the chat, a skill, or any file inside this repository. They download the OAuth client file from Google themselves and save it in the secrets folder outside the repository (`gmail-store.mjs setup-help` prints the exact path), and they approve access on Google's own sign-in page.
- **Downloads are untrusted.** If the user wants a Gmail connector, an MCP server or a skill from somewhere, ask for the link, put it in a new empty folder, read what it does, and install it only after they agree (`skills/run-search/references/agent-reach-install.md` shows the pattern). Prefer an official connector or documented API over a third-party script. Add MCP servers with `claude mcp add` at local or user scope, never in a tracked file.
- **Smallest permission first.** Gmail read-only before anything else. Sending is a separate, later consent.
- Record a status as `verified` only after you actually exercised it, with what you did (`set-integration` in `scripts/submit-store.mjs`, or the `check`/`probe` commands, which do it for you).

## 3. Connect Gmail directly (read-only first)

1. `node scripts/gmail-store.mjs setup-help` and give the user the steps (their own Google Cloud project, a Desktop-app OAuth client, themselves as test user, the client file saved in the secrets folder).
2. When the client file is in place and the user says go: `node scripts/gmail-store.mjs login --levels read`. It prints a Google sign-in link; the user opens it and approves **read-only** access.
3. `node scripts/gmail-store.mjs check` makes a real read call and records the result. Only then is Gmail "available and verified" for reading.
4. Sending is optional and separate: `login --levels read,send` asks for the extra send-only permission, and `check` then verifies authorization (it sends no test email). The first approved real send is confirmed by Gmail returning a message id. Compose and modify permissions are never requested, so the agent cannot alter or delete mail.
5. If access stops working (revoked or expired), `check` or `sync` records it and the checklist asks for authorization again. `logout` revokes the token and deletes it.

Google's consent screen for a personal project shows an "unverified app" notice; that is expected for the user's own account. How long refresh tokens last for a project in Testing status was not verified here, so re-authorize if access stops.

## 4. Public sources and other tools

`node scripts/integrations-store.mjs probe ats-feeds`, `probe freehire` and `probe career-walk` make a few read-only requests to public endpoints and record the result; `probe pdf` renders a test PDF locally (nothing leaves the computer). Browser automation and Drive are tested with one harmless read and recorded with `set-integration`. LinkedIn, Indeed, Naukri, Glassdoor: no automation; see the platform matrix. Do not bypass logins, CAPTCHAs, rate limits or terms.

## 5. Report

State the checklist, what you changed or tested this session, and the next step for each missing item. Do not describe anything as working that you did not test.
