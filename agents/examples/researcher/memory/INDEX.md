# Memory index — researcher

Routing table for this agent's memory. Read this first; only open the linked entries when the current task points you to them.

## Core (read-only — human-curated)

_(none yet — add entries to `memory/core/` for hard rules: source allowlists, sites to never visit, your subscription preferences, etc.)_

## Learned (you curate this)

### Facts

When you discover a project worth tracking long-term, write a one-file summary in `memory/learned/facts/`:

- `tracked-projects/<project-name>.md` — repo URL, capability, when first seen, what changed since
- `<yyyy-mm>.md` — month-bucketed digests for short-lived references

Keep each file ≤100 lines. Split if growing.

### Episodic

`learned/episodic/` is your per-run log. The daemon writes one summary file per task run automatically (don't add your own). You may write additional notes if a run had unusual context worth surfacing later.

### Working

`learned/working/` is short-term scratch. Files older than 7 days are garbage-collected automatically.

## How to use this index

- For `nightly-scan` (cron): read `learned/facts/tracked-projects/` (if any) to dedupe before writing new findings.
- For thread replies (no separate task — you'll see the prior digest in the conversation): identify which project the user is asking about, then read `learned/facts/tracked-projects/<that-project>.md` BEFORE web-fetching. Don't paraphrase the digest you already posted — re-open the source.
