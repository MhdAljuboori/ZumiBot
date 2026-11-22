# Sync button

## Intent

Expose the same two-way PC/VPS data sync as `npm run sync` through a Sync button in the account menu. The user wants it in desktop Local and VPS modes and in the browser, and has chosen the desktop app as the browser's local helper.

## Approaches

- Desktop helper (selected by the user): reuse the installed app's access to local files, SSH credentials, and the local server lifecycle.
- Separate background helper: allows syncing without the desktop app but adds another service to install and maintain.
- Local-browser-only support: smaller integration, but does not meet the requested VPS-browser support.

## Proposed behavior

- Show Sync in the account menu. In the desktop app it opens a sync progress view; in the browser it hands off to the installed desktop app using a registered `zumibot:` protocol. The browser explains that progress is shown in the desktop app.
- Browser handoffs open a native confirmation before starting. The protocol accepts only a fixed sync action, never commands, filesystem paths, or SSH parameters supplied by a page.
- Reuse the existing sync implementation and its backup, merge, exclusion, busy-check, and VPS restart behavior. Keep `npm run sync` working.
- Refuse to sync while replies are running locally or on the VPS. Protect unsaved editor changes using the existing save/discard/cancel flow. Temporarily stop an idle local server before syncing, then restore the previous connection on success or failure.
- Show progress and the final success or error, including backup locations. Allow only one sync at a time and prevent server switching or app shutdown from interrupting an active sync. Failure must leave a usable app with a clear way to retry.

## Configuration and packaging

Bundle the sync implementation with the desktop app so an installed `.deb` does not need a source checkout or system Node. Continue using the PC's existing SSH keys and installed `ssh`/`rsync` commands.

In development, use the existing `deploy.env`. For an installed app, offer a one-time native file picker to import the VPS host, user, and directory from that file into private desktop settings. Never package deployment configuration or SSH keys. Display the configured destination before starting sync so it is clear which VPS is affected.

## Scope and builder choices

The protocol handoff, account-menu placement, configuration import, and progress presentation are implementation proposals, not additional user requirements. Browser progress stays in the desktop helper; no browser-to-local HTTP service, cloud relay, automatic sync, or changes to merge semantics are planned. Browser profiles and runtimes remain excluded.

Verify orchestration with fake sync operations, configuration and protocol input handling, and success/failure restoration tests. Run the existing sync integration tests, relevant desktop/frontend checks, typechecking, and builds. Do not run a real PC/VPS sync during implementation.

## Approval

Approved by the user on 2026-10-29.
