# ZumiBot Server — session handoff

Updated 2026-10-25 at the end of session 2. Read this first, then the spec, the plan and the ledger.

- Spec (approved): `docs/superpowers/specs/2026-10-25-zumibot-server-design.md`
- Plan (approved, 14 tasks): `docs/superpowers/plans/2026-10-25-zumibot-server.md`
- Ledger (git-ignored, trust it over memory): `.superpowers/sdd/2026-10-25-zumibot-server/progress.md` — every Ruling, fix round, deferred minor and parked item.
- Old app (READ-ONLY source, never edit): `/home/mhdaljuboori/Developments/Desktop/ClaudeBot`
- Repo root: `/home/mhdaljuboori/Developments/AI/ZumiBot` (git on `master`, **no commits yet by the user's rule**; the user decides about commits)

## User rules that bind you
- Never `git commit` / `git add` unless the user explicitly says so.
- After any Playwright/Chrome/Electron run, kill every process it started (only yours; the user's installed ZumiBot and other sessions' browsers may be running).
- Stop and ask only for: installing the `.deb`, anything on the VPS, sudo, DNS, the real password and 2FA, and any irreversible or security-sensitive action.

## Where the work stands
- Tasks 1–13 are **complete and reviewed**, plus a final whole-branch review and one fix wave (all clean; residual minors parked in the ledger).
- State: 90 test files / 1127 tests pass; `npm run typecheck` exit 0; e2e suites green (`e2e:auth`, `e2e:resilience`, `e2e`, `e2e:zumi-bot`, `e2e:group`, desktop `npm run e2e -w zumibot` on the packaged layout).
- `.deb` built after the fix wave: `zumi-bot-desktop/dist/ZumiBot_1.0.0_amd64.deb` (Package `zumibot`, Version `1.0.0`). Rebuild with `npm run dist -w zumibot` after any change.

## What is left (needs the user)
1. **Task 12 Step 4 — install the `.deb`** over the installed ZumiBot 0.13.0. Quit the old app first: both use `~/.config/ZumiBot`, so a running old app holds the single-instance lock and the new one quits silently. Then `sudo apt install ./zumi-bot-desktop/dist/ZumiBot_1.0.0_amd64.deb`, launch, pick Local, confirm the real chats appear (the first start copies them from `~/.config/ZumiBot` into `~/.local/share/zumibot`; the source is never changed).
2. **Task 14 — first deploy** (`task-14-brief.md` in the ledger folder): ask for `VPS_HOST` / `VPS_USER`, write `zumi-bot-server/deploy/deploy.env`, check the VPS, walk `zumi-bot-server/deploy/SETUP-VPS.md` asking before each sudo step and pausing for each **(you)** step, then the curl checks and the hand tests (real TTY password prompt, `setup-2fa` QR + recovery codes).
3. **Commits**: the user decides.

## Escape hatches worth knowing
- Desktop shell: `Ctrl+Shift+S` or `zumibot --switch-server` reopens the server picker (e.g. after a wrong VPS URL).
- A first deploy ends with a failed health check until `set-password` and `setup-2fa` are done (runbook step 10); that is expected.
