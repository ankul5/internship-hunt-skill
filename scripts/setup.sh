#!/usr/bin/env bash
# Prepare a local checkout: expose skills to each harness and create the private data folder.
# Usage: scripts/setup.sh [--copy]     (data dir: $INTERNSHIP_AGENT_HOME, else <repo>/private)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode=link
[ "${1:-}" = "--copy" ] && mode=copy

for rel in .claude/skills .agents/skills; do
  mkdir -p "$root/$rel"
  for dir in "$root"/skills/*/; do
    name="$(basename "$dir")"
    dest="$root/$rel/$name"
    if [ -L "$dest" ]; then rm "$dest"; elif [ -e "$dest" ]; then rm -rf "$dest"; fi
    if [ "$mode" = link ]; then ln -s "../../skills/$name" "$dest"; else cp -R "$dir" "$dest"; fi
  done
  echo "skills -> $rel"
done

data="${INTERNSHIP_AGENT_HOME:-$root/private}"
mkdir -p "$data"/{resumes,tailored,drafts,email-exports,backups}
for f in "$root"/templates/data/*; do
  [ -e "$data/$(basename "$f")" ] || cp "$f" "$data/"
done
echo "private data -> $data"
