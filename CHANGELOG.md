# Changelog

What changed in each ZumiBot release, newest first. The release notes on GitHub come from here.

## v0.1.1 — 2026-11-23

- When a card comment mentions an agent, the agent's chat now shows your comment with the card above it (its status, title and a link back to the card) instead of a long block of text. Full prompt still shows everything the agent read.
- A card comment now asks only the agents it is addressed to: "thanks @a" asks nobody, and "ask @b to check" leaves @b alone. The comment posts at once while ZumiBot picks who to ask.
- In group rooms, the Thinking line sits where the Working line does, so nothing jumps sideways between the two.
- On a phone, a workflow run's step header wraps, so a long step name keeps its own row and the step number and time never split.
- The routine editor's Save button, and Ctrl+S, stay off until you change something, as in the workflow editor.
- In the desktop app's island, agent icon tooltips are no longer cut off at the window edge.

## v0.1.0 — 2026-11-22

The first ZumiBot release.

- Chat with your Claude Code agents one at a time, or bring several into a group room where a moderator picks who answers next.
- Approve or deny each tool an agent wants to use, right in the chat, with plan, accept-edits and ask-every-time modes.
- Routines and workflows run agents on a schedule, from a webhook or by hand, with approvals, conditions and loops on a canvas.
- An encrypted vault for logins, cards and keys, filled into forms without sending the agent the password or card number.
- Voice requests, to-dos and cards, message search, chat export, usage and spend caps, and a files panel with restore.
- Pick one of 20 icon shapes and a color for each agent in Agent Studio.
- Use it from any browser through your server, on your phone, or with the desktop app for Linux, Windows and macOS (a preview for Apple silicon and Intel Macs). The desktop app runs ZumiBot right on your computer or connects to your server.
- Install it on your own server with the install script, or with Docker on Intel and ARM machines. The installer checks each release against its signature before anything runs.
- ZumiBot updates itself. It checks for new versions on its own, shows a notice when one is out, and Settings › About can install it and roll back.
- The website at zumibot.run offers the desktop app for your system and the steps to install ZumiBot on your own server, and docs.zumibot.run has guides for every part of the app.
