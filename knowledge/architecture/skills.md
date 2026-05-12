# Skills

## Why this matters

Agents need reusable expertise that isn't agent-specific identity (`SOUL.md`) and isn't agent-private knowledge (`memory/`). Writing style, code-review heuristics, design-system rules — these belong to a shared pool that multiple agents can pull from. Memory entries asking the agent to "write in this style" don't anchor mechanics tightly enough; the model defaults reassert themselves. A skill loaded via Claude Code's native Skill tool, with its description surfaced at session start, gives the agent something concrete to invoke when relevant.

## Invariant

**Canonical location.** Skills live at `~/.verona/user/skills/<name>/SKILL.md` — kebab-case names, one directory per skill. Sibling files (`references/`, `evals/`) are allowed; Claude Code's discovery only reads `SKILL.md`'s frontmatter for the description.

**Per-agent allowlist.** Each agent declares the skills it has access to in `agent.toml` under `[agent].skills`:

```toml
[agent]
name = "lead-generator"
skills = ["copywriting"]
```

The schema (`src/config/schema.ts` `AgentConfigSchema.agent.skills`) validates kebab-case names. Missing skills fail loudly at spawn time.

**Per-spawn staging.** When at least one skill is declared, the dispatcher creates a runDir at `<state>/runs/<runId>/` (the same one it would create for subscriptions), then symlinks each declared skill into `<runDir>/.claude/skills/<name>` → `~/.verona/user/skills/<name>/`. The adapter passes that runDir to `claude -p` as the subprocess CWD so Claude Code treats `<cwd>/.claude/skills/` as project-local.

**Sync.** Skills are part of the user content git repo at `~/.verona/user/`. `verona user push` ships them alongside agents and connectors; `verona user pull` (or the auto-sync job) pulls them onto the server. No separate sync path.

## Why on-demand, not always-on

The earlier design considered always injecting `SKILL.md` content into the system prompt. Rejected:

- Different agents use different skills; injecting all of them per spawn wastes context.
- Long skills (UX designer, UI designer) would dominate the system prompt.
- The Skill tool already gives us on-demand loading natively — duplicating it as plain text would skip auto-detection from descriptions.

The agent gets a one-line nudge in the framing block (`Available skills: copywriting, ui-designer`) plus the native description list at session start. SOUL.md or task prompts can still nudge explicitly ("draft via the copywriting skill") when auto-detection isn't enough.

## Why per-spawn symlinks, not global

The earlier design considered maintaining `~/.claude/skills/` symlinks globally so every `claude -p` subprocess discovers every skill. Rejected:

- Pollutes the user's interactive Claude Code with framework-managed entries.
- No per-agent scoping — every agent would see every skill.
- Race conditions if the daemon edits `~/.claude/skills/` while interactive claude is running.

Per-spawn project-local skills give clean scoping. The runDir is throwaway state, cleaned up like any other run scratch.

## How it's enforced

1. `src/config/schema.ts` — kebab-case validation on each skill name.
2. `src/core/skill-loader.ts` — `resolveSkill()` errors with a pointing message if `<skillsDir>/<name>/SKILL.md` is missing.
3. `src/core/dispatcher.ts` — creates runDir when `hasSubs || hasSkills`, calls `stageSkills()`, sets `cwd: runDir` on the adapter request.
4. `src/adapters/claude-cli.ts` — passes `cwd` through to `spawn()` so Claude Code sees the project-local skills dir.
5. `tests/core/skill-loader.test.ts` — covers happy path, missing skill, idempotent staging.
6. `tests/core/dispatcher.test.ts` — `stages declared skills and sets cwd so claude -p discovers them` asserts the symlink target and adapter request shape.

## Failure mode if you break it

- **Skill not staged but declared** → agent calls `Skill('foo')`, Claude Code reports "skill not found", the run completes but without the guidance the skill was supposed to provide.
- **cwd not set** → symlinks staged but Claude Code's project-skill discovery doesn't kick in. Symptom: skill descriptions don't appear in the worker's available-skills list.
- **Skill missing on the server but referenced in agent.toml** → spawn throws ConfigError before invoking the adapter. This is the correct behaviour; fix by running `verona user push` from the machine where the skill exists, then `verona user pull` (or wait for auto-sync) on the server.

## Don't re-do

- **Don't inject SKILL.md into the system prompt.** Considered as "simpler than wiring the Skill tool". Rejected — see "Why on-demand, not always-on" above.
- **Don't symlink into `~/.claude/skills/` globally.** Considered for auto-discovery without runDir/CWD plumbing. Rejected — see "Why per-spawn symlinks" above.
- **Don't build a `mcp__verona__skill__<name>` tool.** Considered for parity with connectors. Rejected — Claude Code's Skill mechanism already covers this; building a parallel MCP surface would skip native description auto-detection.

## Evidence

- Plan: `~/.claude/plans/just-had-this-convo-fizzy-breeze.md`
- Code: `src/core/skill-loader.ts`, `src/core/dispatcher.ts`, `src/adapters/claude-cli.ts`
- Tests: `tests/core/skill-loader.test.ts`, `tests/core/dispatcher.test.ts`

## Revisions

- 2026-05-12 — initial entry; first-class skills mechanism shipped.
