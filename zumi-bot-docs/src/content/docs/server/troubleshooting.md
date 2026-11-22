---
title: Troubleshooting
description: Fix the common problems on a ZumiBot server, from a page that will not open to an update that does not come back.
sidebar:
  order: 4
---

Start with the three checks below. They tell you whether the server is running and what it last said. Then find your problem in the list.

All commands run on the server, as the user that runs ZumiBot.

## Three checks

1. **Is the service running?**

   ```bash
   systemctl --user status zumibot --no-pager
   ```

   `active (running)` is good. `failed` or `inactive` means it is not running.

2. **What did it say?**

   ```bash
   journalctl --user -u zumibot -n 50 --no-pager
   ```

3. **Is the server answering?**

   ```bash
   ~/zumibot/bin/zumibot-server busy
   ```

   A number means yes. "No ZumiBot server is running." means no.

To start, stop or restart the service:

```bash
systemctl --user start zumibot
```

```bash
systemctl --user stop zumibot
```

```bash
systemctl --user restart zumibot
```

A restart ends any reply that is running. Check first with `busy`. See [Admin commands](/server/admin-commands/).

## The page does not open

- **The proxy cannot reach ZumiBot.** ZumiBot listens only on its own machine, on port 4317, and your HTTPS proxy is the only way in. If the browser shows an error from the proxy, such as "502 Bad Gateway", run the first check. If the service is not running, start it and read the log to see why it stopped.
- **The address is not the one you gave the installer.** ZumiBot checks that requests come from that address, so another name for the same server does not work. Use the address you typed after `--origin`. Signing in or sending a message may be refused from another name.
- **Another program holds the port.** If the log says port 4317 is already in use, stop the other program, then restart ZumiBot.
- **Chats load but nothing updates,** and the send button says "Reconnecting…". The proxy is not passing WebSocket connections through. The ready-made configs in `~/zumibot/proxy/` do. Another proxy must pass them to `127.0.0.1:4317`. See [Install on a server](/get-started/install-server/).
- **To move to a new address,** run `~/zumibot/bin/zumibot-update --origin https://zumibot.example.net`, using your own address. Then point your proxy at the new address. The installer writes fresh configs for it into `~/zumibot/proxy/`.

## The server stops when you log out

The service needs "lingering" to keep running after your last session ends. Check it:

```bash
loginctl show-user "$(id -un)" --property=Linger
```

If it says `Linger=no`, turn it on. It needs an admin:

```bash
sudo loginctl enable-linger "$(id -un)"
```

## Setup and sign-in

- **The setup code does not work, or you lost it.** The code lives only in the running server's memory. Restart the service, then read the log for the new one:

  ```bash
  systemctl --user restart zumibot
  ```

  ```bash
  journalctl --user -u zumibot -n 20 --no-pager
  ```

  The old code stops working. See [First-run setup](/get-started/first-run-setup/).
- **The 6-digit code is always refused.** The code depends on the clock. Check that the server's clock is right:

  ```bash
  timedatectl
  ```

  Look for "System clock synchronized: yes". Check your phone's clock too.
- **Too many wrong tries.** Repeated wrong guesses are slowed down, and then locked for a while. Wait, then try again.
- **You lost your password or your phone.** See [Admin commands](/server/admin-commands/).

## Claude Code is not found

If the app shows "Claude CLI not found.", or the setup page's last step says it cannot find `claude`, Claude Code is missing or not signed in for the user that runs ZumiBot. As that user, install it, run `claude` once, and sign in. If it still cannot find it, type the full path to the command in the box the banner shows and choose **Save**. See [What you need](/get-started/what-you-need/).

## Agents cannot use their tools

An agent on the server uses the servers, skills and plugins set up on the server, not the ones on your computer. An update does not copy them. Set them up on the server, in **Settings**, **Claude Code**. See [Servers, plugins, skills and hooks](/agents/extensions/).

## Updates

- **It says a reply is running.** The installer stops with "Wait for them, or re-run with --force to interrupt them." Wait for the replies to finish, or add `--force`.
- **It says it could not read the reply count.** Run the update again with `--force` to go on anyway.
- **It could not copy the data folder.** The update keeps a copy of your data first, so it needs free space about the size of the folder. Nothing was updated. Free some space and try again. See [Data folder and backups](/server/data-and-backups/).

  ```bash
  df -h ~
  ```

- **It does not come back.** After about 90 seconds the updating screen says what to do. Read the log, then roll back, but only if the update kept a data copy. A plain `zumibot-update` keeps none. See [Update your server](/server/updates/).
- **The old page is still there after an update.** Reload the tab. ZumiBot says "ZumiBot was updated. Reload to use v0.1.2." with a **Reload** button, and never reloads by itself.
- **About says "Updates need the installer install".** This server was not set up with the installer, so the app cannot update it.

## Not enough memory

A group room starts several Claude Code processes at once. Check the memory:

```bash
free -m
```

With less than 2 GB, add swap. Agents' browsers and desktops use memory too. See [What you need](/get-started/what-you-need/).

## The desktop app

- **It cannot reach the server.** The app shows "Can't reach the server." with **Retry** and **Switch server**. Check that the server answers, then choose **Retry**. See [Local mode and server mode](/desktop/local-vs-server/).
- **Sync ends with "The chats are in place on the VPS, but restarting it failed. On the VPS run: systemctl --user status zumibot".** Your chats were copied, but the server did not restart. On the server, run the first check above and the lingering check, then start the service. See [Sync](/desktop/sync/).
- **Sync ends with "The VPS server did not answer within 20 s after the restart. On the VPS run: journalctl --user -u zumibot -n 50".** The server restarted but was not ready in time. On the server, read the log with that command. If the service is running, give it a moment and check again with `busy`.
- **A new desktop app does nothing when you open it.** An old copy may still be running. Quit it fully, with **Quit** in the tray menu, then open it again.

## Tips and limits

- **Look at the log first.** Most problems say what is wrong there.
- **Change one thing at a time,** and check again after each.
- **Keep the update copies** until you are sure the new version works. See [Data folder and backups](/server/data-and-backups/).
- **Still stuck?** Email [contact@zumibot.run](mailto:contact@zumibot.run) or open an issue on [GitHub](https://github.com/MhdAljuboori/ZumiBot), with your version from **Settings**, **About** and what the log says.

## Related

- [Install on a server](/get-started/install-server/)
- [Update your server](/server/updates/)
- [Admin commands](/server/admin-commands/)
- [FAQ](/server/faq/)
