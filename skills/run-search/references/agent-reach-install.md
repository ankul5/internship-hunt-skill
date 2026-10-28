# Agent Reach: review notes and install

Source: https://github.com/Panniantong/Agent-Reach (MIT). Reviewed 2026-10-26 by cloning and reading the code, docs, and skill file.

- **Reviewed commit:** `14c213405669414492bda0f8d52cc6531d062c45` (2026-10-25), package version 1.6.0, Python 3.10+.
- **Installed and verified on 2026-10-26** from the vendored copy (`vendor/agent-reach/`); see "Vendored copy" below.

## What the review found

Good:

- Read-only by design: its skill and code do not post, comment, like, or message.

- A public-first mode (`backend: public-web`) uses no browser and no login, and marks results as public with `completeness_verified: false`.
- No telemetry or analytics calls found in the Python code (GitHub CLI telemetry is disabled).
- Dependencies are small: requests, loguru, pyyaml, yt-dlp.

Things that need guardrails (the reason for the restrictions in `SKILL.md`):

- **Third-party endpoints.** The `web` channel reads pages through Jina Reader and searches through Exa's hosted MCP. URLs and queries leave the machine.
- **Login-gated channels.** Optional channels (LinkedIn, BOSS, Reddit, social networks) use a dedicated browser (CloakBrowser, whose binary has a separate non-open license; falls back to Chrome) and an OpenCLI bridge that can **copy the user's existing site cookies**. The LinkedIn channel is built around the `li_at` login cookie. LinkedIn's robots.txt prohibits automated access. We do not enable any of this.
- **Install side effects.** `agent-reach setup` installs the upstream skill into the user's AI tools' skill folders. If uv is missing, the guide runs a remote script (`irm https://astral.sh/uv/install.ps1 | iex`). Adding optional channels installs Node, OpenCLI, a browser and an extension.
- **Name clash.** The PyPI package `agent-reach` is a different project. Never install it from PyPI.
- Its default installation guide installs the "latest" release zip. We pin the reviewed commit instead.

## Vendored copy (this is what the project uses)

Agent Reach is vendored, unmodified, in `vendor/agent-reach/` (see `vendor/agent-reach/VENDORED.md`), and its rendered upstream skill is in `skills/agent-reach/`. Install the command from the vendored folder:

```
uv tool install --force vendor/agent-reach
agent-reach setup
```

Then run the checks in "Verify" below. Installed and verified on 2026-10-26: `agent-reach version` 1.6.0, `check web` 2/2 actions, `check github` 2/2 (via the GitHub API; `gh` is not installed).

## Install procedure (needs the user's explicit agreement first)

The steps below are the original from-source procedure; with the vendored copy, skip the clone.

Tell the user what will change: uv (and a managed Python if needed) installed, the `agent-reach` command added, and its skill written into their AI skill folders.

1. Prefer installing uv through the user's package manager rather than a piped script, for example `winget install --id astral-sh.uv -e` on Windows. Open a new shell afterwards.
2. Get the pinned source:
   ```
   git clone https://github.com/Panniantong/Agent-Reach.git
   git -C Agent-Reach checkout 14c213405669414492bda0f8d52cc6531d062c45
   ```
   Put the clone outside this repository and outside any folder you run scripts from.
3. Install from that checkout with uv's tool install on a local path (check the current uv documentation for the exact flag spelling), then run `agent-reach setup`. Read the `installation_report` it prints and show it to the user unchanged.
4. Optional channels (`agent-reach add <channel>`) are used as Agent Reach's own skill describes; some of them install a browser and an extension and can use the user's logins, so tell the user what a channel does before adding it.

## Verify

```
agent-reach version
agent-reach doctor --text
agent-reach read https://example.com/ 
```

Then one read of a permitted public posting. Record `verified` in `sync-state.json` `integrations` only if all of these worked; otherwise record the failure.

## Maintain and remove

- No automatic updates. Before `agent-reach update`, read the changelog, review what changed, and re-pin the commit in this file.
- Remove: `agent-reach uninstall --dry-run`, show it, then `agent-reach uninstall` after the user confirms. Check that the upstream skill was removed from the AI skill folders.
- Report security problems upstream through GitHub private advisories, as its SECURITY.md describes.
