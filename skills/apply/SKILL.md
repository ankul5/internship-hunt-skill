---
name: apply
description: Prepare an application package for one approved internship, by job ID. Reads the confirmed profile and the latest posting, separates essential from preferred requirements, maps them to real evidence and gaps, writes a job-specific resume, cover letter and application answers using only confirmed facts, flags questions that need the user, optionally drafts a recruiter message, saves everything privately in versioned folders, and marks the application prepared, not submitted. Use when the user picks an approved or shortlisted job to apply to, asks to tailor a resume or write a cover letter for a job, or wants to prepare answers for an application. Never submits, emails, or messages anyone.
compatibility: Needs the repository root as working directory and Node 18+ for scripts/apply-store.mjs. Re-reading the posting uses Agent Reach or any web fetch tool the harness has; without one, the user pastes the posting.
metadata:
  version: "0.1"
---

# Apply (preparation only)

Read `AGENTS.md`, `references/safety-policy.md`, `references/privacy-policy.md` and `references/data-model.md` first. This skill writes documents into the private data directory and records them in `applications.csv`. **It never submits a form, sends an email, sends a message, or uploads anything.** Submission and sending are a later, separate step that needs the user's approval of the exact package.

The helper `node scripts/apply-store.mjs` does the gating, fact checking, versioning and tracker writes. You write the content. Package format: [references/package-format.md](references/package-format.md).

Preparing an application needs **no email or connector**: it uses only your profile and the posting. The question "which email do you want to send from, or which connector" comes later, at the start of `contact-recruiter` (and `submit-application` for the browser), and each of those skills asks it and helps connect before doing anything.

## 1. Select an approved job

The user names a job by its stable ID (`job-0007`). If they have not, run `node scripts/apply-store.mjs list` and show the shortlisted jobs.

A job is approved only when its status is `shortlisted`. If the user says "yes, apply to job-0007" and it is `verified`, run `node scripts/apply-store.mjs approve-job job-0007 --note "<their exact words>"`. A `discovered` job must be opened and verified first (run-search refresh). **Never process a `rejected`, `expired`, `discovered`, `applied` or `archived` job**: the helper refuses, and you must not work around it. If the user overrides a rejection, they say so in words and `approve-job` records them.

## 2. Open the application

`node scripts/apply-store.mjs start <job_id>` creates (or reuses) the application as `drafting`, opens a new version folder `tailored/<app_id>/v<N>/`, and prints the job record and the **confirmed** profile (only facts with provenance `resume` or `user_stated`). Use nothing outside that output as a candidate fact.

Exit 2 means refused: relay the reason and stop (not approved, profile not ready, lock held, already submitted).

## 3. Get the latest posting

Re-open the job's `source_url` with the page-reading chain in `skills/run-search/references/reading-pages.md` (Agent Reach first) and save the text to a file in the private data directory, then:

`node scripts/apply-store.mjs set-description <app_id> <file> --origin fetched --url <source_url>`

If the page cannot be read, ask the user to paste the posting and use `--origin user_provided`. `start` reports `description.status`. If it is `missing`, `prepare` is refused: ask the user for the text or explain what could not be verified. **Never write requirements from memory or from the job title.** A carried-over description from an earlier version is flagged stale; refresh it.

If the posting asks for something the profile cannot answer, that is a gap or an open question, not something to fill.

## 4. Analyse

Build `analysis.requirements`: every requirement the posting states, each with a verbatim `source_quote`, `level` (`essential` for must/required/minimum, `preferred` for plus/nice/preferred), `status` (`met`, `partial`, `gap`) and `evidence` (profile paths such as `projects[0]`). Add `strongest_evidence`: the confirmed facts that best match, with paths. Be plain about gaps; they appear in the review and are never covered in the documents.

## 5. Write the package

Compose the JSON package (see the reference) and tailor truthfully:

- **Resume:** choose and order entries by relevance; rephrase bullets from the cited `highlights`/`description` without adding numbers, tools, scope, or stronger verbs (led, managed, improved...). Contact details, employers, titles, dates and education come from the profile automatically. Do not keyword-stuff; use a posting term only where the profile already shows that skill.
- **Cover letter:** two or three short paragraphs. Role facts come from the posting, candidate facts from the profile, anything else from `add-input` (see below). Cite what you used in `uses`. No enthusiasm for details you did not read.
- **Answers:** copy each form question verbatim. Answer only from a profile path or a user-recorded input. **Leave eligibility, declaration and demographic questions empty** unless the user gave the answer: ask, record it with `node scripts/apply-store.mjs add-input <app_id> --key <k> --text "<value>" --quote "<their words>"`, then answer with `source: "user:<k>"` and the exact recorded value. Empty answers become `NEEDS USER INPUT`.
- **Recruiter message (only if the user asked):** the recipient must be given by the user (`user_provided`) or published on a page you cite (`contact_source_url`), per `references/contact-discovery.md`. Never guess an address. It is saved as a draft file and sent by no one.

If the user corrects a fact (a date, a title, a skill), update the profile through `profile-setup` (`user_stated`), then run `start` again for a new version. Do not edit documents by hand.

## 6. Prepare

Write the package to a file in the private data directory and run:

`node scripts/apply-store.mjs prepare <app_id> <package.json>`

- Exit 1 lists every problem and **nothing is written**: unsupported numbers or terms, achievement verbs not in the source, skills or entries that are not confirmed, requirement quotes not in the posting, sensitive answers without the user's input. Fix the package; do not weaken the facts.
- Exit 2 is a refusal (no description, wrong status, lock, **no PDF could be made**): tell the user. The PDFs are made with the Chrome or Edge already on the computer (headless, a throwaway profile, never the user's own browser profile); if neither is found, ask the user to install one or set `INTERNSHIP_AGENT_BROWSER` to its path. A resume that cannot be uploaded is not "prepared", so nothing is written. The review lists each PDF's page count: an internship resume is usually one page, so if it runs longer, offer to tighten it.
- Success writes `resume.md`, `cover-letter.md`, `answers.md`, `review.md` **and the PDFs `resume.pdf` and `cover-letter.pdf`** under `tailored/<app_id>/v<N>/`, an optional draft under `drafts/`, and updates the tracker row: the three paths (`resume_path` and `cover_letter_path` point at the **PDFs**, which are the files to upload; the Markdown is the readable source), `next_action`, `updated_at`, and `prepared v<N> <timestamp>` in `notes`. Status is `ready_for_review` if nothing is open, otherwise `drafting` with the open items listed. It is never `approved` or `submitted` here.

Several versions of one application are kept (`v1`, `v2`...); the tracker points to the latest. Starting a new version clears any earlier approval.

## 7. Show the package for review

Run `node scripts/apply-store.mjs review <app_id>` and show the user, in full:

1. the target company and role, and the source URL (and apply URL);
2. the final resume and cover letter;
3. all application answers;
4. every declaration or eligibility question and its answer or `NEEDS USER INPUT`;
5. the gaps, uncertainties (posting last verified, unverified fields, stale description) and missing information.

If `modified_since_prepared` is set, the files were edited after preparation: say so and treat any earlier approval as void.

Then ask the user to review the final package. **Stop.** Do not submit, email or message from this skill, and do not read a "looks good" as approval to send. Approval and submission belong to the next step, per `references/safety-policy.md`.

## Report

Say which job and application were prepared, the version, the folder, the status (prepared, not submitted), what is open, and the gaps. Say plainly if anything could not be verified.
