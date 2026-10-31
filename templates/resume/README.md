# Resume templates

Tailored resumes and cover letters are rendered to PDF in a template. Three ship with the project:

| Name | Look | Paper | Origin |
|---|---|---|---|
| `jake` (default) | Jake's Resume: centred small-caps name, ruled small-caps headings, serif. The usual choice for software internships. | Letter | HTML/CSS port of [jakegut/resume](https://github.com/jakegut/resume), MIT. See `jake/LICENSE`. |
| `harvard` | Career-office classic: centred headings, organisation first, education first, serif. | Letter | Original CSS following the widely published Harvard OCS guidelines. Not affiliated with Harvard. |
| `modern` | Clean sans-serif, accent colour, experience first. | A4 | Original CSS. |

All of them are single-column with real, selectable text, so application tracking systems can read them.

## Choosing one

- **Default for every application:** set `preferences.resume_template` in `candidate-profile.json`, for example through `/profile-setup`.
- **One application only:** add `"template": "harvard"` to that application's package.
- **Compare before choosing:** `node scripts/apply-store.mjs preview-template <name>` renders your confirmed profile in that template to `<data dir>/template-previews/<name>.pdf`.
- **See what is available:** `node scripts/apply-store.mjs templates` lists every template and reports any problems.

## Adding your own

Create a folder in your private data directory (by default `private/`):

```
private/resume-templates/<name>/
  template.json
  template.css
```

`<name>` uses lowercase letters, digits, `-` and `_`, and must not be a built-in name. Your template stays private, like the rest of the data directory. To share one with everyone, add it under `templates/resume/` in a pull request and include its license.

### template.json

```json
{
  "title": "My template",
  "description": "One line about the look",
  "license": "MIT",
  "attribution": "Where the design comes from, if anywhere",
  "section_order": ["education", "experience", "projects", "skills", "certifications", "achievements"],
  "section_titles": { "skills": "Technical Skills" },
  "skills_style": "grouped",
  "experience_lead": "title",
  "contact_separator": " | "
}
```

| Key | Values |
|---|---|
| `section_order` | Any order of `education`, `experience`, `projects`, `skills`, `certifications`, `achievements`. Empty sections are skipped. |
| `section_titles` | Heading text per section. |
| `skills_style` | `inline`: one comma-separated line. `grouped`: one line per skill category from the profile. |
| `experience_lead` | `title`: role and dates on the first line, organisation below. `organization`: organisation and location first, role and dates below. |
| `contact_separator` | Text between contact items, at most 5 characters. |

### template.css

The renderer always produces the HTML below. Your CSS styles it; it cannot change the content.

```html
<main class="r-resume">            <!-- the cover letter uses <main class="r-letter"> -->
  <header class="r-header">
    <h1 class="r-name">Name</h1>
    <div class="r-contact"><span class="r-contact-item">email</span><span class="r-sep"> | </span>...</div>
  </header>
  <section class="r-section r-experience">   <!-- r-education, r-projects, r-skills, ... -->
    <h2 class="r-title">Experience</h2>
    <div class="r-entry">
      <div class="r-row r-row-1"><span class="r-left"><strong class="r-org">Title</strong></span><span class="r-right">Dates</span></div>
      <div class="r-row r-row-2"><span class="r-left"><em class="r-role">Organisation</em></span><span class="r-right">Location</span></div>
      <ul class="r-bullets"><li>...</li></ul>
    </div>
  </section>
  <section class="r-section r-skills"><h2 class="r-title">Skills</h2>
    <div class="r-skills"><div class="r-skill-row"><strong class="r-skill-cat">Languages:</strong> Python, ...</div></div>
  </section>
</main>
```

Projects add `<span class="r-tech">| technologies</span>` after the name. Education may add `<div class="r-note">Coursework: ...</div>`. Cover letters use `.r-date`, `.r-greeting`, `p` and `.r-closing`. Set the paper size and margins with `@page`.

### Rules (checked on load)

- No `@import`, no `url(...)` (no images, remote fonts or files) and nothing script-like. Use fonts installed on the computer by name, with fallbacks.
- At most 64 KB of CSS.
- Keep it single-column, and keep `letter-spacing` at or below about `.08em`. Wider spacing makes the PDF text read as "S K I L L S" to application systems.
- Aim for one page. The review reports the page count.

A template only changes how the resume looks. The content still comes only from your confirmed profile, and every fact check still applies.
