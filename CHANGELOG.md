# Changelog

What changed in each ZumiBot release, newest first. The release notes on GitHub come from here.

## v0.1.3 — 2026-11-26

- While an agent replies, Enter now sends your message into the reply that is running: the agent reads it at its next step and carries on with it, without stopping. Ctrl+Enter (Cmd+Enter on a Mac), or holding Send, lines it up in the Tasks list for after the reply, as Enter did before. If the reply stops before the agent reads your message, it moves to the top of the Tasks list, so nothing is lost. This works in single chats with Claude agents; in group rooms and with other agents, a message sent while the agent works still joins the Tasks list.
- When an agent makes a git worktree of its own and works there, the git chip and the Changes panel follow it and show that worktree's branch and changes. Since start lists everything since the agent made its branch, so you still see its work after it commits.
- Suggested replies stay above the message box while you type your own answer, until you send. Choosing one sends only that choice and leaves what you typed, your files and your quote in the box.
- In the processes panel the dot is green only while a process runs, red when it failed and gray once it ended any other way, so a finished run no longer looks stuck.
- A forked group room now sits right under the room it came from, in the same section of the left column.
- On a phone, typing in the browser panel is smoother: tap a field to type in it, the page keeps that field in view above the keyboard, and Enter submits as usual.
- On a phone, dropdown menus no longer pop the keyboard open, and the status menu stays next to its button when the keyboard opens.
- On a phone or in a narrow window, the pickers under a new chat's message box stay on one row, and the agent shows only its icon there.
- docs.zumibot.run links now show a preview picture when you paste them in Slack, X, iMessage or LinkedIn.

## v0.1.2 — 2026-11-25

- One-line shell commands in an agent's reply get a Run button. Choose it and ZumiBot runs the command in the chat's folder; when it ends, the agent gets the command and its output and carries on. You can follow or stop each run in the processes panel, and every run is in the audit log.
- Suggested replies: when a reply asks you to choose or confirm, the choices show as buttons above the message box, with a line on what the agent did and the question it asks. A single likely answer, such as "Yes, commit it", waits in the empty message box: press Tab to use it. Switch them off in Settings › General.
- The slash menu now lists what the agent's own engine can run: Claude Code commands and skills for a Claude agent, Codex skills for a Codex agent.
- When Auto mode refuses a command that first changes into another folder, the Allow card can allow that folder too, so the agent may read it and change into it. Your home folder and folders near the top of the disk are never offered.
- In Agent Studio you can add a remembered rule by hand: the start of a Bash command, or a folder the agent may read and change into.
- When the only part of a refused command still blocked is one no rule can allow, such as python3 writing a file, the Allow card names that part instead of offering a button that would not help.
- A chat waiting for a usage limit to reset now continues first, before a background process wakes its agent.
- The expanded browser panel no longer slips under the sidebar and header, so its restore button and address stay in view.
- zumibot.run links now show a preview picture when you paste them in Slack, X, iMessage or LinkedIn.

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
