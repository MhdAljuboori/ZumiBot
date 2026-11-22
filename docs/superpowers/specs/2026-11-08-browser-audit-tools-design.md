# Agent browser audit tools

Four tools added to the agent browser (`zumibot_browser`) so an agent can audit a web UI with a Vault login: save a
screenshot as a file, read an element's computed style, hover, and set the window size.

## Why

The W5 design audit workflow (`2026-11-08-w5-design-audit-workflow-design.md`) first used Playwright scripts run through
Bash. Those cannot use a Vault *login* (only a Vault API key reaches Bash, as an environment variable), and the user
wants the audit to sign in with the Vault login "E2e Workspace" through the agent browser, where ZumiBot types the
password itself and the agent never sees it. The agent browser cannot yet do what the audit needs:

- `browser_screenshot` returns a JPEG to the model only. ZumiBot never writes it to disk, and the audit's cards attach
  design and product image **files**.
- Nothing reads computed colours, sizes, paddings or radii; the findings quote measured values.
- There is no hover; many findings are hover states.
- The window size is owned by the manager (1280x800 by default or a viewer's size); the audit compares at 1440x900.

## Goals

- Four new tools, each shaped like the existing ones (a stamp and a ref where it acts on an element), for every agent.
- Evidence files that an agent can read and attach: PNG, written under the data dir, per chat.
- No new way to learn a Vault secret: all text results go through the existing scrub and cut; vault-filled fields are
  still masked in a screenshot.
- Nothing synced to another machine, nothing left behind after a chat is deleted.

## Non-goals

- Key presses, right-click, drag, JavaScript evaluation. Menus are opened by clicking and closed by clicking elsewhere.
- Video, GIFs, PDF, full-page stitching beyond Playwright's own `fullPage`.
- Changing the existing `browser_screenshot` (still an inline JPEG).
- A UI to browse saved shots.
- Saving files outside the shots folder.

## The tools

All four are ordinary browser tools: a new `BrowserCommand` op, one `definitions` row in `browserTools.ts`, parsed and
bounded like their neighbours. Names below are the tool names; ops are camelCase.

### `browser_save_screenshot` (`saveScreenshot`)
Input: `name` (required), `ref` + `stamp` (both or neither), `fullPage` (boolean, default false, page only).
- `name`: `[a-z0-9][a-z0-9_-]{0,63}`. The file is `<name>.png`; the same name overwrites (a re-shoot replaces).
- No `ref`: the active page's visible viewport (or the whole page with `fullPage`). With `ref`: that element only
  (Playwright element screenshot, with an explicit timeout, since the context default of 0 would hang until the browser
  is killed).
- PNG, CSS pixels (`scale: 'css'`). Larger than 5 MiB: fails with `image_too_large` and a message to crop to an element.
- The worker returns the PNG as base64 with its pixel size; the **manager** writes the file and replaces the bytes with
  `{path, name, bytes, width, height}` before the IPC bounds the result (the IPC would otherwise drop PNG bytes: only
  `image/jpeg` is passed through).
- Per chat: at most 200 files (`too_many_shots` beyond; overwriting an existing name is allowed).
- Where: `<data dir>/browser-shots/<chatId>/<name>.png`, folders 0700 and files 0600 (the SnapshotStore pattern, a new
  `BrowserShots` store). The path is returned in full so the agent can read it or attach it with the Workiom CLI.
- Deleted with the chat (`chats:remove`). Not copied by Fork, not copied by Clone room, never synced (`browser-shots/`
  joins `desktops/` and `claude-tmp/` in the sync exclusions, on the push, the pull and the backup lists).

### `browser_computed_style` (`computedStyle`)
Input: `stamp`, `ref`. Returns `{style, rect}`: a fixed list of CSS properties as the browser computes them, and the
element's box (`x, y, width, height`, CSS pixels).
- Properties (fixed in code, not chosen by the agent): color, background-color, opacity, font-family, font-size,
  font-weight, font-style, line-height, letter-spacing, text-transform, text-align, padding and margin (four sides each),
  border width, style and colour (four sides each), border-radius (four corners), box-shadow, gap, display, width, height.
- Each value is cut at 200 characters in the worker (plus the scrub margin), then scrubbed and cut again on the server
  exactly like page text (`cutBrowserResult` gets a branch for this shape; new `BROWSER_CUTS` keys).
- Reads the element's own computed style only; no pseudo-elements, no stylesheet text.

### `browser_hover` (`hover`)
Input: `stamp`, `ref`. Moves the pointer onto the element (`handle.hover` with an explicit timeout), so hover styles and
tooltips can be shot and measured. Returns `{hovered: true}`. A page dialog opened by the hover is handled by the
existing `dialog_pending` guard. The hover may not survive the next `observe`; the agent hovers, then shoots or reads.

### `browser_set_viewport` (`setViewport`)
Input: `width`, `height` (integers). Bounded by `fitBrowserViewport` (240x200 up to 1920x1080).
- It goes through the **manager**, which owns the size (`wantedViewport`, `syncViewport`, `entry.viewport`): the agent's
  size is an override held on the entry while the agent holds the lease, that wins over a viewer's size and the default,
  and is dropped when the lease is released or the browser relaunches. Applying it straight on the instance would leave
  the manager's copy out of date and skip a later same-size viewer event.
- Refs stay valid (the page is not reloaded) but layout changes, so the agent observes again.
- Screenshots stay in CSS pixels, so a 1440 wide viewport gives 1440 wide images regardless of the device scale.

## Safety

- Same exposure as today: the model already sees page screenshots inline. A saved PNG is that same image on disk for the
  same OS user. Vault-filled fields carry `-webkit-text-security: disc` inline, so they are dots in a saved shot too.
  Other secrets on a page are not scrubbed from pixels (accepted, as for the inline screenshot).
- File names are validated and never paths; the store builds `<root>/<chatId>/<name>.png` itself and refuses anything else.
- Text results (`computed_style`, `rect`, failures) are scrubbed by the generic walker; no secret value or password reaches
  a log or an error.
- Permission cards: browser tools are matched by prefix, so the new tools get a card in manual mode exactly like
  `observe`/`click` do, with input stored as `{}`. Nothing else in permissions changes.
- The browser prompt gains a short paragraph naming the new tools. That changes the appended system prompt once (one cache
  rebuild for every agent that uses the browser).

## Where it changes

shared `browser.ts` (ops, parser, limits); `browserTools.ts`, `browserLimits.ts`, `chromiumAdapter.ts`,
`browserManager.ts`, `browserApplication.ts`, `browserPrompt.ts`, a new `browserShots.ts` store; `app.ts` and
`rpc/handlers.ts` (`chats:remove`); `deploy/sync.mjs` (exclusions); the test fake `tests/support/fakeBrowser.ts`; tests in
shared, backend (parser, bridge, manager, real Chromium adapter, store, sync, handlers); `CLAUDE.md`.

## Success

An agent with a Vault login can sign in to `http://localhost:4200`, set 1440x900, hover a row, save `row-hover-product.png`
and read the row's computed background, and a workflow step can attach that PNG to a Workiom card; none of it leaves a
trace after the chat is deleted, none of it reaches the other machine, and no secret value appears in any result.

## Calls I made (check these)

- PNG for saved shots (lossless, for measurement and design comparison); the inline screenshot stays JPEG.
- 5 MiB per file, 200 files per chat, names `[a-z0-9][a-z0-9_-]{0,63}`.
- The manager writes the files, not the worker, so the folder is only ever touched by the server.
- The agent's viewport override lasts for its lease and wins over a viewer.
- No startup sweep of orphan shot folders (none exists for snapshots or attachments either).
- A fixed property list for computed style instead of "any property".
