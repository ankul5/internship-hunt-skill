# Package format

Input for `node scripts/apply-store.mjs prepare <app_id> <package.json>`. UTF-8 JSON. Everything personal stays in the private data directory.

```json
{
  "analysis": {
    "requirements": [
      { "text": "Experience with Python", "level": "essential",
        "source_quote": "Experience with Python is required", "status": "met",
        "evidence": ["skills[0]", "projects[0].technologies[0]"] },
      { "text": "Familiarity with ROS", "level": "preferred",
        "source_quote": "Familiarity with ROS is preferred", "status": "gap", "note": "" }
    ],
    "strongest_evidence": [{ "claim": "Python used in a robot course project", "evidence": ["projects[0]"] }],
    "gaps": ["Anything else the user should know that is not a posting requirement"]
  },
  "resume": {
    "education": [{ "ref": "education[0]", "include_coursework": ["Data Structures"] }],
    "experience": [{ "ref": "experience[0]", "bullets": [
      { "text": "Resolved walk-in and email support requests for students and staff.", "source": "experience[0].highlights[0]" } ] }],
    "projects": [{ "ref": "projects[0]", "bullets": [
      { "text": "Built a small robot that follows a track as a course project.", "source": "projects[0].description" } ] }],
    "skills": ["Python"]
  },
  "cover_letter": { "greeting": "Hiring Team", "paragraphs": ["..."], "uses": ["experience[0]", "projects[0]"] },
  "answers": [
    { "question": "Why do you want to work here?", "kind": "general", "answer": "...", "source": "projects[0]" },
    { "question": "Are you legally authorized to work in XX?", "kind": "eligibility", "answer": null }
  ],
  "recruiter_message": { "to": "person@example.com", "contact_source_url": "https://example.com/contact",
    "subject": "...", "body": "..." }
}
```

`template` (optional, top level) names the resume template for this application's PDFs, for example `"template": "harvard"`; without it the profile's `preferences.resume_template` is used, else `jake`. See `templates/resume/README.md`.

`recruiter_message` is optional and only when the user asked. Use `"user_provided": true` instead of `contact_source_url` for an address the user gave.

## Rules the helper enforces

| Part | Rule |
|---|---|
| Profile paths | Must exist and be confirmed: an entry in `education`, `experience`, `projects`, `skills`, `certifications` with provenance `resume` or `user_stated`, or an `identity.*` field with a provenance entry. `inferred_unconfirmed` and `open_questions` are never usable. |
| `requirements[].source_quote` | Must appear in the posting text on file (jobs.csv qualifications/eligibility text plus any description saved with `set-description`). Requirements cannot be invented. `status: "met"` needs `evidence`. |
| Resume sections | Only `education`, `experience`, `projects`, `skills`. Name, contact details, employers, titles, dates, degrees and technologies are rendered from the profile, never from the package. |
| Resume bullets | `source` must be a text value inside the same entry. The bullet may not contain a number, capitalised or mixed-case term (tool, employer, certification), or achievement verb (led, managed, increased, improved...) that the source and entry do not contain. |
| Resume skills | Only confirmed skill names. |
| Cover letter and other free text | Numbers and named terms must appear in the confirmed profile, the posting, or the user's recorded inputs. `uses` cites the profile paths relied on. |
| Answers | Need a `source`: a profile path, or `user:<key>` recorded with `add-input`. `eligibility`, `declaration` and `demographic` answers need `user:<key>` (or an `identity.work_authorization` path) and must repeat the recorded value exactly. No answer means `NEEDS USER INPUT`. |
| Recruiter message | Recipient needs `contact_source_url` or `user_provided`; addresses are never guessed. Saved to `drafts/`, never sent. |

The scan is a guard, not proof of truth: a rephrasing can still mislead. Read the review before showing it.

## Outputs (private data directory)

```
tailored/<app_id>/user-input.json            what the user said for this application
tailored/<app_id>/v<N>/job-snapshot.json     the job row at the time
tailored/<app_id>/v<N>/job-description.txt   posting text (fetched or pasted), with origin in meta.json
tailored/<app_id>/v<N>/resume.pdf  cover-letter.pdf   the files to upload (made from the Markdown below)
tailored/<app_id>/v<N>/resume.md  cover-letter.md  answers.md  review.md
tailored/<app_id>/v<N>/package.json  meta.json   the package, prepared_at, file hashes
drafts/<app_id>-v<N>-recruiter-message.md       only if requested
```

The PDFs are plain single-column text made with the installed Chrome or Edge; `meta.json` records their hashes and page counts, and an edited PDF voids any approval. `applications.csv` gets `resume_path` and `cover_letter_path` (the PDFs), `answers_path` (Markdown), all relative, latest version, `status` (`drafting` or `ready_for_review`), `next_action`, `updated_at`, and `prepared v<N> <timestamp>` appended to `notes`. The schema has no separate prepared-at column; the exact timestamp is also in `meta.json`.
