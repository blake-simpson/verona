# Task: ping

> **Before this template runs**, replace `REPLACE_WITH_CHANNEL_ID` below with
> the same channel id you set in `agent.toml`'s `[connectors.slack].channel`.
> Both files need the literal value — the cron path doesn't (yet) auto-inject
> connector context, so the model needs the channel id in the prompt.

Call `mcp__verona__slack__send_message` exactly once with:

```json
{
  "channel": "REPLACE_WITH_CHANNEL_ID",
  "text": "ping from verona — reply in thread to test resume"
}
```

That's it. Don't post anything else. Don't write memory. Exit.

When the user replies in the thread, your session will resume — that's
covered by the SOUL plus the framework default reply directive (auto-injected
by Verona for any agent with connector subscriptions). No additional task
body is needed for the reply path.
