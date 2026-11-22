---
title: What you need
description: ZumiBot needs Claude Code, installed and signed in, plus the agents you keep in your Claude folder. Here is the full list, and which systems are supported.
sidebar:
  order: 2
---

ZumiBot is a window onto Claude Code, so it needs very little of its own. Check this list once, before you install.

## Claude Code, signed in

ZumiBot runs the `claude` command for every reply. It does not sign in for you, and outside Docker it does not bring its own copy.

1. Install Claude Code on the machine where ZumiBot will run, by following [Anthropic's Claude Code setup guide](https://code.claude.com/docs/en/overview).
2. Run `claude` once in a terminal and sign in.
3. Keep Claude Code up to date, because ZumiBot talks to it through its command line.

"The machine where ZumiBot runs" depends on how you use it:

- **Desktop app in Local mode:** your own computer.
- **A server:** the server, signed in as the same user that runs ZumiBot there.
- **A server in Docker:** the container. The image brings its own Claude Code, which changes only when you update ZumiBot. You sign it in once, inside the container, as [Install on a server](/get-started/install-server/) shows. A sign-in on the host does not carry over.

If ZumiBot cannot find `claude`, the app shows a banner that says "Claude CLI not found." Type the full path to the command into the box and choose **Save**.

The [first-run setup](/get-started/first-run-setup/) on a server also checks this for you, in its last step.

## Agents

An agent is a Markdown file in the `~/.claude/agents` folder. It has a name, a one-line description and instructions. ZumiBot lists the files in that folder and watches it, so a new file shows up in the sidebar without a restart.

```markdown
---
name: code-reviewer
description: Reviews a change for bugs, unclear code and missing tests.
---
You review code changes. Point out real bugs first, then unclear code and
missing tests. Quote the line and suggest a fix.
```

You do not need an agent to start. ZumiBot always has **Zumi Bot**, its built-in assistant, and it can create agents for you. To make one yourself, choose the + button at the top of the sidebar, then **New agent**.

On a server, the agents folder is the one on the server, not on your computer.

## Supported systems

- **Linux**
  - Desktop app: yes. Use the `.deb` package on Debian and Ubuntu, or an AppImage on other distributions. Tested on Ubuntu.
  - Server: yes. The native install needs systemd and Node.js 22 or newer. The Docker install needs Docker with its compose plugin, version 2.17 or newer.
- **macOS**
  - Desktop app: yes, as a preview, on Apple silicon or Intel. Local mode runs the server on your Mac, with Claude Code installed. Computer use and the agent browser are not available there. See [Install the desktop app](/get-started/install-desktop/).
  - Server: yes, with the Docker install, on Apple silicon or Intel. It needs Docker Desktop, OrbStack or Colima. The Docker install is a preview.
- **Windows**
  - Desktop app: yes. Local mode runs the server on your computer, with Git for Windows and Claude Code installed. Computer use and the agent browser are not available there. See [Run ZumiBot on your computer](/get-started/run-locally/).
  - Server: use the desktop app in Local mode, or run a server in WSL2 or Docker, which are Linux.
- **Phone or tablet**
  - There is no phone app. Open your server in the browser and add it to the home screen.

You open a server from any current browser, on any system. It does not matter what the browser runs on.

## A server also needs

- A way to reach it. The native install needs a domain name that points at the server. The Docker install can use a domain, Tailscale or an SSH tunnel.
- HTTPS in front of ZumiBot. ZumiBot only listens on its own machine, so HTTPS is the only way in. On a native install you put Caddy or nginx in front of it. The Docker install brings its own. The [install steps](/get-started/install-server/) show both.
- Memory to spare. A group room starts several Claude Code processes at once. If the server has less than 2 GB, add swap.

## Related

- [What is ZumiBot](/get-started/what-is-zumibot/)
- [Install the desktop app](/get-started/install-desktop/)
- [Install on a server](/get-started/install-server/)
- [Troubleshooting](/server/troubleshooting/)
