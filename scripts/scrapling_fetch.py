"""Fetch one public page with Scrapling's plain Fetcher and print one JSON line.

Used by `agent-reach-search.mjs scrapling`. No stealth, proxies, or challenge solving.
Run with: python -I scripts/scrapling_fetch.py <url>
"""
import json
import sys

from scrapling.fetchers import Fetcher


def main(url):
    try:
        page = Fetcher.get(url)
        text = page.get_all_text(separator="\n") or ""
        print(json.dumps({"ok": True, "status": page.status, "text": text}))
    except Exception as e:  # report, never raise
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main(sys.argv[1])
