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

**Per-agent staging.** When at least one skill is declared, the dispatcher symlinks each declared skill into `<agentDir>/.claude/skills/<name>` → `~/.verona/user/skills/<name>/`. The adapter passes `<agentDir>` to `claude -p` as the subprocess CWD so Claude Code treats `<cwd>/.claude/skills/` as project-local. **CWD must be stable per agent** — `claude -p` keys session history on CWD, so a per-spawn CWD would break `--resume` when an anchored Slack thread reply lands. The staging step prunes stale symlinks before writing fresh ones, so removing a skill from `agent.toml` takes effect on the next spawn.

**Sync.** Skills are part of the user content git repo at `~/.verona/user/`. `verona user push` ships them alongside agents and connectors; `verona user pull` (or the auto-sync job) pulls them onto the server. No separate sync path.

## Why on-demand, not always-on

The earlier design considered always injecting `SKILL.md` content into the system prompt. Rejected:

- Different agents use different skills; injecting all of them per spawn wastes context.
- Long skills (UX designer, UI designer) would dominate the system prompt.
- The Skill tool already gives us on-demand loading natively — duplicating it as plain text would skip auto-detection from descriptions.

The agent gets a one-line nudge in the framing block (`Available skills: copywriting, ui-designer`) plus the native description list at session start. SOUL.md or task prompts can still nudge explicitly ("draft via the copywriting skill") when auto-detection isn't enough.

## Why per-agent symlinks, not global or per-spawn

The earlier design considered maintaining `~/.claude/skills/` symlinks globally so every `claude -p` subprocess discovers every skill. Rejected — pollutes the user's interactive Claude Code, no per-agent scoping.

An intermediate design staged symlinks per-spawn in `<runDir>/.claude/skills/` and set CWD to runDir. Rejected because `claude -p` keys session history on CWD; a unique CWD per spawn made `--resume <id>` fail for anchored Slack threads (claude reported `No conversation found with session ID: …`), which then crashed the daemon. The per-agent dir gives clean scoping AND a stable CWD per agent, so session resume works.

## How it's enforced

1. `src/config/schema.ts` — kebab-case validation on each skill name.
2. `src/core/skill-loader.ts` — `resolveSkill()` errors with a pointing message if `<skillsDir>/<name>/SKILL.md` is missing.
3. `src/core/dispatcher.ts` — calls `stageSkills({ agentDir })` when `hasSkills`, sets `cwd: agentDir` on the adapter request, and adds `Skill` to `allowedTools` so `claude -p` permits the call non-interactively.
4. `src/adapters/claude-cli.ts` — passes `cwd` through to `spawn()` so Claude Code sees the project-local skills dir.
5. `tests/core/skill-loader.test.ts` — covers happy path, missing skill, idempotent staging.
6. `tests/core/dispatcher.test.ts` — `stages declared skills and sets cwd so claude -p discovers them` asserts the symlink target and adapter request shape.

## Failure mode if you break it

- **Skill not staged but declared** → agent calls `Skill('foo')`, Claude Code reports "skill not found", the run completes but without the guidance the skill was supposed to provide.
- **`Skill` missing from `allowedTools`** → the skill is staged and discovered (it shows in the available-skills list) but `claude -p` is non-interactive: a tool absent from `--allowedTools` is auto-denied with no prompt. The Skill call returns the denied action descriptor (`Execute skill: <name>`), and the agent typically proceeds without it. The dispatcher adds `Skill` whenever `hasSkills`; don't drop that.
- **cwd not set** → symlinks staged but Claude Code's project-skill discovery doesn't kick in. Symptom: skill descriptions don't appear in the worker's available-skills list.
- **Skill missing on the server but referenced in agent.toml** → spawn throws ConfigError before invoking the adapter. This is the correct behaviour; fix by running `verona user push` from the machine where the skill exists, then `verona user pull` (or wait for auto-sync) on the server.

## Don't re-do

- **Don't inject SKILL.md into the system prompt.** Considered as "simpler than wiring the Skill tool". Rejected — see "Why on-demand, not always-on" above.
- **Don't symlink into `~/.claude/skills/` globally.** Considered for auto-discovery without CWD plumbing. Rejected — see "Why per-agent symlinks" above.
- **Don't stage skills per-spawn in runDir with cwd=runDir.** Tried in 0.4.1; broke `--resume` because `claude -p` keys session history on CWD. Rolled back in 0.4.2 to per-agent staging with cwd=agentDir.
- **Don't build a `mcp__verona__skill__<name>` tool.** Considered for parity with connectors. Rejected — Claude Code's Skill mechanism already covers this; building a parallel MCP surface would skip native description auto-detection.

## Evidence

- Plan: `~/.claude/plans/just-had-this-convo-fizzy-breeze.md`
- Code: `src/core/skill-loader.ts`, `src/core/dispatcher.ts`, `src/adapters/claude-cli.ts`
- Tests: `tests/core/skill-loader.test.ts`, `tests/core/dispatcher.test.ts`

## Revisions

- 2026-05-12 — initial entry; first-class skills mechanism shipped in 0.4.1.
- 2026-05-12 — 0.4.2: moved staging from `<runDir>/.claude/skills/` to `<agentDir>/.claude/skills/`, cwd from runDir to agentDir. Fixes session-resume failure (`No conversation found with session ID: …`) that crashed the daemon on Slack thread replies.
- 2026-05-16 — dispatcher adds `Skill` to `allowedTools` when `hasSkills`. Without it, `claude -p` auto-denied every skill call non-interactively (surfaced as `Execute skill: <name>`); discovery worked but invocation never did.
