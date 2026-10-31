---
name: profile-setup
description: Build or update the candidate profile (candidate-profile.json) from the user's resume and answers, so run-search has a confirmed profile to score against. Use when the user wants to set up, add, or update their resume, skills, education, experience, projects, or internship preferences (roles, locations, remote type, start dates, work authorization), or when run-search reports the profile is not ready. Saves only facts the user confirmed. Never searches, applies, or messages anyone.
compatibility: Needs the repository root as working directory and Node 18+ for scripts/profile-store.mjs. Reads the resume with the harness's file reader (PDF, DOCX text, or plain text) or from pasted text.
metadata:
  version: "0.2"
---

# Profile setup

Read `AGENTS.md`, `references/privacy-policy.md` and `references/data-model.md` first. The profile is the only source of candidate facts for scoring and, later, tailoring. This skill reads the resume and the user's answers and writes `candidate-profile.json` in the private data directory. Nothing leaves the machine: do not put resume contents or personal details into any search, URL, or third-party tool.

## 1. Look at the current state

Run `node scripts/profile-store.mjs show`. It prints the profile and what `run-search` still needs. If a profile already exists, this is an update: keep what the user does not change.

## 2. Get the resume

Ask for a path to the resume (or pasted text). Do not browse the disk for it.

- File: run `node scripts/profile-store.mjs attach-resume <path>`. It copies the file into the private data directory and prints a relative `source_path`. Read the copy with the file reader.
- Pasted text: save it to a file inside the private data directory (for example `resumes/pasted-resume.txt`) and use that relative path.
- Not readable (scanned image, locked file): say so and ask the user to paste the text. Do not guess its contents.

## 3. Extract, then confirm

From the resume text, list candidates for `education`, `experience`, `projects`, `skills`, `certifications`, and the identity fields (name, email, phone, location, links). Use only what the text says.

- Show the list to the user in plain groups and ask them to confirm, correct, or remove each group. A fact is saved only after the user confirms it.
- Confirmed from the resume: `provenance: "resume"`. Stated or corrected by the user in chat: `"user_stated"`. The helper refuses anything else.
- Do not infer skills from job titles, fill dates, round numbers, or add technologies the resume does not name. Unclear or missing items go in `open_questions` and stay out of the lists.
- Scalar fields (`identity.*`, `preferences.*`) that were confirmed get an entry in the top-level `provenance` map (dotted path to `resume` or `user_stated`).

## 4. Ask the preferences the user has not given (automatic)

After the resume facts are confirmed, always run `node scripts/profile-store.mjs questions`. It lists every setup question that is not yet answered in the profile, as ready-made choice cards in `batches` of up to 4. Skip this only when `unanswered` is empty. There are 22 cards in four groups (each card's `stage`):

- **search**: roles, job types (full-time, part-time, freelance, apprenticeship), weekly hours for part-time, locations, work mode, relocation, industries, company types (startups or large companies), work authorization, exclusions;
- **scoring**: start dates, duration, stipend;
- **apply**: certifications and awards not on the resume, whether to show CGPA, resume template (look), languages;
- **outreach**: one-line pitch, tone, sending address, signature, follow-up timing.

Ask every batch; do not stop after the first two. The user can skip any card.

- Ask each batch with the harness's multiple-choice question tool (in Claude Code, `AskUserQuestion`, passing the cards' `question`, `header`, `multiSelect` and `options`). Without such a tool, ask the same questions as a short numbered list. The user can always type their own answer ("Other").
- Do not ask what the user already told you in chat; use that answer instead.
- Write exactly what the user chose or typed into the fields named in each card's `maps_to`. Dates must be exact (`YYYY-MM-DD`): if the answer is vague ("next summer"), ask for the dates or leave them null. Do not guess.
- Mark every question the user answered **or skipped** by adding its `answered_by` key to the top-level `provenance` map with `user_stated` (leave the field empty or null if they skipped or chose "Flexible", "Any" or "Nothing"). That is what stops the question being asked again.
- `target_roles` is required for search: if the user will not choose any, say `/run-search` cannot run without it. If the resume points at other roles too (for example ML projects but only "Software engineering" chosen), ask once whether to add them.
- Start dates: turn "Right away" or "Next summer" into exact dates **with** the user (for example "from 2026-11-01 to 2026-12-15, is that right?"); never fill them silently.
- Certifications and awards: when the user lists them, add `certifications[]` (name, issuer, date) or `achievements[]` (name, description, date) entries with `provenance: "user_stated"`, in their exact words.
- Pitch: draft one sentence from confirmed facts only, show it, and save it to `outreach.pitch` only after the user confirms or edits it.
- Follow-up timing is saved by `node scripts/followup-store.mjs set-prefs --after-days N --note "<user's words>"`; also add `outreach.follow_up` to `provenance`.
- "No" to relocation also adds "Roles needing relocation" to `deal_breakers`, and "Paid only" adds "Unpaid roles": scoring turns those two phrases into real checks.
- If the user declines work authorization, leave it empty and say eligibility checks will be limited. Expected graduation year comes from the confirmed `education[].end_date`.

Run `questions` again later (for example from `/run-search`) to catch anything still unanswered; it only returns unanswered ones.

## 5. Save

Write the full profile JSON to a file in the private data directory (for example `profile-draft.json`), keeping every key of `templates/data/candidate-profile.json`. Show the user a summary of what will be saved, and get their go-ahead. Then run `node scripts/profile-store.mjs save <file>`. It validates, backs up the old profile to `backups/`, stamps `updated_at`, and writes atomically.

- Exit 1: it lists the problems and writes nothing. Fix them with the user.
- Delete the draft file afterwards if it holds nothing the profile does not.

## 6. Report

Run `node scripts/search-store.mjs ready` and tell the user whether `/run-search` can run now. Then run `node scripts/profile-store.mjs gaps --text`: it lists what is still missing for each stage (search, scoring, apply, outreach, submit) and the `open_questions`. Tell the user the gaps in plain words and offer to fill them now. Do not start a search or any application.

Run `gaps` again whenever the user asks what is missing, or before `/apply` and `/contact-recruiter`. The profile can be updated at any time: `show`, change only what the user changes, `save` (the old file is backed up first).
