# Final packaging validation correction

Base: `bc4fbcb`. Status: DONE; test-only correction, no production cleanup change. Commit: `a5767e3 test(browser): scope check cleanup to owned profile and processes`.

## Finding and evidence

Root's final full run (`/tmp/agent-browser-final-tests.log`) had 131 passing files and one failed packaging file: 1828 passed, one failed, one skipped. The failing assertion required the entire inherited TMPDIR to be empty. Its sole remaining entry was `com.google.Chrome.chrome_chrome_url_fetcher_.uX1km6`, rather than a ZumiBot check profile or ownership record.

I read the systematic-debugging skill before investigation and ran the original focused reproduction once:

```sh
npx vitest run zumi-bot-server/backend/tests/browserPackaging.test.ts -t 'checks a copied artifact'
```

It passed **1/1 (8 skipped)**, exit 0, 2.01s (`/tmp/final-packaging-repro.log`). This confirms the original full-suite failure is intermittent; it does not establish cleanup by itself.

Source trace establishes the ownership boundary:

- `checkBrowserRuntime` creates only `mkdtemp(join(tmpdir(), 'zumibot-browser-check-'))`, launches its `profile` child through the worker adapter, awaits authoritative `instance.close()`, then removes that exact temporary subtree. It never promises to clear global/inherited TMPDIR.
- The worker inherits TMPDIR. Pinned Playwright's `_prepareToLaunch` creates a separate `playwright-artifacts-*` sibling in os.tmpdir and tracks only its own tempDirectories for cleanup. Chromium also inherits that location.
- Local installed Chrome binary strings include `components/update_client/url_fetcher_downloader.cc` and `_chrome_url_fetcher_`. [Chromium's URL fetcher source](https://chromium.googlesource.com/chromium/src/%2B/refs/tags/140.0.7339.185/components/update_client/url_fetcher_downloader.cc) creates its own temporary download directory and schedules error cleanup asynchronously. This published source version is supporting provenance, not a claimed exact source match for Chrome 156. The matching binary strings plus observed basename identify the leftover as Chrome-internal scratch; the precise original background task phase was not recorded and is not asserted.

A separate diagnostic (`/tmp/final-packaging-diagnostic.mjs`, result `/tmp/final-packaging-diagnostic.json`) used only a copied synthetic artifact and a private TMPDIR, observed live ownership records, and retained all evidence. Results:

```text
root: /tmp/cb-check-diagnostic-nPNDRV
CLI exit: 0
stdout: Browser check passed: runtime assets, executable, sandboxed ephemeral launch and cleanup.
stderr: empty
actual profile: .../scratch/zumibot-browser-check-i2SK54/profile
final observed ownership state: stopped
CDP recorded browser identities: 10
worker plus browser identities captured: 11; all absent/zombie/reused by exact birth-identity check
actual profile exists after CLI: false
remaining TMPDIR: [unrelated-temp-owner]
sentinel: preserve
```

No original-failure process identities survived to inspect after that suite's own fixture teardown. Thus I do not infer the original process state from the filename. The source boundary and captured diagnostic show the old assertion tested more than profile/process cleanup. The corrected test now verifies the meaningful contract directly on every run. No production change or deletion of unrecognized scratch paths is justified by this evidence.

## Deterministic RED and minimal correction

Added a pre-existing `unrelated-temp-owner` file to the same scratch root, retaining the original whole-root-empty assertion. Focused command above then failed as intended, exit 1, **1 failed / 8 skipped**, 2.07s:

```text
Expected: []
Received: ["unrelated-temp-owner"]
```

Evidence: `/tmp/final-packaging-red.log`. This demonstrates the contract error deterministically, without depending on Chrome updater timing.

The only committed file is `zumi-bot-server/backend/tests/browserPackaging.test.ts`. In that one fixture:

- A small shell exec wrapper writes the actual launched `--user-data-dir`, browser PID and worker parent PID. A file gate keeps those processes alive until existing `identity` and `readOwner` helpers record their exact birth identities and confirm worker ownership. `exec` preserves the browser PID/birth identity while replacing the shell with real sandboxed Chrome.
- The gate is released in finally and the CLI is awaited even when capture assertions fail.
- After a successful real check, the actual check temporary subtree must be ENOENT, all check-prefix siblings must be absent, and both captured worker/browser identities must be retired according to existing `isRunning`.
- The foreign sentinel must remain byte-identical. Other Chrome-internal scratch entries are neither asserted empty nor deleted by production code.
- App data/metadata preservation assertions remain. The separate copied-worker forced-parent-death test still verifies the whole recorded Chromium process tree.

No instrumentation framework, runtime refactor, production cleanup expansion, unrelated test changes, real profiles, installs, credentials or sudo.

## Final validation

```sh
npx vitest run zumi-bot-server/backend/tests/browserPackaging.test.ts
```

Exit 0: **1 test file passed, 9 tests passed**, 7.17s. `/tmp/final-packaging-green.log`.

```sh
npm run typecheck -w @zumibot/backend
```

Exit 0; `tsc --noEmit -p tsconfig.json` clean. `/tmp/final-packaging-typecheck.log`.

`git diff --check` and staged equivalent: clean. Root will run the full suite and arrange independent scoped review; I did not repeat unrelated validation.

All existing user/controller dirty docs, deploy changes, sync files and package sync entry are preserved and excluded from staging. Diagnostic artifacts remain in their private /tmp folder for inspection rather than deleting uncertain paths.

Durable evidence copies: `final-packaging-logs/{repro.log,red.log,green.log,typecheck.log,diagnostic.json}` beside this report.
