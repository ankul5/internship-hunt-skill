@AGENTS.md

## Claude Code notes

- Skills are discovered from `.claude/skills/`, which `scripts/setup.ps1` (or `scripts/setup.sh`) generates from `skills/`. Edit only `skills/`.
- Skills that send or submit must set `disable-model-invocation: true` so only the user can start them. Do not put send or submit tools in `allowed-tools`.
- Project-scope MCP servers go in `.mcp.json`, which is git-ignored here because it can contain tokens. Prefer `claude mcp add` with local or user scope.
