---
title: Turn X-ray
description: See one reply as a timeline, with every model request, tool call, subagent and approval wait, plus the tokens and cost of each step.
sidebar:
  order: 15
---

Turn X-ray shows one reply laid out on a time axis. You can see where the time went (the model thinking, tools running, or the agent waiting on you), which steps used the most tokens, how much came from the cache, and who allowed each tool call.

## Open it

1. Point at an agent's message. The buttons appear beside it.
2. Choose **Turn X-ray** (the icon with staggered bars). The side panel opens on that reply.
3. To see another reply, choose its **Turn X-ray** button. The panel switches to that reply.

You can open it on a reply that is still running. The timeline grows while you watch, and a card that is waiting on you shows how long it has waited so far.

## What it shows

The top of the panel sums up the reply:

- **Time**: how long the reply took, from start to finish.
- **Cost**: what the run reported it cost. Before the run reports a cost, this reads **Cost (est.)**, priced from each request's tokens.
- **Tokens**: every token the reply used, subagents included.
- **Cache**: the share of the prompt that was read from the cache. A high number means most of the context was reused, which is cheaper and faster.
- A bar that splits the time three ways: **Model** (the agent's own requests), **Tools** (tools and subagents running) and **Waiting on you** (any time a card was waiting for your answer).
- How many requests, tool calls, subagents and cards the reply had.

Under that, each step has its own row and bar on the same time axis:

- **A model request** shows the model, what it did ("Thought, 2 calls", "Wrote"), how long it took, its tokens in and out, its cache share and its price.
- **A tool call** sits under the request that asked for it. It shows the tool and what it ran, how long it took and who allowed it (for example "Allowed by mode" or "Approved by you"). A call that failed or never ran says so.
- **A card's wait** is drawn in a striped color over the start of its call's bar, with a label such as "Waited 6.0 s for your approval". Questions and plans show the same way.
- **A subagent** is an Agent call with an arrow. Choose the arrow to show its own requests and tool calls, indented under it.

## What to know

- **Some agents have no request rows.** Requests and tokens come from Claude Code's own session log. Codex, ACP and remote agents keep none here, so their X-ray shows the tool calls, waits and decisions only, and the panel says so.
- **Older cards have no wait time.** ZumiBot started keeping when a card was answered with this feature. A card answered before that reads "wait unknown".
- **Who allowed a call comes from the audit log.** If the audit log dropped that record (its size limit), or the reply ran on another machine, the decision is left out and the panel says so. See [Audit log and isolation](/safety/audit-and-isolation/).
- **Prices are estimates per step.** Each request is priced from the published price list. The total at the top is the exact cost the run reported, once it has one, so the two can differ a little.
- **A reply that was edited away is gone.** If you edit or resend a message, the old reply's X-ray is no longer available.

## Related

- [Usage and cost](/safety/usage-and-cost/)
- [Dispatched agents](/rooms/dispatched-agents/)
- [Approvals, questions and plans](/chatting/approvals-questions-plans/)
- [Audit log and isolation](/safety/audit-and-isolation/)
