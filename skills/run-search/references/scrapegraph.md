# ScrapeGraphAI notes (fallback backend)

Scrapling is the preferred backend (`scrapling.md`) because ScrapeGraphAI needs a second LLM that can invent values. Use this one only when selectors are impractical and the user accepts that trade-off.

Source: the project README (https://github.com/ScrapeGraphAI/Scrapegraph-ai), read 2026-10-26. Re-read it before use; APIs change. **Not run or tested here.**

## Facts from the README

- Python library, MIT license. Install: `pip install scrapegraphai`, then `playwright install` (needed to fetch websites). A virtual environment is recommended.
- An LLM is required: hosted (OpenAI, Groq, Azure, Gemini and others, with your own key, for example `openai/gpt-4o-mini`) or local through Ollama (after `ollama pull`, for example `ollama/llama3.2`).
- Telemetry is on unless `SCRAPEGRAPHAI_TELEMETRY_ENABLED` is set to `false`.
- A managed cloud API exists (needs `SGAI_API_KEY`, billed per credit, includes proxies and anti-bot handling) and an MCP server is listed on Smithery. Neither was evaluated; both send requests to a third party.
- The README says the library is meant for data exploration and research, and does not address robots.txt or site terms.

## Starting example (adapt, then verify against the README)

Matches the README quick-start structure: `SmartScraperGraph`, a config dict with an `llm` section, `.run()`.

```python
import json
from scrapegraphai.graphs import SmartScraperGraph

config = {
    "llm": {"model": "ollama/llama3.2", "model_tokens": 8192, "format": "json"},
    "verbose": False,
    "headless": True,
}

graph = SmartScraperGraph(
    prompt="Return JSON with title, company, location, work_mode, stipend, deadline, "
           "eligibility and requirements exactly as written on the page. Use null for anything not stated.",
    source="https://careers.example.com/jobs/1001",
    config=config,
)
print(json.dumps(graph.run(), indent=2))
```

Run it with `SCRAPEGRAPHAI_TELEMETRY_ENABLED=false` in the environment. The prompt asks for "exactly as written" and `null` for missing values to reduce invention, but you must still verify every value against the page text.

## Checklist before each use

- [ ] robots.txt and terms allow it; no login or bot check involved
- [ ] user agreed to the install and to the chosen LLM (local vs hosted)
- [ ] API key is in an environment variable, not a file
- [ ] telemetry disabled
- [ ] one specific URL, not a crawl
- [ ] every extracted value checked against the page text before it enters the CSVs
