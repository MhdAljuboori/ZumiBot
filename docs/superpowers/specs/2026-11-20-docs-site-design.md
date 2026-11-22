# ZumiBot documentation site (docs.zumibot.run): design

Date: 2026-11-20. Status: draft for the owner's approval.

## Intent

A public documentation site at `https://docs.zumibot.run` that teaches end users everything about ZumiBot, in order:
from installing it to the most advanced features in the app. Today a user has the showcase at `zumibot.run` (what
ZumiBot is, downloads, the server install steps) and the repo README, which is private and mixes user steps with
developer steps. Nothing explains how to use the app's features. The docs fill that gap.

## Readers

People who use ZumiBot, not people who change its code. There is no hosted ZumiBot: every reader runs their own copy,
either the desktop app (Local mode) or a server on a host of their own, reached from a browser or a phone. Readers
already use Claude Code (ZumiBot runs the `claude` CLI and reads `~/.claude/agents`), so terminal basics are fine;
how ZumiBot works inside is not.

## Goals

- Cover every user-facing feature, ordered from first install to the most advanced (approved sidebar below).
- Every feature page answers: what it is for, how to use it (steps and screenshots), tips and limits.
- Full-text search across all pages.
- Same brand as `zumibot.run`, so the two read as one product.
- Docs stay current: a change that alters what users see updates its docs page in the same change.

## Non-goals (for now)

- Developer docs: code layout, RPC, tests, release and sync scripts. Those stay in `docs/architecture/`.
- Translations, versioned docs (one version: the current one), a blog.
- Feedback widgets, comments, analytics, AI chat over the docs.
- In-app links from ZumiBot to the docs (a later change; the docs URLs should be stable enough to allow it).

## Anti-goals (a failure even if the site works)

- Leaking anything private: the GitHub repo or its URLs, the private release, the author's own server domains
  (`zumibot-server.mhdaljuboori.me`, `zumibot.mhdaljuboori.me`), internal file paths or module names, secrets.
- Describing internals instead of use: file names, RPC methods, races, implementation phases.
- A command or step that fails for a reader (for example one that needs access to the private repo).
- Screenshots that no longer match the app.
- Third-party scripts, fonts or trackers loaded at view time.

## Constraints

- Monorepo with npm workspaces; dependencies pinned to exact versions; every workspace shares one version number
  (`bump:*` runs `npm version --workspaces`, so a new workspace joins automatically).
- The repo is private. The showcase never links to the source or the private release; the docs follow the same rule.
- Hosting is Vercel, as for `zumi-bot-site` (Root Directory per project, `vercel.json` steps up to the repo root
  for the workspace install and build).
- Astro 7.4.13 requires Node `>=22.23.4`. Vercel's `22.x` meets it; the owner's machine has 22.23.3 and needs a
  Node patch update to build locally.
- Root `CLAUDE.md` must stay under 16 KB (`repoDocs.test.ts`); every folder `CLAUDE.md` must name an existing
  `docs/architecture/*.md` (same test).
- DNS changes and anything on the VPS are the owner's to do (repo rule: ask first).
- Desktop platforms differ. Linux is the only build run as an app so far. On Windows the app is server-only: Local
  mode is off (`LOCAL_UNSUPPORTED`), and it connects to a server elsewhere. The macOS build is offered on
  `zumibot.run`, but its port (install doc, Phase 4) is not built: the island never shows (`setShape` has no macOS
  guard), "Start at login" does nothing, and the `claude` lookup runs bash, so a PATH set only in zsh is missed.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | **Astro Starlight**: a docs framework, Markdown/MDX pages built to static HTML | Sidebar, prev/next, dark mode, mobile menu, Pagefind search (static, self-hosted), tabs/steps/aside components all built in; theme via CSS variables. Cost: a new framework (Astro) in the repo, and the local Node update above. |
| B | VitePress | Similar features and built-in search, but Vue in a React repo, and its default look is Vue's docs; branding takes more work. No gain over A. |
| C | Custom, on the site's Vite + React stack | Same tools as `zumibot.run`, full control, but sidebar, routing, search, mobile nav and pre-rendering all hand-built: weeks of plumbing before any writing. |

Dropped early: Docusaurus (heavier, slower, no gain over A); hosted services such as GitBook or Mintlify (content
leaves the owner's hands, paid).

The owner picked A. The work is about 65 pages of writing; Starlight does the site part well and leaves the time for
the content.

## Decided by the owner

- Audience: end users.
- Scope: everything, from install to the most advanced feature.
- The sidebar structure below, the page shape, the content-source rule, the brand match and search.
- Starlight.
- **macOS is fixed first.** The macOS port (install doc, Phase 4) lands before the docs go live; the macOS pages
  are written after it lands and describe macOS as fully supported.
- **Docker works for the public first.** A ready-made image is published so the Docker install no longer needs the
  private repo; the server page gets a Docker tab once it exists, and the docs do not go live before it.
- **Jev is public.** Its page is written in full, including how a user gets a key.

## Prerequisites (separate projects)

Each is its own project with its own design, built apart from the docs site:

1. **macOS desktop port**: the install doc's Phase 4 (island guard, Start at login, `claude` lookup through the
   user's login shell, mac signing and e2e). Done when the Mac build runs as an app with the same features as Linux.
2. **Public Docker install**: a ready-made image in a container registry, built and pushed by the release workflow,
   and a `docker/install.sh` (published on `zumibot.run`) that pulls it instead of GitHub's source archive. Done when
   a machine with no GitHub access installs and updates ZumiBot with Docker.

The docs work starts now, in parallel with both *(my call)*: everything except the macOS pages and the Docker tab can
be written today. Go-live on `docs.zumibot.run` waits for both prerequisites and their pages.

## Design

### Workspace and hosting

- New workspace `zumi-bot-docs` (package `@zumibot/docs`), added to the root `workspaces` list and, if it has unit
  tests, to the root `vitest.config.mts` projects.
- Dependencies `astro` and `@astrojs/starlight` at exact versions (7.4.13 and 0.43.1 as of this writing; take the
  latest when building and pin them exactly), plus `@fontsource-variable/bricolage-grotesque` at the site's version.
- `engines.node`: `22.x` (as the site), which Vercel reads.
- A second Vercel project, Root Directory `zumi-bot-docs`, with its own `vercel.json` modelled on the site's: install
  and build from the repo root (`cd ..`), static output, the same security headers. The CSP stays as strict as the
  site's, loosened only where Starlight needs it (same-origin fetches for Pagefind's index, and whatever its inline
  theme script needs, preferably by hash). No third-party origin anywhere.
- Domain `docs.zumibot.run`: the owner adds it to the Vercel project and DNS. Deploys on every push to `main`
  (Vercel's Git integration), so wording fixes go live without a release. *(My call: releases are frequent, so the
  gap between `main` and the latest release stays small.)*
- `zumibot.run` gets a "Docs" link in its header and footer (a small change in `zumi-bot-site`).

### Look

- Starlight's theme variables set from the site's colors (`zumi-bot-site/src/styles.css`, which mirrors the app's
  `tokens.css`): background, text, accent, borders, code, links, in light and dark.
- Logo: the Zumi Z from the app's `frontend/src/botShapes.ts`, as on the site. Favicon from the site's `public/`.
- Font: Bricolage Grotesque, self-hosted through `@fontsource-variable`, as the site does.
- Light and dark follow the system, with Starlight's own toggle.

### Sidebar (approved)

```
├─ Get started
│   What is ZumiBot · What you need (Claude Code, agents)
│   Install the desktop app (macOS · Windows · Linux)
│   Install on a server (Docker · installer · domain & HTTPS)
│   First-run setup (password, 2FA, recovery codes) · Your first chat · Use it on your phone
├─ Chatting
│   Chats & composer · Attachments · Approvals, questions & plans
│   Mode, effort & model · Slash commands · /btw side questions · Thinking
│   Context, compact & keep warm · Edit, resend & fork · Pause & resume
│   Usage-limit waits · Search, unread & archive · Export
├─ Agents
│   Agent Studio · Memory & remembered approvals
│   Servers, plugins, skills & hooks · Zumi Bot assistant
├─ Group rooms
│   Rooms & moderator · Clone a room · Agent asks · Dispatched agents
├─ Projects & code
│   Files panel & restore · Git & worktrees · To-dos & task board
│   Review loop · Background processes
├─ Automation
│   Routines · Workflows (canvas, steps, triggers) · Saved history · Inbox
├─ Voice                Dictation · Voice requests
├─ Connect              Notifications · Telegram & Slack · Connectors
├─ Agents at the computer   Browser · Computer use
├─ Safety & cost        Vault · Spend caps · Usage & cost · Audit log & isolation
├─ Advanced engines     Codex agents · ACP & AG-UI · Jev
├─ Desktop app          Local vs server · Island & tray · Sync · Updates
└─ Run your server      Updates · Data folder & backups · Admin commands
                        Troubleshooting · FAQ · Changelog
```

A sidebar item may become more than one page where the topic is large (Workflows is the likely one); the groups and
their order stay. Slugs follow the titles (`/get-started/install-desktop/`, `/automation/workflows/`) and, once
published, do not change, so later in-app links can rely on them.

### Page shape

Every feature page, in this order:

1. **What it's for**: one or two sentences.
2. **How to use it**: numbered steps, with screenshots where the UI is involved.
3. **Tips and limits**: what it does not do, what to watch for.
4. **Related**: links to neighbouring pages.

Install pages use tabs per system (macOS, Windows, Linux) and Starlight's steps component. Settings named on a page are
named exactly as the UI labels them.

### Writing

- Plain, second person, short sentences; the tone of `CHANGELOG.md`'s entries. US spelling (as the changelog).
- Each page is written fresh from that area's `docs/architecture/` doc, then checked against the running app. Nothing
  is copied over: no file names, module names, internal paths, env vars meant for development, or test hooks.
- Only what ships in a release is documented. Half-built parts of a feature (sections an architecture doc marks
  as a later phase or "to verify") are left out, or named as not available yet.
- Examples use `zumibot.example.com`, never a real server of the owner's.
- Pages that need an outside account (Telegram, Slack, Connectors' claude.ai sign-in, GitHub for the review loop,
  Codex) are checked against the app with the repo's fakes; the steps on the other service's side (creating the bot,
  the Slack app, the token) follow that service's official docs and are marked for the owner to try live when
  reviewing that step's pages. *(My call.)*
- Windows: the desktop install page says plainly that on Windows the app connects to a server you run elsewhere,
  and links to "Install on a server". No WSL2 guide at launch: there is no tested WSL2 path. *(My call.)*
- Server install commands use the public `zumibot.run` installer (`https://zumibot.run/releases/latest/install.sh`),
  matching the site's "On a server" section.

### Screenshots

- Real screenshots of the app, in light and dark, shown to match the reader's theme.
- Made by script, not by hand, so they can be redone whenever the UI changes: extend the existing `npm run shot`
  harness (`zumi-bot-server/e2e/shot.mjs`: Local mode, fake `claude`, theme control, seeded data dir) into a
  `docs:shots` script driven by a list of named shots, each with its demo data and the clicks that reach its screen.
  Output goes into `zumi-bot-docs` and is committed.
- Demo data only: fixture agents, made-up chats; no real names, paths or keys.

### Generated and checked content

- **Changelog page**: built from the root `CHANGELOG.md` at build time, without the file's intro paragraph (it
  speaks of GitHub release notes). The v0.1.0 entry names the owner's old server domain and the ClaudeBot migration,
  which only the owner went through: that entry is edited once in `CHANGELOG.md` to drop both, and from then on the
  file is treated as public, so the leak test also runs on it. *(My call.)*
- **Install commands**: a unit test checks the server install page shows the same commands as the site's
  `installSteps(EXAMPLE_ORIGIN)` (`zumi-bot-site/src/serverInstall.ts`), so the two never drift.
- **Leak check**: a unit test fails if any page contains a forbidden string: `github.com/MhdAljuboori`,
  `raw.githubusercontent.com`, `mhdaljuboori.me`, `zumi-bot-server/`, `docs/architecture`, or a source path such as
  `src/<name>.ts` or `.tsx`.
- **Links**: every internal link resolves (a Starlight link-validation plugin or an equivalent test).

### Upkeep in the repo

- New `docs/architecture/user-docs.md`: how the docs site builds and deploys, the screenshot script, the writing rules
  and the leak list above. Index line in root `CLAUDE.md`'s "Docs by area"; `zumi-bot-docs/CLAUDE.md` points to it.
- Root `CLAUDE.md` gains one rule (a single line, within the 16 KB cap): a change that alters what users see updates
  its page under `zumi-bot-docs` in the same change, and redoes its screenshots when the screen changed.

### Order of work

Each step ends in a deployable site on the Vercel project's own URL, which the owner reviews before the next.
*(My call.)*

1. Workspace, Starlight, brand, search, Vercel config, the tests above, the screenshot script, and **Get started**
   for Linux, Windows and the `zumibot.run` installer.
2. Chatting, Agents, Group rooms.
3. Projects & code, Automation.
4. Voice, Connect, Agents at the computer, Safety & cost, Advanced engines, Desktop app, Run your server (with FAQ and
   Changelog).
5. When each prerequisite lands: the macOS pages (install, Desktop app section) and the Docker tab and its update and
   backup steps. Then the owner points `docs.zumibot.run` at the project and the docs go live.

## Left to the builder

- Exact Starlight config, component choices, slugs within the rule above, and how light/dark screenshots are swapped.
- The exact CSP, as long as no third-party origin is allowed.
- The screenshot list format and harness changes; image format and size.
- Whether a large sidebar item splits into several pages.
- Wording of every page, within the writing rules.
