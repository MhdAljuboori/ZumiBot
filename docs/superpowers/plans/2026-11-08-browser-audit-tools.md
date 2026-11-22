# Agent browser audit tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `browser_save_screenshot`, `browser_computed_style`, `browser_hover` and `browser_set_viewport` to the agent browser.

**Architecture:** Four new `BrowserCommand` ops flow through the existing chain (tool definitions, `parseBrowserCommand`, IPC, manager, worker adapter, Chromium). The worker returns PNG bytes; the manager (server side) writes them through a new `BrowserShots` store and returns only `{path, name, bytes, width, height}`. The viewport size goes through the manager, which already owns it.

**Tech Stack:** TypeScript, Playwright (real Chromium in `chromiumAdapter.test.ts`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-audit-tools-design.md`

## Global Constraints

- Paths below are under `zumi-bot-server/` unless they start with `docs/`, `CLAUDE.md`. `B/` = `backend/src/core/browser/`.
- Tool names: `browser_save_screenshot`, `browser_computed_style`, `browser_hover`, `browser_set_viewport`; ops `saveScreenshot`, `computedStyle`, `hover`, `setViewport`.
- Names: `[a-z0-9][a-z0-9_-]{0,63}`; one file `<name>.png`; at most 200 files per chat (`too_many_shots`; overwriting an existing name is allowed); at most 5 MiB per PNG (`image_too_large`).
- Shots folder `<data dir>/browser-shots/<chatId>/`; folders 0700, files 0600; never synced, never copied by Fork or Clone room, deleted with the chat.
- Viewport bounds are `fitBrowserViewport` (240x200 to 1920x1080); screenshots in CSS pixels (`scale: 'css'`).
- Playwright calls that wait for actionability get an explicit timeout (the context default is 0 and would hang until the browser is killed): 10 000 ms for the element screenshot and the hover.
- Computed style: fixed property list, each value cut at 200 characters in the worker plus `SCRUB_MARGIN`, then scrubbed and cut on the server; the whole result must stay under 48 000 characters.
- No new dependencies. Comments short and about *why*. **Do not commit** (the user's rule); each task ends with `git add`.
- Typecheck: `cd zumi-bot-server/backend && npx tsc --noEmit -p tsconfig.json` and the same in `shared` and `frontend` must print nothing. Tests from the worktree root: `npx vitest run <path>`; clear `node_modules/.vitest-cache` if results look stale. The worktree resolves `@zumibot/*` through git-ignored symlinks in `node_modules/@zumibot`; if they are missing, create `node_modules/@zumibot/{shared,backend,frontend}` as symlinks to `../../zumi-bot-server/<pkg>`.

## Review Focus

1. A saved-shot name that tries to be a path (`../x`, `a/b`, `A`, empty, 65 chars, `.png`) is refused by the parser AND by the store (Task 1, Task 3).
2. The PNG bytes never leave the manager inside a result (no base64 reaches the IPC, the bridge or the model): the result of `saveScreenshot` holds only the path and sizes (Task 4).
3. A computed-style value that equals a Vault secret comes back as `[hidden by vault]` and no value longer than the limit passes (Task 5).
4. `browser_set_viewport` while a viewer is also connected: the agent's size wins during the lease and the viewer's size comes back afterwards, without a skipped same-size resize (Task 4).
5. Deleting a chat removes its shots, and a sync never lists `browser-shots/` (Task 3).

---

### Task 1: Shared command shapes

**Files:**
- Modify: `shared/src/browser.ts` (`BrowserCommand`, `parseBrowserCommand`, new exports)
- Test: `shared/tests/browser.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SHOT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
  export const SHOTS_PER_CHAT_MAX = 200
  export const SHOT_BYTES_MAX = 5 * 1024 * 1024
  // BrowserCommand gains:
  | { op: 'saveScreenshot'; name: string; ref?: string; stamp?: BrowserStamp; fullPage?: boolean }
  | { op: 'computedStyle'; stamp: BrowserStamp; ref: string }
  | { op: 'hover'; stamp: BrowserStamp; ref: string }
  | { op: 'setViewport'; width: number; height: number }
  ```
  (use the file's existing stamp type name; mirror how `click` declares it).

- [ ] **Step 1: Write the failing tests** in the existing `it.each` tables of `shared/tests/browser.test.ts`:
  - accepts: `{op:'saveScreenshot', name:'row-hover-product'}`; with `fullPage: true`; with `ref` and `stamp`; `{op:'computedStyle', stamp, ref}`; `{op:'hover', stamp, ref}`; `{op:'setViewport', width: 1440, height: 900}`.
  - rejects: `saveScreenshot` with name `''`, `'../x'`, `'a/b'`, `'A'`, `'a.png'`, 65 characters, a number; with `ref` but no `stamp` and with `stamp` but no `ref`; `fullPage` together with `ref`; an extra key; `computedStyle` and `hover` without stamp or ref or with a ref of 129 characters; `setViewport` with a non-integer, 0, negative, 5000 wide, NaN, or a missing height.

- [ ] **Step 2: Run to see them fail.** Run: `npx vitest run zumi-bot-server/shared/tests/browser.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement** the type members and the four `case`s in `parseBrowserCommand` following its pattern (validate fields, set `allowed`, one `fields(c, ['op', ...allowed])`). `setViewport` accepts integers inside `fitBrowserViewport`'s bounds (read its constants and reuse them rather than copying numbers); `saveScreenshot`'s `ref`/`stamp` use the same `stamp()` and `id()` helpers as `click`. Export the three constants above.

- [ ] **Step 4: Run to see them pass,** then `npx vitest run --project shared` and the shared typecheck.

- [ ] **Step 5: Stage** `git add zumi-bot-server/shared/src/browser.ts zumi-bot-server/shared/tests/browser.test.ts`

---

### Task 2: Chromium and fake adapter ops

**Files:**
- Modify: `B/chromiumAdapter.ts` (`dispatch`), `B/types.ts` only if the adapter interface needs a member
- Modify: `backend/tests/support/fakeBrowser.ts` (the fake answers the new ops)
- Test: `backend/tests/core/chromiumAdapter.test.ts` (real Chromium against `e2e/fixtures/browser-site.mjs`)

**Interfaces:**
- Consumes: Task 1 command shapes.
- Produces: `execute` results (all `{ok:true, data}`):
  - `saveScreenshot` -> `{ mimeType: 'image/png', base64: string, width: number, height: number }`; failures `{ok:false, code:'image_too_large', message}`, `stale_reference` for a stale ref.
  - `computedStyle` -> `{ style: Record<string,string>, rect: {x:number,y:number,width:number,height:number} }`.
  - `hover` -> `{ hovered: true }`.
  - `setViewport` is NOT executed by the adapter (the manager applies it, Task 4); the adapter exposes the existing `setViewport(width, height)` instance method unchanged.
- Exports from `B/chromiumAdapter.ts` or a new `B/browserStyle.ts`: `COMPUTED_STYLE_PROPS: readonly string[]` (the fixed list in the spec) and `STYLE_VALUE_MAX = 200`.

- [ ] **Step 1: Write failing tests** (real Chromium; reuse the file's fixture helpers):
  - `saveScreenshot` page: returns `image/png`, base64 decodes to bytes starting with the PNG signature `89 50 4E 47`, `width`/`height` equal the viewport (CSS px); with `fullPage: true` the height is at least the viewport height.
  - `saveScreenshot` with a ref and stamp: width and height equal the element's `getBoundingClientRect` size (rounded); a stale stamp gives `stale_reference` and takes no shot.
  - `saveScreenshot` over 5 MiB: use a page with a huge canvas or an injected oversize via the fake's `respond`/a test seam; expect `image_too_large`.
  - `computedStyle` on a fixture element with known CSS (inline style in the fixture page): `style['font-size']` is `'16px'`-style computed text, `style['background-color']` is `rgb(...)` text, `rect.width` matches; a value longer than 200 characters (a `font-family` list of 300 characters) is cut to 200.
  - `computedStyle` with a stale ref gives `stale_reference`.
  - `hover` on an element with `:hover` CSS: afterwards `computedStyle` of that element shows the hover colour; `hover` on a stale ref gives `stale_reference`.
  - Fake adapter: `FakeBrowser` answers the new ops with canned data, records them in `commands`, and honours `respond`.

- [ ] **Step 2: Run to see them fail.** Run: `npx vitest run zumi-bot-server/backend/tests/core/chromiumAdapter.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement** the three `dispatch` cases next to `scroll`/`click`. Resolve a ref exactly as `click` does (`this.observation.resolve(stamp, activeTabId, ref)` then the `isConnected` check -> `stale_reference`). Screenshot: `page.screenshot({type:'png', scale:'css', fullPage, timeout:10000})` or `handle.screenshot({type:'png', scale:'css', timeout:10000})`; reject above `SHOT_BYTES_MAX`; read the PNG's width/height from its IHDR (bytes 16-23), no new dependency. Style: one `handle.evaluate` that reads `getComputedStyle` for `COMPUTED_STYLE_PROPS` and `getBoundingClientRect`, cutting each value at `STYLE_VALUE_MAX + SCRUB_MARGIN` characters inside the page function (the margin constant from `B/browserLimits.ts`). Hover: `handle.hover({timeout:10000})`. Respect the existing `dialog_pending` guard and `guarded` wrapper.

- [ ] **Step 4: Run to see them pass,** then the backend typecheck.

- [ ] **Step 5: Stage** the changed files.

---

### Task 3: `BrowserShots` store, wiring, deletion, sync exclusion

**Files:**
- Create: `B/browserShots.ts`
- Modify: `backend/src/app.ts` (build the store beside `SnapshotStore`, ~207), `B/browserApplication.ts` (accept and pass it), `backend/src/rpc/handlers.ts` (`chats:remove` and its deps type), `deploy/sync.mjs` (exclusions)
- Test: `backend/tests/core/browserShots.test.ts` (create), `backend/tests/rpc/handlers.test.ts` (chat removal), the sync test file that covers exclusions (find with Grep for `desktops` under `zumi-bot-server/deploy` tests or `backend/tests`)

**Interfaces:**
- Consumes: constants from Task 1.
- Produces:
  ```ts
  export class BrowserShots {
    constructor(root: string)  // <data dir>/browser-shots
    save(chatId: string, name: string, png: Uint8Array): Promise<{ path: string; bytes: number }>  // refuses bad id/name, > SHOT_BYTES_MAX, > SHOTS_PER_CHAT_MAX new files
    removeChat(chatId: string): Promise<void>
  }
  export const SHOT_REFUSALS = { name: 'invalid_shot_name', many: 'too_many_shots', big: 'image_too_large' } as const
  ```
  `save` throws an `Error` whose `message` is one of `SHOT_REFUSALS` values.

- [ ] **Step 1: Write failing tests:**
  - save writes `<root>/<chatId>/<name>.png`, returns that absolute path and the byte count, folder mode 0700, file mode 0600; the same name overwrites without growing the count.
  - refuses names `../x`, `a/b`, `A`, `''`, `'.png'`, 65 characters; refuses a chat id that is not a valid id (`../x`) with `invalid_shot_name`'s sibling message `invalid_chat`; refuses a 5 MiB + 1 byte PNG with `image_too_large`; the 201st distinct name gives `too_many_shots`.
  - `removeChat` removes the folder and is a no-op when it does not exist.
  - handlers: `chats:remove` calls `browserShots.removeChat(id)` (extend the existing removal test with a fake store, as the snapshots one does).
  - sync: the list of pushed, pulled and backed-up paths never includes anything under `browser-shots/` (copy the test that proves it for `desktops/`).

- [ ] **Step 2: Run to see them fail.** Run: `npx vitest run zumi-bot-server/backend/tests/core/browserShots.test.ts`

- [ ] **Step 3: Implement** `BrowserShots` after `SnapshotStore` (`core/files/snapshotStore.ts`): validate the chat id with the same id regex, build the path yourself, create directories 0700 and write files 0600 atomically (the repo's `writeFileAtomic`), count existing `.png` files for the cap. Wire it in `app.ts`, pass it through `createBrowserApplication` to the manager's dependencies (the manager uses it in Task 4; here only add the optional dependency field and plumbing, unused), add `removeChat` in `chats:remove` beside `snapshots.removeChat`, and add `browser-shots/` wherever `desktops/` is excluded in `deploy/sync.mjs`.

- [ ] **Step 4: Run to see them pass** plus the touched test files and the backend typecheck.

- [ ] **Step 5: Stage** the changed files.

---

### Task 4: Manager: write the file, viewport override

**Files:**
- Modify: `B/browserManager.ts` (`run`, `wantedViewport`, `syncViewport`, lease release/relaunch)
- Test: `backend/tests/core/browserManager.test.ts` (uses `FakeBrowserAdapter`/`FakeBrowser`)

**Interfaces:**
- Consumes: Task 2 results, Task 3 `BrowserShots` and `SHOT_REFUSALS`.
- Produces: `manager.run(owner, command, signal)` returns for `saveScreenshot` `{ok:true, data:{path, name, bytes, width, height}}` (never base64) or `{ok:false, code, message}` with code `invalid_shot_name | too_many_shots | image_too_large`; for `setViewport` `{ok:true, data:{width, height}}` (the applied, bounded size).

- [ ] **Step 1: Write failing tests:**
  - `saveScreenshot`: the fake returns PNG base64; the manager writes it through a fake `BrowserShots` (records `save(chatId, name, bytes)` with `owner.chatId`) and the result has `path`, `name`, `bytes`, `width`, `height` and no `base64` key anywhere in the result; a store refusal becomes `{ok:false, code:<refusal>}`; an adapter `image_too_large` failure passes through unchanged and writes nothing.
  - `setViewport` 1440x900: the adapter's `viewports[]` records 1440x900 once; a second call with the same size does not call the adapter again; a size outside bounds is clamped by `fitBrowserViewport` and the clamped size is returned.
  - Viewer interplay: a viewer reports 800x600, the agent sets 1440x900 (adapter at 1440x900), the viewer reports 800x600 again while the agent holds the lease: the adapter stays at 1440x900; after `release` the adapter returns to 800x600; a relaunch drops the override.
  - Other ops are untouched: `screenshot`, `click` and `observe` results are byte-identical to before.

- [ ] **Step 2: Run to see them fail.** Run: `npx vitest run zumi-bot-server/backend/tests/core/browserManager.test.ts`

- [ ] **Step 3: Implement.** In `run`, after the adapter answers and before the scrub/cut: for op `saveScreenshot` take `data.base64`, decode, call `shots.save(owner.chatId, name, bytes)`, replace `data` with `{path, name, bytes, width, height}` (an error thrown with a `SHOT_REFUSALS` message becomes a failure result; any other error is logged by message only and becomes a generic `shot_failed`). `setViewport`: keep an `agentViewport` on the entry; `wantedViewport` returns it first while set; `syncViewport` applies the wanted size and keeps `entry.viewport` current; clear it in the lease-release path and in `launch`. The bridge never sees base64 for this op.

- [ ] **Step 4: Run to see them pass,** the whole browser test files, and the backend typecheck.

- [ ] **Step 5: Stage** the changed files.

---

### Task 5: Tool definitions, result shapes, prompt

**Files:**
- Modify: `B/browserTools.ts` (`definitions`, `cutBrowserResult`, `boundBrowserResult`), `B/browserLimits.ts` (`BROWSER_CUTS` keys), `B/browserPrompt.ts`
- Test: `backend/tests/core/browserBridge.test.ts`, `backend/tests/core/vaultScrub.test.ts` (cut and scrub of the style shape), `frontend/tests/toolLabel.test.ts` only if a label is added

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: four MCP tools in `browserTools`: `browser_save_screenshot` (props `name`, `ref`, `stamp`, `fullPage`; required `name`), `browser_computed_style` (`stamp`, `ref`), `browser_hover` (`stamp`, `ref`), `browser_set_viewport` (`width`, `height`); the model receives text JSON for each (never an image block for `save_screenshot`).

- [ ] **Step 1: Write failing tests:**
  - bridge: each new tool, called through the MCP `Client` against a fake manager, produces the matching `BrowserCommand` (`op` set by the bridge, a client-sent `op` rejected) and a text result; `browser_save_screenshot` returns text JSON with `path` and no image block.
  - `boundBrowserResult` passes a `computedStyle` result under 48 000 characters and returns `output_limit` over it.
  - `vaultScrub`: a style result whose `background-color` equals a saved secret is returned as `[hidden by vault]`; a value longer than the cut limit is cut (and, as for page text, nothing within `SECRET_MAX - 1` characters of a cut survives).
  - the browser prompt names the four tools in one short paragraph (assert it mentions each tool name).

- [ ] **Step 2: Run to see them fail.** Run: `npx vitest run zumi-bot-server/backend/tests/core/browserBridge.test.ts zumi-bot-server/backend/tests/core/vaultScrub.test.ts`

- [ ] **Step 3: Implement** the four `definitions` rows (descriptions in the file's terse style, schemas from Task 1's limits), add the style branch to `cutBrowserResult` using the `keep` + `trace` pattern and new `BROWSER_CUTS.style` keys (value limit 200, property count limit 40), and extend `browserPrompt` with one short paragraph: save shots with `browser_save_screenshot` and attach the returned file path (never paste it as a link), read measurements with `browser_computed_style`, `browser_hover` before shooting a hover state, `browser_set_viewport` then observe again.

- [ ] **Step 4: Run to see them pass,** `npx vitest run --project backend --project shared --project frontend`, and the three typechecks.

- [ ] **Step 5: Stage** the changed files.

---

### Task 6: Docs and end to end check

**Files:**
- Modify: `CLAUDE.md` (a short block where the agent browser or the Data folder is described: the four tools, `browser-shots/`, its exclusions and deletion)
- Modify: `e2e/vault.e2e.mjs` or `e2e/browser.e2e.mjs` (one step each for save, style, hover, viewport against the local fixture site, whichever suite already drives `browser_*` calls through the fake browser claude)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the e2e steps:** on the fixture site, `browser_set_viewport` 1000x700, `browser_observe`, `browser_hover` on a fixture element, `browser_computed_style` of it (assert a non-empty `style['background-color']`), `browser_save_screenshot` of the element (assert the returned path exists, starts with the PNG signature, mode 0600, under `<data dir>/browser-shots/<chatId>/`), and after the chat is deleted the folder is gone. Assert no result the fake received contains `base64`.
- [ ] **Step 2: Run it:** `npm run e2e:browser` and `npm run e2e:vault` (both build first; both use fakes and real Chromium, no quota). Expected: all cases pass, including the vault suite's no-secret checks.
- [ ] **Step 3: Docs.** One tight block in `CLAUDE.md`, in its existing style, no rewrites of other text.
- [ ] **Step 4: Full check:** `npm test` and the three typechecks; the known unrelated failure is the backend `app.test.ts` "fresh side base for an A to B chat" timeout.
- [ ] **Step 5: Stage** the changed files.
