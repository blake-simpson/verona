# How to amend knowledge

## Why this matters

These docs are alive. They're read at the start of every session and they shape every decision a future agent (or human) makes. If they drift from reality, they become noise — worse, they actively mislead. The amendment discipline is what keeps them load-bearing.

## Invariant

1. **Amend in place.** Edit the body of the relevant entry to reflect the new truth. Don't append a dated paragraph at the top; don't add a "as of YYYY-MM-DD" caveat.
2. **One-line revisions footer.** Each entry ends with a `## Revisions` section. Add one line per amendment: `- YYYY-MM-DD — what changed`. Keep it short — git history is the audit trail.
3. **Per-topic amends.** If you need to amend three topics, edit three entries. Don't bundle.
4. **Keep entries ≤200 lines.** If an entry is growing, split into a sub-entry.
5. **Update the "Don't re-do" section when you reject an alternative.** That's how future-you avoids repeating today's experiments.

## When to add a new entry

A new entry is justified when:
- A new domain emerges (e.g. a new connector type with auth quirks).
- An existing entry would exceed 200 lines.
- Two entries are getting cross-references that would be cleaner as a third entry.

## When to delete an entry

- The thing it documents was removed entirely.
- The invariant is no longer load-bearing (e.g. a constraint that's now compile-checked).

Deleting is fine. Git remembers.

## What NOT to put here

- Code patterns derivable from the source.
- Step-by-step "how to do X" recipes (those go in README or CLI `--help`).
- Decision logs ("we decided X on date Y because..." — git commit messages have this).
- Anything that's already documented in `AGENTS.md`.

## Revisions

- 2026-05-02 — initial entry.
