# Electron cloud build

`.github/workflows/electron-build.yml` ("Electron Cloud Build") builds the desktop shell's installers on GitHub-hosted
runners with the same `npm run build` and `zumi-bot-desktop/electron-builder.yml` used locally.

| Runner          | Output (in `zumi-bot-desktop/dist/`)                                  |
| --------------- | ----------------------------------------------------------------------- |
| `ubuntu-24.04`  | `ZumiBot_<version>_amd64.deb`, `ZumiBot_<version>_x86_64.AppImage`  |
| `windows-2025`  | `ZumiBot-Setup-<version>-x64.exe` (NSIS, per-user, folder can be changed) |
| `macos-15`      | `ZumiBot-<version>-arm64.dmg` (Apple silicon), `ZumiBot-<version>-x64.dmg` (Intel) |

Each platform is its own job (`fail-fast: false`), so one failing does not cancel the others. Builds are kept as Actions
artifacts for 1 day (a tag run also attaches them to the release). Windows builds are unsigned; macOS builds are ad-hoc signed (`-c.mac.identity=-` in the Package
step): no Developer ID, but a whole signature, without which an Apple silicon Mac reports the app as damaged and never
opens it. The macOS job then checks both apps (`codesign --verify --deep --strict`, the JIT entitlement, the microphone
usage string) and runs the Apple silicon one as Node, the way Local mode starts its server.

On a `v*` tag a last job, `publish`, attaches every installer that built to the release `release.yml` creates from the
same tag, with a `SHA256SUMS-desktop` list uploaded after them, then posts `VERCEL_DEPLOY_HOOK` so the showcase site
rebuilds and offers them for download (see the Desktop installers part of `docs/architecture/updates.md`). It is the
only job with `contents: write`, runs no npm code, and never creates a release: it waits up to 20 minutes for
`release.yml`'s, and fails if none appears. A manual run publishes nothing unless it was started on a tag.

Local workflows are unchanged: `npm run build:deb` still builds only the `.deb` (it names its target), and
`npm run e2e:desktop` still builds the unpacked Linux app.

## 1. Run a build by hand

1. Push the branch with the workflow to GitHub (the workflow must exist on the branch you pick).
2. Open the repository's **Actions** tab, then **Electron Cloud Build** in the left list.
3. Click **Run workflow**, pick the branch, and pick **platforms**: `all`, `linux`, `windows` or `macos`. Picking one
   platform skips the others before a runner starts, so they cost nothing.
4. Click **Run workflow**. The run shows one job per platform.

From a terminal with the GitHub CLI:

```bash
gh workflow run electron-build.yml --ref master -f platforms=all
```

```bash
gh run watch
```

## 2. Build from a version tag

A pushed tag starting with `v` builds all three platforms. The tag must match the workspace version, or every job stops
before building (the same check as `release.yml`):

```bash
npm run bump:patch
```

```bash
git commit -am "Bump to <version>"
```

```bash
git tag v<version> && git push origin v<version>
```

Plain commits and pull requests never start a build. A second run on the same ref cancels the one still running.

## 3. Download the installers

Open the finished run (Actions → Electron Cloud Build → the run). Under **Artifacts** at the bottom of the summary
page there is one zip per platform, named `ZumiBot-<version>-<platform>`. Unzip it to get the installers. Artifacts
expire after 1 day, so download a manual run's installers the same day.

With the GitHub CLI:

```bash
gh run download <run-id> --dir installers
```

## Limitations of unsigned installers

- **Windows**: SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**. Some antivirus tools
  flag unsigned NSIS installers.
- **macOS**: ad-hoc signed and not notarized, so Gatekeeper refuses the downloaded app ("Apple could not verify…").
  After copying the app to Applications, run `xattr -cr /Applications/ZumiBot.app`, or try to open it once and then
  choose **Open Anyway** in System Settings → Privacy & Security. Local mode's server updates still work (they are
  checked against the release key, not Apple's); the app itself has no auto-update.
- **Linux**: no signing is needed. The AppImage needs `chmod +x` and FUSE (`libfuse2t64` on Ubuntu 24.04).

## Platform support of the app itself

The shell was built and tried on Ubuntu 24.04 (GNOME, X11). The packaged macOS x64 build was run on an Intel Mac
(macOS 15); what was and was not tried there is in [Desktop shell](architecture/desktop-shell.md). Known gaps:

- **Windows Local mode runs the server natively** (named pipes, `taskkill` trees, Git Bash for hooks; see
  "Windows: native" in [Install and first-run setup](architecture/install.md)). A dev run (`npm run dev`) was tested on
  Windows 11; the packaged NSIS installer has not been run yet. `ZUMIBOT_LOCAL_WSL=1` still starts the server in WSL2
  ([Desktop shell](architecture/desktop-shell.md)). The user steps are the docs site's "Run ZumiBot on your computer" page.
- The dynamic island and the "no monitor" guard are written for Linux X11 first; macOS has its own click-through
  (see [Desktop shell](architecture/desktop-shell.md)). Start at login on macOS has not been tried at a real login.
- Sync needs `ssh` and `rsync` on `PATH`.
- Local mode needs the `claude` CLI installed on that machine, as on Linux.

## 4. Publishing

Publishing is on (see the top of this page): the `publish` job uploads with `gh release upload`, and electron-builder
itself still runs with `--publish never`. The steps below are the other way, electron-builder's own GitHub publisher,
kept for when auto-update needs its `latest*.yml` files. Switching means removing the `publish` job first, or the
installers are uploaded twice:

1. In `.github/workflows/electron-build.yml`, set `permissions: contents: write`.
2. In the Package step, add `GH_TOKEN: ${{ github.token }}` to `env`, and use `--publish always` on tag runs
   (keep `never` for manual runs), for example:
   `publish=$([ "$GITHUB_REF_TYPE" = tag ] && echo always || echo never)`.
3. Add to `zumi-bot-desktop/electron-builder.yml`:

   ```yaml
   publish:
     provider: github
     owner: MhdAljuboori
     repo: ZumiBot
     releaseType: release
   ```

   electron-builder uploads to the release named after the tag, creating a draft if it does not exist. Since
   `release.yml` creates that release with `gh release create`, either let electron-builder upload to the existing one
   or make `release.yml` wait for this workflow (`workflow_run`) to avoid a race.

Publishing also writes `latest*.yml` files, which `electron-updater` needs if auto-update is added later; that is a
separate change in the app.

## 5. Add code signing

electron-builder signs on its own once the right environment variables are present; no config change is required for
a basic setup. Add them as repository secrets (Settings → Secrets and variables → Actions) and pass them to the
Package step's `env`.

### Windows

1. Get a code-signing certificate (`.pfx`, OV or EV). EV certificates usually live on a hardware token or a cloud
   HSM (for example Azure Trusted Signing), which needs electron-builder's `win.azureSignOptions` or a custom `sign`
   script instead of a `.pfx`.
2. For a `.pfx`: `base64 -w0 cert.pfx`, store the output as secret `WIN_CSC_LINK`, the password as
   `WIN_CSC_KEY_PASSWORD`.
3. In the Package step:

   ```yaml
   env:
     WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
     WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
   ```

### macOS

1. Join the Apple Developer Program and create a **Developer ID Application** certificate. Export it with its key
   from Keychain Access as `.p12`.
2. Secrets: `MAC_CSC_LINK` (base64 of the `.p12`), `MAC_CSC_KEY_PASSWORD`, and for notarization `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` (made at appleid.apple.com) and `APPLE_TEAM_ID`.
3. Remove `-c.mac.identity=-` from the `macos` line of the Package step, and add to its `env`:

   ```yaml
   env:
     CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
     CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
     APPLE_ID: ${{ secrets.APPLE_ID }}
     APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
     APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
   ```

4. `hardenedRuntime` and `build/entitlements.mac.plist` are already set in `electron-builder.yml`. With the `APPLE_*`
   variables set, electron-builder notarizes after signing; then the site's `xattr` note can go.

Secrets are not given to workflows started from forks, so a fork's run stays unsigned.

## 6. Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| Every job fails at "Check the tag matches the package version" | The tag is not the workspace version. Run `npm run bump:*`, commit, delete and re-push the tag. |
| `npm ci` fails with "lock file out of sync" | `package-lock.json` was not updated. Run `npm install` (or `npm run bump:lock`) locally and commit it. |
| `Cannot find module` in `npm run build` | A dependency is only in another checkout's `node_modules`; add it to the right workspace's `package.json`. |
| `Error: Cannot find module '@rollup/rollup-…'` / `lightningcss…` on one OS | The lock file lacks that platform's optional package. Delete `node_modules` and `package-lock.json`, `npm install`, commit the lock file. |
| electron-builder: "Application entry file … does not exist" | The shell was not built. `npm run build` must run before packaging; check its log. |
| Linux: `fpm` or `deb` error about `zumibot-island.desktop` | The path in `deb.fpm` is relative to `zumi-bot-desktop/`; keep the file in `build/`. |
| macOS: "skipped macOS application code signing" | The `-c.mac.identity=-` flag is missing from the Package step; without it the app is unusable on Apple silicon. |
| macOS: "ad-hoc signing with hardenedRuntime enabled requires … disable-library-validation" | A generic warning; the entitlements file has that key. |
| Windows: hangs or fails in `rcedit` / `winCodeSign` download | A network hiccup fetching electron-builder's tools; re-run the job. The cache keeps them afterwards. |
| "No files were found with the provided path" at upload | Packaging wrote nothing (look at the Package step) or the artifact name pattern in `electron-builder.yml` changed. |
| Artifact upload fails with a storage quota error | Free storage is used up; delete old artifacts (below). |
| A run was cancelled on its own | A newer run started on the same branch or tag (`concurrency`). |

To reproduce a job locally (Linux): `npm ci && npm run build`, then in `zumi-bot-desktop`,
`npx electron-builder --linux deb AppImage --x64 --publish never`.

## 7. Watch GitHub Actions usage

This repository is public, and public repositories use standard GitHub-hosted runners for free, macOS included. A
private repository uses the account's included minutes and storage instead (GitHub Free: 2,000 minutes a month and
500 MB of artifact storage), with minutes multiplied by runner OS: Linux ×1, Windows ×2, **macOS ×10**, and each job
rounded up to whole minutes. There, a full run (roughly 6-10 min per platform) uses about 15 + 20 + 100 = ~135 of the
2,000 minutes, mostly macOS.

- See usage: GitHub → your avatar → **Settings → Billing and plans → Usage** (filter by Actions), or per run on its
  summary page ("Usage").
- Avoid charges: keep the Actions **spending limit** at $0 (Settings → Billing → Budgets / spending limits). With $0,
  GitHub stops runs when the included amount is used up instead of billing.
- Save minutes (if the repository goes private): pick a single platform when you only need one; macOS is the expensive one.
- Storage: one full run makes about 1 GB of installers (each DMG is about 125 MB, the AppImage and .deb about 115 MB
  each). With 14-day retention, five tags filled the quota and every upload failed, so the workflow keeps artifacts
  for 1 day. GitHub recounts storage only every 6 to 12 hours, so a deletion does not free space at once. Delete artifacts you have downloaded (run page → Artifacts → trash icon, or
  `gh api -X DELETE repos/MhdAljuboori/ZumiBot/actions/artifacts/<id>`), or lower `retention-days` in the workflow.
  The npm and Electron caches live in Actions cache storage (10 GB per repo, oldest evicted first), not in the
  artifact quota.
