---
title: Run button on commands
description: Run a one-line shell command from an agent's reply with one click, and let the agent read how it went.
sidebar:
  order: 14
---

When an agent gives you a shell command, it can put it in a code block with a **Run** button. You choose Run, ZumiBot runs the command, and when it ends the agent gets the command and its output and carries on. It is the quick way to hand a command back to the agent when it could not, or should not, run that command itself, such as a `git push`.

## Run a command

1. Find a block that holds one line of shell, such as `npm run build`. Point at it, or on a phone look at its right end: a play button sits beside Copy.
2. Choose **Run**. Nothing asks for approval: your click is the decision. The command runs on the server, in the chat's folder, as a [background process](/projects/background-processes/).
3. Watch the status that appears beside the button. It reads "Running" and then how it ended, for example "Exited (code 0)". Choose the status to open the command's output in the side panel.
4. When the command ends, the agent gets one message with the command, what it printed and how it ended, and it answers. You do not see that message as something you wrote: the chat shows only the agent's answer.

Choose Run again to start a new run of the same block. The status always shows the latest run.

## Which blocks get a button

- Only a block tagged as shell (`bash`, `sh`, `shell` or `zsh`) that holds exactly one line. A block with several lines has Copy only.
- Only in a finished reply from an agent, not while it is still typing. Messages you wrote, side questions, the island, archived chats and chats another agent started with a question have no button.
- Not for a remote agent's replies. A command from another machine's agent never runs on this one.

A long command wraps onto more lines in its block instead of running off the side, so you can read all of it before you choose Run.

If the command holds characters you cannot see on screen, ZumiBot first shows the command with those characters spelled out and asks "Run this command?". Choose **Run** to go on, or **Cancel**.

## What to know

- **It runs where the server runs.** On a server, that is the server, not your own computer. In Local mode, it is your computer.
- **There is no keyboard.** The command cannot ask you anything. A command that needs a password or a yes/no answer, such as `sudo`, fails. Run those in your own terminal.
- **Stop it from the panel.** Open the status, then choose **Stop**. The agent still hears that you stopped it.
- **Limits are the same as for processes.** A chat can run 5 at once, and a command has a time limit.
- **It is in the audit log.** Each run is recorded as "Run by you", with the command, so you can see later what ran. See [Audit log and isolation](/safety/audit-and-isolation/).
- **The agent gets the end of the output.** A very long output is cut to its last part, and the message says so.
- **Some endings send nothing.** If the chat is archived or deleted, or the server restarts, the agent is not told about that run. If you restart the command from the panel, the run it replaced sends nothing, and the restarted run tells the agent when it ends.
- **A paused chat waits.** If the chat is paused, the result waits too, and it does not resume the chat.
- **A usage limit wait goes first.** If the chat is waiting for a usage limit to reset, the result waits too: the chat continues first, then the agent gets the result.

## Related

- [Background processes](/projects/background-processes/)
- [Approvals, questions and plans](/chatting/approvals-questions-plans/)
- [Pause and Resume](/chatting/pause-resume/)
- [Audit log and isolation](/safety/audit-and-isolation/)
