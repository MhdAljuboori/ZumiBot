---
title: Admin commands
description: Commands you run in a terminal on your server, to check what is running, reset a lost password, set up a new authenticator, and check the optional browser and desktop.
sidebar:
  order: 3
---

Almost everything in ZumiBot happens in the app. A few jobs need a terminal on the server: getting back in after a lost password or phone, and checking what is running before you restart. This page lists those commands.

## Before you run one

Run every command on the server, as the user that runs ZumiBot. The installer put the command here:

```bash
~/zumibot/bin/zumibot-server --help
```

It prints one line that lists the commands.

- **Use that command, and your own user.** Do not run it with `sudo` or as root. It may look for the data folder in root's home and find nothing of yours.
- **The server may keep running.** A change from `set-password` or `setup-2fa` applies at once, and signs everyone out.
- **Never paste a password, a code or an authenticator secret into a chat or a ticket.** The examples here are placeholders.

| Command | What it does |
| --- | --- |
| `busy` | Prints how many replies are running right now |
| `processes` | Prints how many background processes are running right now |
| `set-password` | Sets a new password |
| `setup-2fa` | Sets up a new authenticator and a new set of recovery codes |
| `browser-install`, `browser-check` | Download and check the agent's browser |
| `desktop-check` | Checks the programs an agent desktop needs |
| `serve` | Runs the server. The service already does this |

## Check what is running

Run these before you restart the server, or after a rollback:

```bash
~/zumibot/bin/zumibot-server busy
```

```bash
~/zumibot/bin/zumibot-server processes
```

Each prints one number. `0` means nothing is running. If the server is not running, the command says "No ZumiBot server is running." A restart or an update ends running replies and stops [background processes](/projects/background-processes/).

## Reset a lost password

Use this when you forgot your password, or when you mistyped it during setup. You do not need the old one. You need a terminal on the server.

1. Run the command:

   ```bash
   ~/zumibot/bin/zumibot-server set-password
   ```

2. Type the new password at "New password:". Nothing shows as you type. Use at least 16 characters.
3. Type it again at "Repeat password:".
4. When it says "Password saved. Every signed-in session was signed out.", sign in with the new password and your authenticator code.

It stops with "Use at least 16 characters." or "The two passwords do not match." if the password does not fit, and saves nothing.

To have ZumiBot choose a password for you, add `--generate`:

```bash
~/zumibot/bin/zumibot-server set-password --generate
```

It prints the new password once, after the line "Your new password (shown once, store it now):". Store it in a password manager before you close the terminal. It cannot show it again.

This changes the password only. Your authenticator and recovery codes stay as they are.

## Set up a new authenticator

Use this when you lost your phone and your recovery codes, or when you did not save the codes. It replaces the authenticator you have now. The old authenticator and every old recovery code stop working.

1. Run the command:

   ```bash
   ~/zumibot/bin/zumibot-server setup-2fa
   ```

2. Scan the QR code in the terminal with your authenticator app. If you cannot scan it, add the secret by hand from the line the command prints below the QR code. That line holds the secret itself, so keep it private.
3. Type the 6-digit code your app shows at "Enter the 6-digit code to confirm:". If it says "That code is not valid. Try the next one.", wait for the app's next code and type that.
4. When it says "Two-factor sign-in is on. Every signed-in session was signed out.", it prints ten recovery codes after "Store these somewhere safe. Each works once." Save them now. They are not shown again.

Nothing is saved until you type a valid code. To stop, press Ctrl+C.

If you lost your password too, run `set-password` first, then `setup-2fa`.

## Check the browser and the desktop

These two jobs are part of other features. Their pages give the full steps.

- `browser-install` downloads a copy of Chromium for the agent's browser, and `browser-check` tests it. See [The agent's browser](/computer/browser/).
- `desktop-check` lists the programs an agent desktop needs. It prints `found` and a path, or `missing` and a name, for each program, then the version of the tool the agent uses to click. It exits with an error status when anything is missing. It only looks. It installs nothing. See [Computer use](/computer/computer-use/).

## Tips and limits

- **These commands need no password,** because they act on the server's own files. That is why they only work for someone who can log in to the server as its user. Keep that access safe.
- **Resetting does not need the app.** `set-password` and `setup-2fa` work even when you cannot sign in.
- **The setup page is not a way in.** It cannot replace a password or authenticator that already exists. Use these commands instead. See [First-run setup](/get-started/first-run-setup/).
- **Do not run `serve` by hand.** The service runs the server, and only one server can use the data folder.
- **Recovery codes work once each.** On the sign-in page, choose "Use a recovery code" to enter one.

## Related

- [First-run setup](/get-started/first-run-setup/)
- [Update your server](/server/updates/)
- [Data folder and backups](/server/data-and-backups/)
- [Troubleshooting](/server/troubleshooting/)
