# Public Docker Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stranger with Docker and no GitHub access installs and updates ZumiBot from `zumibot.run`, running a signed image from Docker Hub.

**Architecture:** The release workflow builds a multi-arch image from the signed server tarball's `app/`, pushes it by digest to Docker Hub, and signs a small "Docker bundle" (compose file pinned to that digest, Caddyfiles, installer) with the existing release key. The site re-publishes the bundle and its installer. `docker/install.sh` downloads the bundle, verifies it in a throwaway node container, and hands off to the bundle's own installer, which pulls first, checks for running replies, swaps the folder and starts it.

**Tech Stack:** POSIX sh, Docker Compose 2.17+, buildx/QEMU, GitHub Actions, Node 22 (`--experimental-strip-types`, built-ins only in deploy scripts), vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-public-docker-install-design.md`

## Global Constraints

- **No git commits.** The owner commits. Every task ends with its changes left uncommitted.
- Image: `docker.io/zumibot/server`. Tags `<x.y.z>` and `latest`, only added after signing. The installer uses the digest only.
- Platforms: `linux/amd64,linux/arm64`.
- Bundle asset: `zumibot-docker.tar.gz` (+ `zumibot-docker.tar.gz.sig`), top folder `zumibot-docker/`, files: `docker-compose.yml`, `docker/Caddyfile`, `docker/Caddyfile.local`, `docker/install.sh`, `.env.example`, `VERSION`.
- Signed text for the bundle: `zumibot-docker\n<version>\n<sha256>\n` (server tarball stays `zumibot-server\n…`).
- Installer URL: `https://zumibot.run/releases/latest/docker/install.sh`; bundle from `$SITE/releases/<x.y.z>/`; `SITE=${ZUMIBOT_UPDATE_URL:-https://zumibot.run}`.
- Verify image: exactly the Dockerfile's base, `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`.
- Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, step-level env only, token via stdin, never argv. Missing secrets fail the release.
- Workflows: `permissions: {}` at the top, every action pinned by a 40-hex commit, every checkout `persist-credentials: false`, no npm in any job holding a secret.
- Installer promises kept: `#!/bin/sh` + `set -eu`, loopback (`local` profile) unless `--domain`, never runs sudo, `.env` written with `umask 077` and kept on update, busy check unless `--force`, `<dir>.prev` for rollback, prints where the setup code is but never the code, every docker call gets `</dev/null`, `curl --proto '=https' --tlsv1.2`, nothing piped into a shell.
- Comments short and say why (repo convention). Secrets never in logs, URLs or messages.
- Deploy scripts (`zumi-bot-server/deploy/*.mjs`) and anything they import from `shared/src/` use node built-ins only: the publish job installs nothing.

## Review Focus

1. **A release with no bundle on the site** (every release before this one, or a site built before the bundle existed): the installer must say the release has no Docker bundle, not a bare curl error. Test in Task 5.
2. **A Mac host** (Docker Desktop: `shasum`, no `sha256sum`, LibreSSL, no `getent`): the installer must still hash and verify. Static test in Task 4 that both hash tools are handled and that verification never needs anything on the host but docker.
3. **Re-running on the version already installed** (a repair): must succeed, keep `.env`, keep a `.prev`. Test in Task 5.
4. **An existing source-built install** in `~/zumibot-docker` (full source tree, `COMPOSE_PROFILES=domain` in `.env`, no `VERSION`): update keeps `.env` byte for byte and uses service `zumibot` for the busy check. Test in Task 5.
5. **A leftover `<dir>.next`** from an interrupted run: the next run replaces it and succeeds. Test in Task 5.

---

### Task 1: Shared bundle helpers and the bundle's signed text

**Files:**
- Create: `zumi-bot-server/shared/src/dockerBundle.ts`
- Modify: `zumi-bot-server/shared/src/update.ts` (beside `releaseSignedText`, line ~21)
- Test: `zumi-bot-server/shared/tests/dockerBundle.test.ts` (new), `zumi-bot-server/shared/tests/update.test.ts`

**Interfaces:**
- Produces (in `dockerBundle.ts`, no imports beyond none):
  - `DOCKER_IMAGE = 'docker.io/zumibot/server'`
  - `DOCKER_BUNDLE = 'zumibot-docker.tar.gz'`, `DOCKER_BUNDLE_DIR = 'zumibot-docker'`
  - `DOCKER_BUNDLE_FILES: readonly string[]` = the six files in Global Constraints, in that order
  - `isBundleImage(ref: string, version: string): boolean` — true only for `${DOCKER_IMAGE}:${version}@sha256:<64 lowercase hex>`
  - `bundleCompose(compose: string, image: string): string` — throws `Error` on a shape it does not know
- Produces (in `update.ts`): `dockerBundleSignedText(version: string, sha256: string): string`

- [ ] **Step 1: Write the failing tests**

`update.test.ts`, next to the `releaseSignedText` test:
```ts
it('signs the Docker bundle under its own label, so a server signature never passes for it', () => {
  expect(dockerBundleSignedText('0.1.4', 'a'.repeat(64))).toBe(`zumibot-docker\n0.1.4\n${'a'.repeat(64)}\n`)
  expect(dockerBundleSignedText('V', 'S')).not.toBe(releaseSignedText('V', 'S'))
})
```
`dockerBundle.test.ts` (reads the real `docker-compose.yml` like `dockerSetup.test.ts` does):
- `isBundleImage`: true for `docker.io/zumibot/server:1.2.3@sha256:${'a'.repeat(64)}`; false for another version, no digest, uppercase hex, 63 hex, another name, a trailing newline.
- `bundleCompose(realCompose, ref)`:
  - result has no line matching `/^\s+build:/`, no `CLAUDE_CODE_VERSION`, no `zumibot:${ZUMIBOT_IMAGE_TAG`
  - result contains `\n  image: ${ref}\n` exactly once, inside the `x-zumibot: &zumibot` block (before `  restart: unless-stopped`)
  - the caddy anchor's `image: caddy:` line is untouched
  - every line of the original outside the removed `build:` block and the replaced `image:` line is still there, in order (compare the original with those lines filtered out against the result with the new image line and any added comment filtered out)
- `bundleCompose` throws when the input has no `  build:` line, two of them, or no `  image: zumibot:` line.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project shared zumi-bot-server/shared/tests/dockerBundle.test.ts zumi-bot-server/shared/tests/update.test.ts`
Expected: FAIL, `dockerBundleSignedText` / module not found.

- [ ] **Step 3: Implement**

`dockerBundleSignedText` returns `` `zumibot-docker\n${version}\n${sha256}\n` ``. `bundleCompose` works on text lines (no YAML library: the publish job has no node_modules): find the single line `  build:`, drop it and every following line indented more than two spaces; replace the single line starting `  image: zumibot:` with `  image: ${image}`, preceded by one comment line saying the release pinned it by digest and the installer replaces this file on every update. Comments in the file say why.

- [ ] **Step 4: Run the tests to see them pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 2: `docker-bundle.mjs` and signing the bundle

**Files:**
- Create: `zumi-bot-server/deploy/docker-bundle.mjs`
- Modify: `zumi-bot-server/deploy/release-sign.mjs`
- Test: `zumi-bot-server/shared/tests/dockerBundle.test.ts` (add a run test), `zumi-bot-server/shared/tests/installScripts.test.ts` (one text check for release-sign)

**Interfaces:**
- Consumes: Task 1's `DOCKER_*`, `isBundleImage`, `bundleCompose`, `dockerBundleSignedText`.
- Produces: CLI `node --experimental-strip-types zumi-bot-server/deploy/docker-bundle.mjs <version> <image-ref> <release-dir>` → writes `<release-dir>/zumibot-docker.tar.gz` and sets its line in `<release-dir>/SHA256SUMS` (replacing an existing line for the same name; other lines kept). `release-sign.mjs <version> <release-dir>` now writes both `zumibot-server.tar.gz.sig` and `zumibot-docker.tar.gz.sig`, and dies when either tarball is missing or does not match `SHA256SUMS`.

- [ ] **Step 1: Write the failing tests**

Run test in `dockerBundle.test.ts` (skip if `tar` is missing or node < 22, as `installScripts.test.ts` does): in a scratch dir holding a `SHA256SUMS` with one line for `zumibot-server.tar.gz`, run the script with `9.9.9` and `docker.io/zumibot/server:9.9.9@sha256:${'b'.repeat(64)}`. Assert:
- exit 0; `tar -tzf` lists exactly `zumibot-docker/` plus the six `DOCKER_BUNDLE_FILES` (directories aside)
- the packed `docker-compose.yml` equals `bundleCompose(repoCompose, ref)`; `docker/install.sh`, both Caddyfiles and `.env.example` equal the repo's files; `VERSION` is `9.9.9\n`
- `SHA256SUMS` keeps the server line and gains `<sha256 of the bundle>  zumibot-docker.tar.gz`; a second run leaves exactly one bundle line
- with GNU tar, two runs give the same sha256 (reproducible)
- exits non-zero, writing no tarball, for a ref with another version, a ref without a digest, and a version `9.9` 

In `installScripts.test.ts` ('the release workflow' neighbourhood or a new `describe('release-sign.mjs')`): the file imports `dockerBundleSignedText`, names `DOCKER_BUNDLE`, and checks the bundle against `SHA256SUMS` before it signs (index of the sums check < index of `sign(`).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project shared zumi-bot-server/shared/tests/dockerBundle.test.ts zumi-bot-server/shared/tests/installScripts.test.ts`
Expected: FAIL, script missing.

- [ ] **Step 3: Implement**

`docker-bundle.mjs`: header comment in the style of `release-sign.mjs`; validates args (`x.y.z`, `isBundleImage`), stages the files into a temp dir under `zumibot-docker/`, packs with `tar` using the same reproducible flags as `package.sh` when `tar --sort=name --help` works (`--sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner`), else plain `tar -czf`; hashes with `node:crypto`; rewrites `SHA256SUMS`. `release-sign.mjs`: loop over `[TARBALL, releaseSignedText]` and `[DOCKER_BUNDLE, dockerBundleSignedText]` with the existing sums check and verify-after-sign.

- [ ] **Step 4: Run to see them pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 3: Dockerfile `dist` stage

**Files:**
- Modify: `Dockerfile` (the `COPY --from=build … /app` line and a new stage before the runtime `FROM`)
- Test: `zumi-bot-server/shared/tests/dockerSetup.test.ts` (`describe('Dockerfile')`)

**Interfaces:**
- Produces: stage `dist` whose root is the server bundle; the runtime stage does `COPY --from=dist / /app`. The release and the check run override it with `--build-context dist=release/unpacked/zumibot-server/app`.

- [ ] **Step 1: Update the tests first**

Replace 'pins both stages…' with: the `node:` FROMs are exactly two, both `node:22-bookworm-slim@sha256:<64 hex>` and equal; there is exactly one `FROM scratch AS dist`; the build stage is `AS build`; `COPY --from=build /src/zumi-bot-server/backend/dist /` sits in the `dist` stage; the runtime stage has `COPY --from=dist / /app` and no `COPY --from=build`; no `LABEL` line names `github` or `org.opencontainers.image.source`.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project shared zumi-bot-server/shared/tests/dockerSetup.test.ts -t Dockerfile`
Expected: FAIL.

- [ ] **Step 3: Implement** the stage as in the spec's "The image" block, with a comment saying a release swaps this stage for the signed tarball's `app/`, so the image runs those exact bytes.

- [ ] **Step 4: Run to see it pass.** Same command, PASS.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 4: `docker/install.sh` rewrite, with its promise tests

**Files:**
- Modify (rewrite): `docker/install.sh`
- Test: `zumi-bot-server/shared/tests/dockerSetup.test.ts` (`describe('docker/install.sh, the one-liner')`)

**Interfaces:**
- Consumes: `RELEASE_PUBLIC_KEY`, `dockerBundleSignedText` (text must match), `DOCKER_BUNDLE`, `DOCKER_BUNDLE_FILES`, the Dockerfile's base digest.
- Produces: options `--domain HOST`, `--dir PATH`, `--version X.Y.Z` (leading `v` allowed), `--bundle PATH`, `--force`, `--help`; env `ZUMIBOT_UPDATE_URL`, `ZUMIBOT_DOCKER_DIR`. Exit 0 on success, non-zero with `Error: …` on stderr otherwise. Task 5 drives it with a fake `docker` and `curl`.

Flow (the spec's "Order of work", steps 1–9): without `--bundle`: host checks → version from `--version` or `sed` over `$SITE/releases/latest.json` (must be `x.y.z`) → fetch bundle and `.sig` from `$SITE/releases/$rel/` → sha256 (`sha256sum`, else `shasum -a 256`) → `.sig` content must be 86 base64 chars + `==` → `docker pull -q "$VERIFY_IMAGE"` → `docker run --rm --network none --read-only --user 65534:65534 -e …` with the node check (the VPS installer's code, `"zumibot-docker\n"` first line, signature from env `CB_SIG`, not a file) → unpack → every `DOCKER_BUNDLE_FILES` present → `VERSION` equals `$rel` → `sh "$work/zumibot-docker/docker/install.sh" --bundle "$work/$BUNDLE" --dir "$DIR" [--domain] [--force] </dev/null`, exit with its status. With `--bundle`: host checks → unpack → files and version → profile/`.env` (unchanged rules) → write `$DIR.next` (bundle tree + `.env`) → `docker compose -f "$DIR.next/docker-compose.yml" pull` → busy check on the running install (unchanged rules) → swap (`rm -rf "$DIR.prev"`, `mv "$DIR" "$DIR.prev"`, `mv "$DIR.next" "$DIR"`) → `dc up -d --remove-orphans` → wait → summary (`sh $DIR/docker/install.sh` to update; rollback `mv <dir> <dir>.failed && mv <dir>.prev <dir> && docker compose up -d`).

Messages that tests pin (exact substrings):
- `The release signature does not verify: nothing was installed.`
- `has no Docker bundle` (download of the bundle failed; mention `--version`/`--bundle` and that releases before the Docker image have none)
- `says it is` … `but its signature is for` (VERSION mismatch)
- keep today's: `reply/replies running. Wait for them, or re-run with --force`, `Could not read the running-reply count`, `--domain must be a host name such as`, `--domain must be a host name, not an IP address`, `already exists and says something else`
- preview label (owner's choice): the `--help` text's first line and the closing summary each contain `The Docker install is a preview`

- [ ] **Step 1: Rewrite the tests in `describe('docker/install.sh, the one-liner')`**

Keep: first line/`set -eu`; loopback default regex; `--domain` messages; no sudo run; every docker line has `</dev/null` (the `runsDocker` filter must also catch `docker pull` and `docker run`: widen it to `docker (compose|info|pull|run)`); `umask 077` and `.env` kept (`cp -p "$ENV_FILE" "$DIR.next/.env"`); busy refusal; swap; service names; setup code never printed.
Replace the `--ref`/`--unsafe-ref`/GitHub tests with:
- the code (comments stripped) contains no `github.com`, `raw.githubusercontent`, `--build`, `--unsafe-ref`, `--tarball`
- `SITE=${ZUMIBOT_UPDATE_URL:-https://zumibot.run}`; reads `$SITE/releases/latest.json`; fetches from `$SITE/releases/$rel/`
- `RELEASE_PUBLIC_KEY='…'` equals `RELEASE_PUBLIC_KEY` from shared
- `VERIFY_IMAGE='…'` equals the Dockerfile's `node:` FROM
- contains `"zumibot-docker\\n" + e.CB_VERSION + "\\n" + e.CB_SHA256 + "\\n"` and `dockerBundleSignedText('V','S')` is `zumibot-docker\nV\nS\n`
- order: fetch of `$SIG` < `c.verify(null` < `The release signature does not verify` < first `tar -xzf`
- `docker run --rm --network none` present; hashing handles both `sha256sum` and `shasum -a 256`; no `openssl`, and no `node` outside the `docker run` line (Review Focus 2)
- hand-off: `--bundle "$work/$BUNDLE"` passed to `sh "$work/zumibot-docker/docker/install.sh"`
- pull before swap: index of `pull` < index of `mv "$DIR" "$DIR.prev"`, and busy check index between them
- `up -d --remove-orphans` and no `up -d --build`
- the usage heredoc and the closing summary heredoc each contain `The Docker install is a preview`
- keep the existing docs check that README and install.md never match `ZumiBot/master/docker/install.sh` nor `docker/install.sh | sh` (Task 10 adds the zumibot.run URL checks)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project shared zumi-bot-server/shared/tests/dockerSetup.test.ts`
Expected: FAIL on the new checks.

- [ ] **Step 3: Rewrite `docker/install.sh`** per the flow above, keeping the existing host checks, profile/`.env` block, busy block, wait loop and summary shape. Header comment: the `curl … -o install.sh`, `less`, `sh install.sh [--domain …]` lines from the spec.

- [ ] **Step 4: Run to see them pass**

Run: same command, plus `sh -n docker/install.sh` (exit 0) and `shellcheck docker/install.sh` if installed.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 5: Run tests of the installer with a fake `docker` and `curl`

**Files:**
- Create: `zumi-bot-server/shared/tests/dockerInstall.test.ts`
- Create: `zumi-bot-server/shared/tests/fixtures/fake-docker.mjs` (executable, `#!/usr/bin/env node`)
- Modify: `docker/install.sh` only for bugs these tests find

**Interfaces:**
- Consumes: Task 4's options and messages; Task 1's `DOCKER_BUNDLE_DIR`, `DOCKER_BUNDLE_FILES`, `bundleCompose`, `dockerBundleSignedText`. Not Task 2's script: it packs the repo's own installer, and these bundles need a test-key copy.
- Fixture design (test-local):
  - A test ed25519 pair (`generateKeyPairSync('ed25519')`). Every copy of `install.sh` the test runs, including the one packed in the bundle, has its `RELEASE_PUBLIC_KEY='…'` line swapped for the test key. The production script gets no env override.
  - A fake `curl` (sh) on `PATH`: maps `https://site.test/<path>` to `<fixture-site>/<path>`, honours `-o`, exits 22 for a missing file.
  - The fake `docker`: logs each call (argv, cwd) as a JSON line to `$FAKE_DOCKER_LOG`. `compose version --short` → `2.30.0`; `compose version`, `info`, `pull` → 0; `run … IMAGE node -e CODE` → runs the real `node -e CODE` with the `-e NAME=VALUE` pairs as its env; `compose -f F ps -q SVC` → an id when `$FAKE_DOCKER_STATE/running` exists; `compose … exec -T SVC zumibot-server busy` → `$FAKE_BUSY` (default `0`; `x` means print `unknown`); `compose -f F pull` → logs whether `F` is inside a `.next` folder and the `VERSION` currently in `$DIR`; `compose … up -d …` → creates `running`.
  - Bundles packed by the test with `tar -czf` in the bundle layout (`zumibot-docker/` + `DOCKER_BUNDLE_FILES`; compose from `bundleCompose(repoCompose, ref)`; the test-key installer copy; the Caddyfiles and `.env.example` from the repo; `VERSION`) into the fixture site under `releases/<v>/`, signed with the test key over `dockerBundleSignedText`; `releases/latest.json` = `{"version":"<v>"}`.
  - `HOME` and `TMPDIR` in the scratch dir; `ZUMIBOT_UPDATE_URL=https://site.test`.

- [ ] **Step 1: Write the run tests** (skip when `sh`, `tar` or node 22 is missing, or running as root)

1. First install, no `--domain`: exit 0; `$DIR/docker-compose.yml` names the bundle digest; `.env` has `COMPOSE_PROFILES=local` and `ZUMIBOT_LOCAL_PUBLISH=127.0.0.1:8443`, mode `600`; the log has a `run` with `--network none` before any `pull`; an `up -d --remove-orphans` and never `--build`; stdout names `docker compose logs zumibot-local`.
2. Update to a newer version (busy `0`): `.env` byte for byte kept (add a custom line first); `$DIR.prev/VERSION` is the old one; the `pull` log line says it ran from `.next` while `$DIR/VERSION` was still the old version.
3. Busy `2`: exits non-zero with the busy message, `$DIR` unchanged, no `up` logged; again with `--force`: exit 0.
4. Busy `x`: refuses with `Could not read the running-reply count`.
5. Bad signatures: a `.sig` over other bytes, and a `.sig` made with `releaseSignedText` (the server label) over the right sha: both exit non-zero with `does not verify`, no `$DIR`, no `pull`.
6. `VERSION` inside says `9.9.8` but signed as `9.9.9`: refused with `says it is`.
7. Hand-off: the bundle's installer copy carries one extra `say "bundle installer ran"` line after `set -eu`; stdout contains it.
8. Review Focus 1: `latest.json` names a version with no bundle on the site: non-zero, `has no Docker bundle`.
9. Review Focus 3: run the same version twice: both exit 0, `.env` kept, `.prev` present.
10. Review Focus 4: `$DIR` pre-seeded as a source install (`Dockerfile`, `docker-compose.yml` with `build:`, `.env` with `COMPOSE_PROFILES=domain` and `ZUMIBOT_DOMAIN=z.example.com`, no `VERSION`) and `running`: exit 0, `.env` identical, busy asked of service `zumibot`, `$DIR.prev/Dockerfile` exists.
11. Review Focus 5: a junk `$DIR.next` before the run: exit 0, no junk left in `$DIR`.
12. `--domain other.example.com` over an install whose `.env` says `local`: refused, `already exists and says something else`.

- [ ] **Step 2: Run them**

Run: `npx vitest run --project shared zumi-bot-server/shared/tests/dockerInstall.test.ts`
Expected: whatever fails points at a bug in `docker/install.sh` or the fakes; fix the script for script bugs.

- [ ] **Step 3: Fix and re-run until PASS.** Then run Task 4's tests again: PASS.

- [ ] **Step 4: Leave uncommitted.**

---

### Task 6: Release workflow: `image` job, bundle, tags

**Files:**
- Modify: `.github/workflows/release.yml`
- Test: `zumi-bot-server/shared/tests/installScripts.test.ts` (`describe('the release workflow')`)

**Interfaces:**
- Consumes: Task 2's CLI, Task 3's `dist` stage, `DOCKER_IMAGE`.
- Produces: job `image` with output `digest` (`sha256:<64 hex>`, the pushed index); release assets gain `release/zumibot-docker.tar.gz` and `release/zumibot-docker.tar.gz.sig`.

Shape: workflow-level `env: IMAGE: docker.io/zumibot/server`. `image`: `needs: build`, `permissions: contents: read`, `outputs: digest: ${{ steps.push.outputs.digest }}`; steps: checkout (`persist-credentials: false`), `actions/download-artifact` (same pin as publish), unpack (`mkdir -p release/unpacked && tar -xzf release/zumibot-server.tar.gz -C release/unpacked`), `docker/setup-qemu-action` and `docker/setup-buildx-action` pinned by commit (take the newest release: `git ls-remote --tags https://github.com/docker/setup-qemu-action | sort -t/ -k3 -V | tail -1`, same for buildx; a `# vX.Y.Z` comment above each as the file does), a "Sign in to Docker Hub" step that fails naming both secrets when either is empty and logs in with `--password-stdin`, then `id: push`: `docker buildx build --platform linux/amd64,linux/arm64 --build-context dist=release/unpacked/zumibot-server/app --output "type=image,name=$IMAGE,push-by-digest=true,name-canonical=true,push=true" --metadata-file release/image.json .`, reading `containerimage.digest` (check it is `sha256:` + 64 hex) into `$GITHUB_OUTPUT`; a final `if: always()` `docker logout`. `publish`: `needs: [build, image]`; before signing, "Pack the Docker bundle" with `DIGEST: ${{ needs.image.outputs.digest }}` in step env running `node --experimental-strip-types zumi-bot-server/deploy/docker-bundle.mjs "${GITHUB_REF_NAME#v}" "$IMAGE:${GITHUB_REF_NAME#v}@$DIGEST" release`; after signing, "Tag the image" (secrets and `DIGEST` in step env, login via stdin, `docker buildx imagetools create --tag "$IMAGE:${GITHUB_REF_NAME#v}" --tag "$IMAGE:latest" "$IMAGE@$DIGEST"`, logout); `gh release create` gains the two bundle files. Header comment: three jobs and why; the one-time Docker Hub setup.

- [ ] **Step 1: Write the failing tests**

- `job('image')` has `permissions:\n\s*contents: read\n` and nothing else; no `\bnpm\b|\bnpx\b|setup-node`; contains `push-by-digest=true` and no `--tag`/` -t `; contains `--build-context dist=release/unpacked/zumibot-server/app` and `--platform linux/amd64,linux/arm64`; `needs: build`.
- `secrets.DOCKERHUB_TOKEN` appears exactly twice, once in `job('image')`, once in `job('publish')`, each as `DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}` in a step's `env:`; `--password-stdin` in both; `DOCKERHUB_TOKEN` never on a `docker login -p` / `--password ` line.
- In `job('publish')`: `needs: [build, image]`; order `docker-bundle.mjs` < `release-sign.mjs` < `imagetools create` < `gh release create` < `Rebuild the showcase site`; `release/zumibot-docker.tar.gz` and `release/zumibot-docker.tar.gz.sig` listed in the create command.
- The workflow's `IMAGE:` value equals `DOCKER_IMAGE`.
- Existing tests stay green (the `not.toMatch(/packages:|id-token/)` one included).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project shared zumi-bot-server/shared/tests/installScripts.test.ts -t "release workflow"`. Expected: FAIL.

- [ ] **Step 3: Edit `release.yml`** as shaped above.

- [ ] **Step 4: Run to see them pass,** and check the YAML parses: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"` (exit 0).

- [ ] **Step 5: Leave uncommitted.**

---

### Task 7: Manual check run `docker-image-check.yml`

**Files:**
- Create: `.github/workflows/docker-image-check.yml`
- Test: `zumi-bot-server/shared/tests/installScripts.test.ts` (new `describe('the Docker image check run')`)

**Interfaces:**
- Consumes: the same commands as Tasks 2, 6 and the `build` job.

Shape: `on: workflow_dispatch` only; `permissions: {}`; one job `check`, `contents: read`; steps: checkout (`persist-credentials: false`), setup-node (same pin, `cache: npm`), `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build:server`, `sh zumi-bot-server/deploy/package.sh release`, the same unpack line, the same QEMU and buildx pins, `docker buildx build --platform linux/amd64,linux/arm64 --build-context dist=release/unpacked/zumibot-server/app --output type=cacheonly .`, then `--platform linux/amd64 … --load -t zumibot-check .`; smoke: start `zumibot-check` detached with `ZUMIBOT_MODE=vps ZUMIBOT_PORT=4317 ZUMIBOT_ORIGIN=https://localhost:8443`, wait up to 60 s for `docker exec <c> zumibot-server busy`, then `docker exec <c> claude --version`, printing `docker logs` on failure; bundle: `docker-bundle.mjs` with `"$version"` read from `zumi-bot-server/backend/package.json` and `docker.io/zumibot/server:$version@sha256:` + 64 zeros, unpack it, `COMPOSE_PROFILES=local docker compose -f <unpacked>/docker-compose.yml config -q` and the same with `COMPOSE_PROFILES=domain ZUMIBOT_DOMAIN=check.example.com`; `sh -n docker/install.sh`.

- [ ] **Step 1: Write the failing tests**

- the file's `on:` block is exactly `workflow_dispatch` (no `push`, `pull_request`, `schedule`); `permissions: {}` at top and `contents: read` in the job.
- no `secrets.`, no `docker login`, no `push=true`, no `imagetools`.
- every `uses:` pinned by 40 hex, each checkout with `persist-credentials: false`.
- these exact lines are in both this file and `release.yml`: `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build:server`, `sh zumi-bot-server/deploy/package.sh release`, the unpack line, `--build-context dist=release/unpacked/zumibot-server/app`, `--platform linux/amd64,linux/arm64`, and the `uses: docker/setup-qemu-action@…` and `uses: docker/setup-buildx-action@…` lines.

- [ ] **Step 2: Run to see them fail.** `npx vitest run --project shared zumi-bot-server/shared/tests/installScripts.test.ts -t "check run"`: FAIL.

- [ ] **Step 3: Write the workflow.** Header comment: what it proves, that it pushes nothing and holds no secret, run it once before the first tag after a Dockerfile or workflow change.

- [ ] **Step 4: Run to see them pass,** plus the `python3 … yaml.safe_load` check on the new file.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 8: Site publishes the bundle and its installer

**Files:**
- Modify: `zumi-bot-site/src/publishRelease.ts` (constants), `zumi-bot-site/scripts/fetchRelease.mjs` (header comment and the publish logic)
- Test: `zumi-bot-site/tests/publishRelease.test.ts`

**Interfaces:**
- Produces: `DOCKER_BUNDLE = 'zumibot-docker.tar.gz'`, `DOCKER_SIG = 'zumibot-docker.tar.gz.sig'`, `DOCKER_INSTALLER = 'zumibot-docker/docker/install.sh'` in `publishRelease.ts`. Site output: `releases/<v>/zumibot-docker.tar.gz`, `releases/<v>/zumibot-docker.tar.gz.sig`, `releases/latest/docker/install.sh`.

- [ ] **Step 1: Write the failing test:** the three constants equal `DOCKER_BUNDLE`, `` `${DOCKER_BUNDLE}.sig` `` and `` `${DOCKER_BUNDLE_DIR}/docker/install.sh` `` from `@zumibot/shared/dockerBundle`.

- [ ] **Step 2: Run to see it fail.** `npx vitest run --project zumi-bot-site`: FAIL.

- [ ] **Step 3: Implement.** In `fetchRelease.mjs`, after the server tarball: when the release has `DOCKER_BUNDLE`, download it to `vdir`, require `sumOf(SUMS, DOCKER_BUNDLE)` to exist and match (else throw, failing the build), download and `signatureOf`-check the `.sig` when present (warn when absent, as for the server), and write `latest/docker/install.sh` from `tar -xzOf <bundle> DOCKER_INSTALLER`. When the release has none, `console.warn` that it is published without a Docker bundle. Update the header comment's list of published paths.

- [ ] **Step 4: Run** `npx vitest run --project zumi-bot-site` (PASS) and `cd zumi-bot-site && node --experimental-strip-types scripts/fetchRelease.mjs` with no `GITHUB_TOKEN` (prints `wrote null (no token)`, exit 0; then `git checkout zumi-bot-site/src/release.json` if it changed).

- [ ] **Step 5: Leave uncommitted.**

---

### Task 9: The app's container line

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/update.ts:16`
- Test: `zumi-bot-server/frontend/tests/update.test.ts:83`

- [ ] **Step 1: Change the test** to expect `'Updates are not available in a container install: run the Docker installer again'`.
- [ ] **Step 2: Run** `npx vitest run --project frontend zumi-bot-server/frontend/tests/update.test.ts`: FAIL.
- [ ] **Step 3: Change the string** in `unavailableLine`.
- [ ] **Step 4: Run again:** PASS. Also `grep -rn "pull a new image" docs zumi-bot-server --include=*.md --include=*.ts --include=*.tsx` and update any hit (updates.md's availability table).
- [ ] **Step 5: Leave uncommitted.**

---

### Task 10: Docs, README, `.env.example`

**Files:**
- Modify: `docs/architecture/install.md` (Phase 2: intro, "The image", "What is deliberately not in the image", "Updating", "The one-line installer"; "The release artifacts"), `docs/architecture/updates.md` (release flow step 5, "Release signing", the site's published paths, availability table), `README.md` ("Quick start with Docker"), `.env.example` (the CLI pin applies to source builds only), the spec's status line if anything changed in the build.

What each says (facts only; keep each doc's voice: short sentences, the why):
- install.md Phase 2 leads with the installer (`curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh`, `less install.sh`, `sh install.sh [--domain …]`); the three-command compose path stays as "from a source checkout". "The image": built by the release from the signed tarball's `app/` (the `dist` stage and `--build-context`), `zumibot/server` on Docker Hub, amd64 and arm64, tags after signing, the installer pins the digest. "One-line installer": the 9 steps, the options, verification in the pinned node container, the hand-off, pull before swap, rollback line, moving a source install. "Not in the image": derived image `FROM zumibot/server:<x.y.z>` from your own folder, rebuilt each release; the installer's folder is replaced on every update. "Updating": run the installer again; a source checkout keeps `git pull && docker compose up -d --build`. "The release artifacts": the `image` job, the bundle, the check run, the two Docker Hub secrets, what happens when they are missing.
- updates.md: step 5 of the release flow names the three jobs and the tag order; "Release signing" adds `zumibot-docker\n<version>\n<sha256>\n` (`dockerBundleSignedText`) and that the bundle's signature covers the image digest; the site section lists the bundle paths and `latest/docker/install.sh`; the availability table's container row says "run the Docker installer again".
- README: the Docker quick start uses the zumibot.run URL and drops `TAG=` and the git clone block (keep the clone path one line: "from a source checkout: `docker compose up -d --build`").

- [ ] **Step 1: Add the docs checks** to `dockerSetup.test.ts` (in the installer `describe`): README and install.md never match `raw.githubusercontent.com`; both contain `https://zumibot.run/releases/latest/docker/install.sh`; README's `## Quick start with Docker` section and install.md's `## Phase 2: Docker` section each have a line starting `**Preview:**` within their first five lines (owner's choice: the Docker install is labelled a preview; keep the headings unchanged so existing anchors still work). Run them: FAIL.
- [ ] **Step 2: Edit the docs.**
- [ ] **Step 3: Run** `npx vitest run --project shared zumi-bot-server/shared/tests/dockerSetup.test.ts zumi-bot-server/shared/tests/repoDocs.test.ts`: PASS.
- [ ] **Step 4: Check** `grep -n "raw.githubusercontent\|--unsafe-ref\|--ref \|pull a new image" README.md docs/architecture/install.md docs/architecture/updates.md` shows nothing stale.
- [ ] **Step 5: Leave uncommitted.**

---

### Task 11: Whole-branch verification

- [ ] **Step 1:** `npm test` — all projects pass. Report any failure with its output.
- [ ] **Step 2:** `npm run typecheck` — exit 0.
- [ ] **Step 3:** `sh -n docker/install.sh`; `shellcheck docker/install.sh` if installed; the two `python3 … yaml.safe_load` checks.
- [ ] **Step 4:** `git status` — only the files this plan names changed; nothing committed. Note for the owner: what still needs a real Docker host (the check run, the first release, `docker logout && docker pull zumibot/server:<x.y.z>`, one install and one update on a fresh host) and the one-time Docker Hub setup.

---

## Amendment tasks (spec "Amendment 2026-11-20: Mac hosts, Tailscale, no downgrades")

### Task 12: Installer `--origin`, downgrade refusal, Mac messages

**Files:**
- Modify: `docker/install.sh`
- Test: `zumi-bot-server/shared/tests/dockerSetup.test.ts` (installer describe), `zumi-bot-server/shared/tests/dockerInstall.test.ts` (run tests), `zumi-bot-server/shared/tests/fixtures/fake-docker.mjs` (one new switch)

**Interfaces:**
- Produces: option `--origin URL`; installer messages pinned below. Task 13 documents them.

Behaviour (exact):
- `--origin URL`: lowercase it; must match `https://HOST:8443` with HOST from `[a-z0-9.-]`, not starting or ending in `.`/`-`, no `..`, and nothing after the port. Refusals (substrings pinned): `--origin must be https://HOST:8443` (bad form, other port, http, path), `--origin is for the loopback profile` (with `--domain`), and on an existing install the existing `already exists and says something else` unless `COMPOSE_PROFILES=local` and `ZUMIBOT_LOCAL_ORIGIN` in `.env` equal it. Checked before any download, like `--domain`. Passed on in the hand-off (`${ORIGIN_ARG:+--origin "$ORIGIN_ARG"}` or equivalent).
- First install with `--origin`: `.env` has `ZUMIBOT_LOCAL_PUBLISH=127.0.0.1:8443` and `ZUMIBOT_LOCAL_ORIGIN=<origin>`.
- Summary, local profile: when the origin's host is `localhost`, keep the `ssh -L 8443:127.0.0.1:8443` form and add one line naming `--origin https://<this-machine>.<tailnet>.ts.net:8443` for Tailscale; otherwise print `tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443` and `<origin>/setup` from any device on the tailnet, with no `ssh -L` line. `--help` lists `--origin`.
- Downgrade: in the download path only, after the release version is known and before any bundle download: when `$DIR/VERSION` is a plain x.y.z and the release is older (numeric compare per part), die with a message containing `which is older` and naming both the `.prev` rollback and `--bundle`. Equal versions pass. `--bundle` runs are never checked.
- Darwin (`uname -s` = `Darwin`): missing `docker` → message containing `Docker Desktop, OrbStack or Colima`; unreachable daemon → `Start Docker Desktop, OrbStack or Colima`, with no `usermod` in that branch. Linux messages unchanged.

- [ ] **Step 1: Write the failing tests.** Static: `--origin` in usage; the three refusal substrings; `tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443` in the script; `which is older`; the Darwin strings, and the `usermod` line only in the non-Darwin branch. Run (fake docker/curl harness): (a) first install with `--origin https://mac.tail1234.ts.net:8443` writes both `.env` lines, summary has the `tailscale serve` line and `https://mac.tail1234.ts.net:8443/setup`, no `ssh -L`; (b) default first install summary still has `ssh -L` and names `--origin`; (c) `--origin` refusals: `:9443`, `http://`, a path, with `--domain`, and a different origin over an existing local install — each exits non-zero with its message and no `pull`; the same origin over that install succeeds; (d) installed `9.9.9`, site latest `9.9.8`: refused with `which is older`, no bundle fetched, `$DIR` unchanged; (e) a `--bundle` of `9.9.8` over `9.9.9` installs; (f) a fake `uname` printing `Darwin` and `FAKE_DOCKER_INFO_FAIL=1` (new switch in fake-docker: `info` exits 1): message has `Start Docker Desktop, OrbStack or Colima` and no `usermod`.
- [ ] **Step 2: Run to see them fail.** `npx vitest run --project shared zumi-bot-server/shared/tests/dockerSetup.test.ts zumi-bot-server/shared/tests/dockerInstall.test.ts`.
- [ ] **Step 3: Implement** in `docker/install.sh`, keeping its helpers and style; `sh -n` and `dash -n` clean.
- [ ] **Step 4: Run to see them pass,** then `npx vitest run --project shared` once.
- [ ] **Step 5: Leave uncommitted** (the owner's staged set stays as it is; do not `git add`).

### Task 13: Docs for `--origin`, Tailscale, Mac hosts, no downgrades

**Files:**
- Modify: `.env.example`, `docs/architecture/install.md` (local profile paragraph near "private network such as Tailscale", the one-line installer section's options and behaviour list), `README.md` (Docker quick start: one line for `--origin`)
- Test: `zumi-bot-server/shared/tests/dockerSetup.test.ts`

What each says:
- `.env.example` local-profile comments: the port is fixed at 8443 (compose publishes `…:8443` and Caddy listens on the origin's port), so the origin must end in `:8443` and be exactly what the browser types; for Tailscale keep `ZUMIBOT_LOCAL_PUBLISH=127.0.0.1:8443`, set `ZUMIBOT_LOCAL_ORIGIN=https://<this-machine>.<tailnet>.ts.net:8443`, and run `tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443` on the host. No tailnet-IP publish example.
- install.md: replace the tailnet-IP advice with the `tailscale serve` form and the why (Colima's VM, tailscaled after Docker at boot); `--origin` in the installer's options; the downgrade refusal and the ways back; Mac hosts (Docker Desktop, OrbStack or Colima; the daemon message; a Mac can be the first real end-to-end check).
- README: under the Docker one-liner, `sh install.sh --origin https://<this-machine>.<tailnet>.ts.net:8443` for Tailscale.

- [ ] **Step 1: Add the failing checks:** `.env.example` and install.md contain `tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443`; neither suggests publishing on `100.`; install.md mentions `--origin` and `which is older` or "older"; README mentions `--origin`. Run: FAIL.
- [ ] **Step 2: Edit the docs.**
- [ ] **Step 3: Run** `npx vitest run --project shared zumi-bot-server/shared/tests/dockerSetup.test.ts zumi-bot-server/shared/tests/repoDocs.test.ts`: PASS.
- [ ] **Step 4: Leave uncommitted.**
