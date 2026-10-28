# Scrapling notes

Source: the project README (https://github.com/D4Vinci/Scrapling), read 2026-10-26. Re-read it before use. **Not run or tested here.**

## Facts from the README

- Python 3.10+, BSD-3-Clause license. Parser only: `pip install scrapling`. Fetchers: `pip install "scrapling[fetchers]"`, then `scrapling install` to download browsers. Extras include `scrapling[ai]` (an MCP server). A Docker image exists.
- No LLM is needed for core scraping.
- Fetcher types: a plain HTTP `Fetcher`, and a browser-based `StealthyFetcher`.
- The README advertises stealth features: browser fingerprint spoofing, Cloudflare Turnstile/Interstitial bypass, proxy rotation, DNS-over-HTTPS. **This repository does not use any of them.**
- It has an optional `robots_txt_obey` flag (Key Features list) for its crawling features.
- The README says the library is provided for educational and research purposes, and to comply with scraping and privacy laws, site terms of service, and robots.txt.

## What we use

Only the plain HTTP `Fetcher` and the parser, on a single permitted page. If JavaScript rendering is truly needed and the site allows it, ask the user before using a browser-based fetcher in its ordinary (non-stealth, no-proxy) mode.

Example, from the README's quick start (swap in the permitted URL and the selectors for the fields you need):

```python
from scrapling.fetchers import Fetcher

page = Fetcher.get('https://quotes.toscrape.com/')
quotes = page.css('.quote .text::text').getall()
print(quotes)
```

Other documented calls: `page.xpath('//div[@class="quote"]')` and `page.css('.quote')[0].css('.text::text').get()`.

Workflow that avoids guessing selectors: fetch the page, print its visible text (or a trimmed HTML outline), read it yourself, then write selectors or just copy the values you can see. Quote the text that supports each value.

## Checklist before each use

- [ ] robots.txt fetched and read; the path is allowed; terms do not forbid automated access
- [ ] no login, cookies, or saved session involved
- [ ] plain fetcher only: no stealth, no proxies, no challenge solving
- [ ] one specific URL, not a crawl
- [ ] user agreed to the install
- [ ] every value checked against the page text before it enters the CSVs
- [ ] blocked (403/429/challenge)? stop, record the failure, hand to the user
