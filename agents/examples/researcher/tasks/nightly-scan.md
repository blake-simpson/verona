# Task: nightly-scan

Scan for new and emerging AI-coding tools, agent frameworks, and developer-productivity infrastructure with traction in the last 30 days. Goal: 1–3 high-signal findings to share in Slack.

## Sources to consider

- GitHub trending (TypeScript, Go, Rust filters)
- Hacker News front page + "Show HN" from the last week
- New activity on repos already in `memory/learned/facts/tracked-projects/` (if any)

Don't try to scan all of these — pick what's most likely to surface signal given recent context (read `memory/INDEX.md` first).

## Filtering rules

- ≥ 100 stars OR active maintainer with prior reputable work.
- Real working repo, not a landing page.
- ≥ 3 months of commits OR a v1.0+ release.
- Reject: announcement-only, pre-product launches; "AI assistant for X" wrappers without a novel angle; reposts of last week's findings.

## Output

1. Print a Slack-ready digest: 1–3 projects, each with name, link, one-line capability, why-it-matters (≤2 lines).
2. Append a structured fact to `memory/learned/facts/<topic-or-yyyy-mm>.md` for each project so future runs can dedupe.
3. Write an episodic log to `memory/learned/episodic/<stamp>-nightly-scan-<runId>.md` listing what you scanned, what you rejected and why, and the final picks.

## Don't

- Don't write to `core/`, `SOUL.md`, `agent.toml`, or `tasks/` — denied by the FS guard.
- Don't recommend the same project twice in a 30-day window. Check `learned/facts/` for prior entries.
- Don't pad with "exciting development" / "promising tool" filler. Cut everything that wouldn't change a reader's behavior.
