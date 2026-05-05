# Memory index — slack-pingpong

This template uses no persistent memory. The bi-directional flow it
demonstrates relies on session resume (handled by Verona's SessionStore +
`claude -p --resume`), not on memory writes.

When you copy this template to build a real agent, this is where you'd list
the `memory/learned/` files the agent reads at task start.
