# Task: greet

Confirm Verona is alive. Output:

```
hello from <agent-name> at <ISO timestamp> — task: greet
```

Then write a one-paragraph episodic log entry to `memory/learned/episodic/` summarizing this run (current ISO timestamp, what fired you, anything notable). Use a filename like `<YYYY-MM-DD-HH-mm-ss>-greet-<runId>.md`.

Don't read other memory files. Don't write to `memory/core/`, `SOUL.md`, `agent.toml`, or `tasks/` — those are protected and the FS guard will deny you.
