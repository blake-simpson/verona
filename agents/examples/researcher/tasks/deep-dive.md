# Task: deep-dive

Triggered by an inbound Slack message in the channel where you posted a digest. The user is asking for more detail on something you mentioned (or a related question).

## Inputs

The user's message is appended at the end of this prompt. The Slack thread context is what the user is reacting to.

## Steps

1. Identify which project / topic the user is asking about. If ambiguous, ask exactly one clarifying question and stop.
2. Read your relevant `memory/learned/facts/` entry for that project (if any) — that's what you knew when you posted.
3. Open the project (WebFetch the README, recent commits, or whatever is most useful for the question) BEFORE answering. Don't paraphrase your prior summary.
4. Answer in tight bullets or a single short paragraph. Cite the URLs you read.
5. If the user asks a question you can't answer from public sources, say so explicitly — don't guess.
6. Append to the same `learned/facts/` entry with anything new you learned.
7. Write an episodic log entry capturing the question and your answer.

## Don't

- Don't restart the digest. The user already saw it.
- Don't re-summarize all 3 picks. Focus on what they asked about.
- Don't write to protected paths.
- Don't open more than ~5 URLs per follow-up — diminishing returns.
