# backend tests — docs

The suite runs on Linux, Windows and macOS. A fake CLI comes from `support/fakeBin.ts`, never a hand-written `#!/bin/sh`
file (Windows cannot spawn one); mode bits, symlinks, signals and `/proc` are gated (`/proc` and the `setsid` command with
`process.platform !== 'linux'`, since macOS has neither). Before changing tests here, read "Tests on Windows" and "Tests on
macOS" in `docs/architecture/install.md` (repo-root path).
