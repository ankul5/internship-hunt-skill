# Harness compatibility

Facts below come from the vendors' documentation, fetched 2026-10-26, except where marked. "Tested here" means run on the author's machine; only Claude Code was installed.

| | Claude Code | Codex | Kimi Code |
|---|---|---|---|
| Project skills dir | `.claude/skills/<name>/SKILL.md` | `.agents/skills/` (scanned from cwd up to repo root) | `.kimi-code/skills/` and `.agents/skills/` (project root = nearest `.git`) |
| User skills dir | `~/.claude/skills/` | `~/.agents/skills/` | `~/.kimi-code/skills/` and `~/.agents/skills/` |
| Reads `.agents/skills`? | no (not documented) | yes | yes |
| Reads `.claude/skills`? | yes | no (not documented) | not documented |
| Invoke | `/name` | `$name`, `/skills` | `/skill:name` |
| Required frontmatter | none (`description` recommended) | `name`, `description` | `name`, `description` |
| Block auto-invocation | `disable-model-invocation: true` | `agents/openai.yaml`: `policy.allow_implicit_invocation: false` | `disableModelInvocation: true` |
| MCP config | `claude mcp add`; `.mcp.json` | `~/.codex/config.toml` (syntax **not verified**) | `kimi mcp add`; file path **differs between sources** (`~/.kimi-code/mcp.json` or `~/.kimi/mcp.json`) |
| Instructions file | `CLAUDE.md` | `AGENTS.md` (**not verified here**) | **not verified** |
| Tested here | yes (version 2.1.310) | no, not installed | no, not installed |

## How this repository maps to that

- One canonical source: `skills/`, written to the open [Agent Skills specification](https://agentskills.io/specification) (name equals directory, lowercase-hyphen, description up to 1024 chars, body under 500 lines). `tests/validate.mjs` enforces this.
- Two generated discovery folders, because the conventions split exactly that way: `.claude/skills/` for Claude Code and `.agents/skills/` for Codex and Kimi Code. Both are created by `scripts/setup.*`, ignored by git, and contain links or copies of `skills/*`. No committed symlinks, since Windows git handles them unreliably.
- Harness-specific safety flags (`disable-model-invocation`, `agents/openai.yaml`, `disableModelInvocation`) are **additive** and added only to the skills that send or submit, when those skills are built. The real approval gate is the prose in the skill and in [safety policy](../references/safety-policy.md), which every harness reads.
- Nothing is put in `allowed-tools` that sends or submits.

## Known limits

- Skills reference `references/` and `templates/` at the repository root, so they only work when the repository is the working directory (or added as a directory). Standalone per-skill installs would break those links. Fixing this means copying shared references into each skill; deferred.
- Kimi Code's frontmatter keys use camelCase (`whenToUse`, `disableModelInvocation`); other harnesses may ignore or warn on unknown keys. Not tested.
- Codex and Kimi Code behavior is documented but untested. Treat both as unverified until the acceptance tests in the plan have been run on them.
- Claude Code plugin packaging (`.claude-plugin/`) would suit this layout (`skills/` at the plugin root) but its manifest format was not verified; not included.

## Troubleshooting

- **Skill not listed:** re-run `scripts/setup.*`; confirm `.claude/skills/internship-agent/SKILL.md` (or `.agents/skills/...`) exists; restart the harness; for Kimi Code make sure the folder is inside a git repository.
- **Junction/symlink errors on Windows:** run `setup.ps1 -Copy`.
- **Duplicate skills in Codex:** Codex does not merge same-named skills; remove stale copies from `~/.agents/skills`.
