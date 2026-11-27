---
title: FAQ
description: Short answers to common questions about installing ZumiBot, chatting, agents, automation, safety and cost, the desktop app and the license, each with a link to the page that explains it, how to support ZumiBot and how to reach us.
sidebar:
  order: 5
---

Each answer is short. Follow the link in it for the full steps and the limits.

## Install and setup

### Does ZumiBot include Claude Code?

No. ZumiBot runs the `claude` command for every reply. It does not bring its own copy and it does not sign you in, so install Claude Code and sign in on the machine that runs ZumiBot. See [What you need](/get-started/what-you-need/).

### Do I need a server?

No. The desktop app in Local mode runs the server on your own computer: on Linux or on Windows. See [Run ZumiBot on your computer](/get-started/run-locally/).

### Why does my server need HTTPS?

ZumiBot signs you in with a secure cookie, so there is no plain-HTTP mode. A proxy such as Caddy or nginx in front of ZumiBot adds HTTPS. See [Install on a server](/get-started/install-server/).

### Can I skip the authenticator?

No. ZumiBot does this on purpose, because a server is reachable from the internet. Nothing works without the setup code either. See [First-run setup](/get-started/first-run-setup/).

### I lost the setup code. What now?

The code exists only in the running server's memory. If the server restarts, it prints a new code and the old one stops working, so read the log again. See [First-run setup](/get-started/first-run-setup/) and [Troubleshooting](/server/troubleshooting/).

### I forgot my password, or I lost my phone. How do I get back in?

Run one command on the server to set a new password, and one to set up a new authenticator. See [Admin commands](/server/admin-commands/).

### Is there a phone app?

No. You open your server in the phone's browser and add it to the home screen, where it opens like an app. See [Use it on your phone](/get-started/phone/).

## Chatting

### Why is the message box grayed out?

Look at the banner at the top of the screen. "Claude CLI not found." means Claude Code is missing or not on the path. See [Chats and the message box](/chatting/chats-and-composer/).

### Can I make ZumiBot stop asking for approval?

There is no mode that skips every approval, and you cannot make one. For calls you trust, choose **Allow always for this agent** on the card, and take it back later in the agent's **Remembered approvals** card. See [Approvals, questions and plans](/chatting/approvals-questions-plans/).

### Which agents have no Edit, Resend, Fork, Pause, side questions or Compact?

ACP agents have none of them. Remote agents have no Pause, side questions or Compact, but Edit, Resend and Fork work. Claude Code and Codex agents have all of them. The table on the Codex page lists every feature for each kind. See [Codex agents](/engines/codex/).

### What does "Earlier session expired" mean?

When an agent cannot go back to an earlier point, for example because its old session is gone, the chat says "Earlier session expired. Continued in a new session using this chat's history as context." The agent still knows what was said. See [Edit, Resend and Fork](/chatting/edit-resend-fork/).

## Agents and rooms

### Why did my room stop by itself?

A room stops after 15 member turns with no message from you. Send anything to keep it going. See [Group rooms and the moderator](/rooms/rooms-and-moderator/).

### Which agents can join a room?

Claude Code, Codex and ACP agents can. A remote agent cannot, and the list shows "can't join" for it. The moderator always runs on Claude Code, so a room needs Claude Code installed. See [Codex agents](/engines/codex/) and [Group rooms and the moderator](/rooms/rooms-and-moderator/).

### Does an agent remember things between chats?

Only if you turn on its memory in Agent Studio. Then it saves short notes on its own, without asking, and you can read, edit and delete every one. See [Memory and remembered approvals](/agents/memory-and-approvals/).

### Can an agent run on Codex?

Yes, you choose that per agent in Agent Studio. Codex must be installed and signed in on the computer that runs your server. A Codex agent has no Plan mode, memory or computer use, and cannot use Sandboxed or Container isolation. See [Codex agents](/engines/codex/).

## Automation and connect

### Do workflows run while my computer is off?

It depends on where ZumiBot runs. In Local mode, a schedule, a watched folder or a webhook works only while ZumiBot is open. On a server, it keeps working when your computer is off. See [Workflow triggers](/automation/workflow-triggers/).

### Will a routine wait for my approval in the middle of the night?

Yes. A routine runs the agent as in any chat, so a tool that needs your approval waits for you. Plan for that when you schedule something while you sleep. See [Routines](/automation/routines/).

### Why do I get no notifications on my iPhone?

On an iPhone, notifications work only after you add ZumiBot to the Home Screen. Then choose **Enable** in **Settings**, **Notifications**. See [Notifications](/connect/notifications/).

### Can I use the Telegram bot in a group?

No. Telegram works in direct messages only. The bot ignores groups, supergroups and channels, even from you. See [Telegram and Slack](/connect/telegram-and-slack/).

## Safety and cost

### Can an agent get at my Vault secrets?

An agent can use an item without being sent the secret. But the Vault is a speed bump against a determined agent, not a wall, because agents run as the same computer user as the server. Isolation closes that gap for an agent you choose. See [Vault](/safety/vault/) and [Audit log and isolation](/safety/audit-and-isolation/).

### Can I limit how much an agent spends?

Yes. Set a daily spend cap for an agent in Agent Studio. A cap is checked as the agent works, so a run can go a little past it. ACP and remote agents cannot have one. See [Spend caps](/safety/spend-caps/).

### Does Jev make an approval safe?

No. Jev is not a safety check, so do not rely on a "Low risk" line. Read what the agent wants to do. See [Jev](/engines/jev/).

## Desktop and server

### Does closing the window stop my agents?

On Linux, closing the window does not quit ZumiBot. It keeps running in the system tray, so a Local server and your agents keep going. Choose **Quit** in the tray menu to stop it. See [Install the desktop app](/get-started/install-desktop/).

### Do I need to reinstall the desktop app to update?

Not for most updates. In Local mode the server updates from inside the app. Only the app window, the tray and the island change when you install a newer desktop app. See [Desktop app updates](/desktop/updates/).

### Are my chats safe when I update the server?

An update from the app keeps a copy of your data folder first. Right after an update, **Roll back** in **Settings**, **About** puts the earlier version and that copy back. See [Update your server](/server/updates/).

### What should I back up?

The data folder, Claude Code's folder and its settings file, and the vault key, which you keep on its own. Your agents' projects are not in any of them. See [Data folder and backups](/server/data-and-backups/).

### Can I move my Local chats to my server?

Yes, with Sync in the desktop app. It joins the chats and Claude data on both sides, and backs up what it replaces. See [Sync](/desktop/sync/).

## License and sponsoring

### Is ZumiBot free?

Yes. Anyone may use ZumiBot, change it and share it, at home or at work. Its license is MIT with the Commons Clause, and the one thing it rules out is selling ZumiBot, or a paid service, such as hosting, that is mostly ZumiBot itself. The full text is in the LICENSE file on [GitHub](https://github.com/MhdAljuboori/ZumiBot), and **Settings**, **About** names it too.

### How can I support ZumiBot?

Sponsor it on [zumibot.run/sponsor](https://zumibot.run/sponsor), which you also reach from **Sponsor ZumiBot** in **Settings**, **About** and in the desktop app's tray menu. A sponsorship is a gift: it buys no license, support plan or feature, and ZumiBot stays free either way. A star on GitHub, or a clear bug report, helps too.

## Contact

### How do I report a problem or ask a question?

Email [contact@zumibot.run](mailto:contact@zumibot.run), or open an issue on [GitHub](https://github.com/MhdAljuboori/ZumiBot). Say which version you run, which you find in **Settings**, **About**, and add what the log says. See [Troubleshooting](/server/troubleshooting/) first: most problems are there.

## Related

- [Troubleshooting](/server/troubleshooting/)
- [Admin commands](/server/admin-commands/)
- [What is ZumiBot](/get-started/what-is-zumibot/)
