# Finding people to contact

Applies to every skill that picks a recruiter, hiring manager, or other person to email or message. It exists so outreach is real, relevant, and lawful, and so the candidate's accounts and email reputation are not put at risk.

## Allowed sources, in order of preference

1. A contact the **user gives you**.
2. The **posting itself**: an apply or recruiter email, or a named recruiting contact.
3. The **employer's own pages** about that role or team: careers, university-recruiting, team, or contact pages. A published generic address such as a careers inbox counts.
4. The **ATS posting metadata** shown on the public posting.
5. Anything the **user finds themselves** (for example on LinkedIn) and pastes to you. The agent never queries LinkedIn people search or profiles.

## Not allowed

- Bypassing logins, CAPTCHAs, bot protection, or blocks, or using the user's login/cookies to read people's profiles.
- Collecting emails, names, or profile IDs from directories, social networks, member lists, or scraped profile pages.
- Guessing or generating addresses (`first.last@company`), or using tools that probe mailboxes to "verify" guesses.
- Leaked, purchased, or scraped contact lists.
- Using a contact for anything other than the specific application it was found for.

Why: most platforms' terms forbid it and enforce it with account bans; privacy and anti-spam laws in many places restrict harvesting and unsolicited bulk mail; and mass cold email gets the candidate's address flagged as spam. A few well-chosen, sourced messages work better than many scraped ones.

## How contacts are recorded

In `email-events.csv`: `contact_name`, `contact_email`, and `contact_source_url` (the page where it was published). If the user supplied the contact, say so in `summary` and leave the URL empty. **A contact with neither a source URL nor a user origin is not used.** Never store profile scrapes or lists.

## Defaults for volume (the user may change them)

- One contact per application; at most two per company.
- At most one follow-up, no sooner than 7 days after the first message and only if there was no reply.
- No message goes out without the candidate's approval of that exact text and recipient (`references/safety-policy.md`).

## LinkedIn

Draft connection notes and messages for the candidate to read, edit, and send themselves. The agent does not send LinkedIn messages or automate LinkedIn.

## When no contact can be found

Say so. The application can proceed without outreach, or the user can look someone up and paste the details.
