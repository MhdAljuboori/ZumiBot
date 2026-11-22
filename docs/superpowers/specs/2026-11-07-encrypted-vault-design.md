# Encrypted vault for logins, cards, contacts and API keys

Date: 2026-11-07. Status: approved.

## Why

When the user sends an agent to a website to do something for them (their example: publishing a release to a dev environment), the agent hits a sign-in page. Today it can only call `browser_request_user_action`: the user gets a sign-in card, takes control of the app browser and types the password themselves. The same happens for 2FA codes, card numbers at a checkout, and any form that wants the user's address. API keys have no home at all: the user pastes them into chat (where they stay in the history and the prompt) or sets them up by hand on each machine.

The user wants to save these once, in an encrypted vault, and let chosen agents use them **without the agent ever seeing a password or a card number**. A saved card's first use on a new site must wait for the user's approval.

## Goals

1. Save four kinds of item in **Settings › Vault**: logins (with an optional 2FA secret), cards, contact details, API keys. Stored encrypted.
2. Each item lists the agents allowed to use it. None by default.
3. An allowed agent can fill a login or card field in its app browser. The server types the value; the agent only learns that it was filled. ZumiBot never sends a password, 2FA code or card number to an agent. (Agents run as the same OS user as the server, so the vault files themselves are only guarded by a speed bump; see "Guarding the vault files".)
4. A login fills only on the sites saved with it, so a lookalike page cannot get the password.
5. A card's first use on a site shows an approval card in the chat (**Allow** / **Deny**). Allow remembers that site for that card; later uses there need no card.
6. Contact details are not secret: allowed agents read them and type them like any text.
7. An API key reaches an allowed agent as an environment variable (`$AZURE_DEVOPS_EXT_PAT`), so `az`, `gh`, `curl` and other CLIs work. The value is never put in the agent's prompt, and the server scrubs it from everything it saves or shows.
8. The vault unlocks by itself after a restart (routines always work), and exists on both the PC and the VPS, joined by `npm run sync`.

## Non-goals

- A vault passphrase or manual unlock. The user chose auto-unlock.
- Filling on the computer-use desktop. Browser only for now.
- Typing an API key into a web page. API keys are env vars only.
- Passkeys/WebAuthn, CAPTCHAs, importing from other password managers, a "save this password?" prompt in the app browser.
- Per-use approval for logins, or spending limits for cards.
- More than one user. "Server owner" in the request is the signed-in user of this server.
- Usage history per item ("last used by…"). The chat's tool rows already show each fill.

## Anti-goals (a failure even if it works)

- A password, 2FA secret or code, card number, expiry, CVC or API key value appearing, through anything ZumiBot sends or stores, in an agent's prompt or tool result, a chat item, the items feed, a dispatch entry, a side answer, a log line, a notification, a URL, an error message, or Jev.
- A login filled on a site not saved with it, or a card used on a new site without the user pressing Allow.
- The vault key inside the data folder, in a sync backup folder, in a log, in argv or in any RPC.
- The prompt-cache prefix changing when the user edits the vault or its grants. Tool definitions and the system prompt stay the same for every agent whatever the vault holds.
- A vault problem (key missing, item gone) failing a turn. A fill fails with a clear code; the agent can still ask the user with `browser_request_user_action`.

## How it works

### What the vault holds

| Kind | Fields | Agent sees | Agent never sees |
|---|---|---|---|
| Login | name, sites (1–10), username, password, 2FA secret (optional) | id, name, sites, username, whether a 2FA code is available | password, 2FA secret, current code |
| Card | name, holder name, number, expiry (MM/YY), CVC | id, name, label (`Visa •4242`, brand from the number), holder name | number, expiry, CVC |
| Contact | name, full name, company, email, phone, address line 1, line 2, city, region, postal code, country | every field | — |
| API key | name, env var name, value, description (what it is for) | id, name, env var name, description | value |

The 2FA field takes a base32 secret or a pasted `otpauth://` URI; codes are made with RFC 6238 (SHA-1, 6 digits, 30 s), reusing `backend/src/auth/totp.ts`.

Caps: 500 live items; name 100 characters; username and contact fields 300; password 1 000; site 253; 2FA secret 128; API key value 8–8 000; description 300. A card number must be 12–19 digits (spaces and dashes dropped); a failed Luhn check is a warning in the editor, not a refusal.

### Storage and encryption

- **`<data>/vault.json`** (0600): `{v: 1, keyId, items: [{id, updatedAt, deleted, sealed}]}`. Only the id, the time and the deleted mark are readable; everything else of the item, its name, fields, agents and approved sites included, is in `sealed`. A deleted item is a tombstone (`deleted: true`, `sealed: null`), never pruned, because sync never deletes and a pruned item would come back from the other machine.
- **Sealing:** AES-256-GCM, a fresh 12-byte nonce per seal, `sealed = base64(nonce | ciphertext | tag)`, additional data `claudebot-vault:v1:<id>:<updatedAt>`, so an item can't be moved to another id or have its time changed without failing to open.
- **The key:** 32 random bytes, base64 in `vault.key` (0600, folder 0700). Path: `ZUMIBOT_VAULT_KEY_FILE`, else `$XDG_CONFIG_HOME/zumibot-vault/vault.key`, else `~/.config/zumibot-vault/vault.key`. The server refuses a key path inside the data folder. The key is made at the first save, not at start, so two machines that never used the vault don't make different keys. `keyId` is the first 16 hex characters of SHA-256 of `claudebot-vault-key-id` plus the key.
- **States** (`vault:status`): `empty` (no key, no items), `ready`, `keyMissing` (vault.json has live items, no key file), `keyMismatch` (key file's id differs from `keyId`). In the last two the Vault page explains it and offers **Start a new vault**, which moves `vault.json` aside as `vault.json.unreadable-<time>` (never deleted) and starts empty. Agents then list nothing and fills fail with `vault_unavailable`.
- The service reads and seals through one queue (like `ChatStore`'s per-file queue) and may keep the opened items in memory, refreshed when the file changes (sync restarts the server anyway).

### Guarding the vault files (a speed bump, by the user's choice)

Agents run as the same OS user as the server, and production always runs the CLI in auto mode (`ZUMIBOT_PERMISSION_MODE=manual` is a dev hook, ignored when `NODE_ENV=production`). So a classifier-approved `Read` or Bash call could read `vault.key` and `vault.json` and decrypt everything. The same is already true of `~/.ssh`, `gh` tokens and the CLI's own login on that machine. The user chose a speed bump plus a plain statement of the limit, not a separate OS user:

- Every main run (single chat turns, room members, routines, A→B asked runs, Zumi Bot's runs) gets, in its one merged `--settings` (through `oneSettings`, with the desktop ask rules and the pause hook), **deny rules** for `Read`, `Edit`, `MultiEdit`, `Write`, `Grep` and `Glob` on the key file's folder and on `<data>/vault.json`, in the CLI's absolute-path rule form. Settings never enter the prompt, so the cache prefix holds. Side runs keep their settings byte for byte (their guard already blocks every tool), and so does Compact.
- The same settings add a `PreToolUse` hook (matcher `Bash`), a plain shell test on the hook's stdin with no Node start, that blocks with exit 2 and a fixed text any command naming the key file's folder or `vault.json`'s path, in absolute, `~/` and `$HOME/` forms. It matches the resolved paths, not bare words like `vault.json`, so agents working on ZumiBot's own source are not blocked.
- A determined agent can still get around this through Bash (another spelling, a script). The spec, `CLAUDE.md` and the Vault page's help text say so plainly.
- **`e2e/vaultGuardProbe.mjs --soft`** runs in `npm run e2e` after the other probes, against the real CLI in auto mode with the app's settings: a `Read` of the key path must be denied and `cat <key path>` must be blocked by the hook. Same exit codes, single retry and `--soft` as `desktopAskProbe.mjs`; `ZUMIBOT_SKIP_VAULT_PROBE=1` skips it; a unit test checks its verdicts against a fake claude through `ZUMIBOT_PROBE_CLAUDE`.

### Who may use an item

- Each item holds the agent names allowed to use it. Zumi Bot can never be added (the editor leaves it out, the server refuses it).
- A grant covers the agent's runs everywhere: single chats, room member turns, routine runs, A→B asked runs. Subagents it starts inherit it (same CLI process).
- **Rename** moves the grants in memory synchronously, before the agents-folder watcher's removal pass can run (as approvals already do, or the rename would lose them), then re-seals every item naming the agent as one step of the agent-rename pipeline in `app.ts` (after approvals move, before the chats). **Delete**: agents whose file disappears are dropped from grants by the same `removed` hook that calls `approvals.forgetAgents`, with the same rule (not while some agent file fails to load), so a new agent with an old name never inherits a grant.

### What the agent gets

- **`zumibot_vault`**, a stdio MCP bridge built like `zumibot_todos` (`vaultBridge.mjs`, its own `input` in `backend/vite.config.ts`, a 0700 `/tmp/cb-v-*` socket dir, a capability token per CLI attempt bound to `{chatId, agent, turn}` and revoked when the attempt ends, `alwaysLoad: true`). One tool, `vault_items` (no arguments), returns the items granted to that agent with only the "Agent sees" fields, sorted by kind then name.
- It goes in a `--mcp-config` of **every** run of every agent (Zumi Bot included, which always lists nothing) and every `/btw` side run (blocked there by the side guard), like `zumibot_todos`, so the tool definitions never depend on grants. `ChatService` answers its permission request itself in both permission modes: no card, no stored rule, no Jev hint.
- With `--agent`, a `tools:` list limits the agent to what it names, so `AgentStore.save` adds `mcp__zumibot_vault__vault_items` to every non-empty `tools:` list (like `withTodoTools`); Zumi Bot does the same in the lists it writes. Browser tools are not added to `tools:` lists today, so `browser_fill_from_vault` follows them and is not added either.
- A fixed paragraph, `VAULT_SYSTEM`, the same for every agent, is appended to the system prompt: the user may save logins, cards, contact details and API keys for it in ZumiBot's vault; call `vault_items` to see what it may use; fill login and card fields with `browser_fill_from_vault`, never asking the user for them in chat; use an API key only through its environment variable in commands, never printing, echoing, logging or writing its value, or putting it in a reply; when nothing fits, use `browser_request_user_action` as before. `browserPrompt`'s sign-in sentence changes to try the vault first. Both are constant text, so the cache prefix changes once, when this ships, and never again because of the vault.

### Filling in the browser

A new browser tool, **`browser_fill_from_vault`** `{stamp, ref, item, field}`, in the existing `zumibot_browser` bridge (it needs the observation's stamp and refs and the turn's lease, which the browser manager already checks). `field` is one of: login `username`, `password`, `code`; card `number`, `expiry` (MM/YY), `expiryMonth` (MM), `expiryYear` (YYYY), `expiryYear2` (YY), `cvc`, `holder`; contact any of its field names. The browser manager checks the grant and the card approval; the host and element checks run in the browser worker (where the page lives) right before the fill, and again after an approval card is answered, since the page may have moved while it waited. In order:

1. Checks the item exists, is granted to the turn's agent, and has that field. Else `not_allowed` / `no_field` (the result names the item and field, never a value).
2. Takes the page host (the active tab's top-level URL) and the frame host (the URL of the frame holding the element). Both must be `https:`, or a loopback host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). Else `insecure_site`.
3. **Login:** both hosts must match the item's sites. A site `example.com` matches only that host; `*.example.com` matches any subdomain, not the apex. Hosts are compared lowercased in their punycode form. Else `wrong_site`, with the item's saved sites in the message, so the agent can tell the user.
4. **Card:** the pair (page host, frame host) must be among the card's approved sites; otherwise the approval card below runs first. Deny gives `denied` and nothing is typed.
5. Checks the element: secret fields (`password`, `code`, `number`, `expiry`, `cvc`) go only into a visible, enabled `<input>` (never a textarea or contenteditable), and `password` only into `input[type=password]`. `expiryMonth`/`expiryYear`/`expiryYear2` may also go into a `<select>` (picked by value or label, like `browser_select`). Else `wrong_field_type`.
6. Fills the value (`handle.fill`, or `selectOption`), then for a secret field on an `<input>` sets the inline style `-webkit-text-security: disc !important`, so the agent's screenshots and the live view show dots even on a plain text field.
7. Returns `{filled: true, item: <name>, field}`.

**Frames.** Card fields on most checkouts sit in a cross-origin iframe (Stripe, Adyen, Braintree), which today's observation never reaches: it queries the main frame only. `BrowserObservation.observe` therefore also collects elements from child frames (Playwright handles work across Chromium's out-of-process frames), each element carrying a `frame` host label, within the existing element and character budgets. Page text stays the main frame's. This also lets the ordinary `browser_click`/`browser_type` reach iframe fields.

**Scrubbing browser output.** Before any browser result goes back to an agent (observation text and element names, tab titles and URLs, dialog text, error messages), the browser manager replaces every vault secret value it holds, whoever it is granted to, with `[hidden by vault]`: passwords of 6+ characters, card numbers (as a digit run allowing spaces and dashes), and API key values. This is server-side, before the model sees it. Screenshots can't be scrubbed; the mask in step 6 covers filled fields, and a page that prints a full card number as text in an image is a known limit.

### Card first-use approval

- A new chat item, `{type: 'vault-approval', id, ts, agent, turn?, request: {id, itemId, itemName, label, site, frameSite, status}}`, `status` one of `pending`, `allowed`, `denied`, `interrupted`. Drawn as a card: "**@agent** wants to use **Work Visa (Visa •4242)** on **shop.example.com**", with "card form from js.stripe.com" when the frame host differs, and **Allow** / **Deny**. After an answer it reads "Allowed — remembered for shop.example.com" or "Denied".
- The fill call waits while it is pending, like a browser handoff, with no model polling. It has no expiry of its own: it ends on an answer, Stop, the turn ending or a restart (then `interrupted`). The browser lease's idle timer is suspended while it waits, as for a handoff. One pending vault approval per browser profile.
- **Allow** adds the (site, frameSite) pair to the card's approved sites (re-sealing it) and the fill continues. **Deny** remembers nothing; the next try asks again.
- It counts as waiting everywhere an approval card does: `pendingCount` (so the sidebar badge, the `approvals` push and the `waiting` notification), a routine run's `waiting` state, the A→B roll-up into A's chat and its ask card, and the room's tray. Answered through `vault:answer {chatId, requestId, decision}`. Jev never sees it.

### API keys

- Env var names must match `^[A-Z][A-Z0-9_]{1,63}$` and must not be reserved: names starting `ZUMIBOT_`, `CLAUDE_`, `ANTHROPIC_`, `NODE_`, `ELECTRON_`, `LD_`, `DYLD_`, `XDG_`, or equal to `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `PWD`, `LANG`, `TERM`, `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` (list in `shared/src/vault.ts`). Saving refuses two API keys with the same env var name granted to the same agent.
- Every main run of a granted agent (single chat turns, room member turns, routine runs, A→B asked runs) gets those env vars, read per attempt like `compactWindow`, so a grant change applies from the next attempt. Not side runs, Compact, the moderator or the room summary. Env never enters the prompt, so the cache prefix holds.
- **Scrubbing:** for such a run, every string in every parsed stream event (tool inputs and results, assistant text, subagent text and results, errors and stderr) passes through a scrubber that replaces each granted value with `[vault: <name>]` before `ChatService`, the dispatch recorder or anything else stores, pushes or logs it. Streaming text deltas keep back a short tail, so a value split across two deltas is still caught. Side runs are scrubbed with their base agent's grants. Text that reaches the server over a bridge instead of the stream (to-do adds, `ask` messages, `side_question` questions) is scrubbed with the owner agent's grants before it is stored.
- **Permission replies are not scrubbed:** `allowResponse` sends the request's input back to the CLI as `updatedInput`, so the server answers with the raw input and scrubs only the copy it stores or shows (an approved command must run with the real value, not `[vault: …]`).
- **The honest limit (accepted by the user):** in auto mode, nothing but the CLI's auto-mode classifier and the `VAULT_SYSTEM` rule stops a command from using the key wrongly, for example sending it to another host without printing it. No approval card is added for commands that use a vault variable, so routines using `az` or `gh` never wait. If a command prints the value (`echo $X`), the model sees it, and so does the CLI's own session log under `~/.claude/projects`; ZumiBot cannot change what the CLI feeds back to the model. Whole-file snapshots in the Files panel are not scrubbed (a file the agent wrote holds the key on disk anyway).

### Settings › Vault

- A new section, `vault`, at `/settings/vault`, after Notifications in `SETTINGS_SECTIONS`. Heading line: "Encrypted on this server. Agents never see passwords, codes or card numbers."
- Search and **Add** (Login, Card, Contact, API key). Items grouped by kind; each row shows the name, a second line (login: username · sites; card: `Visa •4242` · holder; contact: email; API key: `$ENV`) and how many agents may use it.
- Opening an item shows its form. Secret fields are masked and empty on open; **Show** fetches the one value with `vault:reveal` and **Copy** copies it; leaving a secret field blank on save keeps the stored value. A login's 2FA field can show the current code on Show. **Agents that can use this** is a multi-select of loadable agents (Zumi Bot left out). A card lists its **Approved sites** (site, and frame host when different) with remove. **Delete** asks first ("Delete Work Visa? Agents lose access. This can't be undone.").
- `keyMissing` / `keyMismatch` replace the list with the explanation, the key path, and **Start a new vault**.
- Saving goes through the unsaved-changes guard like the other sections. Works on a phone.
- RPCs: `vault:status`, `vault:list` (no secrets: safe fields, `hasPassword`, `hasCode`, label, agents, approved sites, `updatedAt`), `vault:reveal {id, field}` (one value; 30 a minute; never logged), `vault:save {item, updatedAt?}` (a stale `updatedAt` is refused with `VAULT_CHANGED`, like `MEMORY_CHANGED`), `vault:delete {id}`, `vault:removeApproval {id, site, frameSite}`, `vault:reset`, `vault:answer`. `vault:changed` is broadcast with no payload. The UI never receives a secret except from `vault:reveal`.

### In the chat

- A `browser_fill_from_vault` row reads "Filled from vault · Work Visa · card number" (its stored input keeps only `{item: <name>, field}`; the result stays the fixed "Browser command completed./failed." line, with the failure code's text: wrong site, denied, …).
- A `vault_items` row reads "Checked the vault (3 items)"; its stored result keeps only the item names.
- The approval card as above.

### Sync

- `vault.json` is joined by item id in `sync.mjs` (not newest-wins as a whole file): the later `updatedAt` wins, tombstones included, so a delete stays deleted; on a tie the tombstone wins, then the VPS. Merging needs no key, since only ids and times are compared. Replaced copies go to the backup folder as usual (they are encrypted).
- **The key:** sync reads the local key from the local path rule and the VPS key over ssh from `VPS_VAULT_KEY_FILE` (in `deploy.env`/`sync.env`; default the VPS user's `~/.config/zumibot-vault/vault.key`). Key bytes travel over ssh stdin/stdout only, never argv, never logged, never into a backup folder.
  - Neither side has a key: nothing to do.
  - One side has it: copy it to the other (0600, folder 0700).
  - Same `keyId`: merge.
  - A side whose `vault.json` `keyId` doesn't match that side's own key (`keyMissing`/`keyMismatch` there): the vault is left untouched on both sides and the sync reports it; nothing sealed under different keys is ever merged.
  - Different keys: the VPS key wins. Every local item is opened with the local key and re-sealed under the VPS key, then merged; the local key file is then replaced, the old one kept beside it as `vault.key.replaced-<time>` (0600).
- The re-seal code lives in an `.mjs` the desktop shell's build copies into `resources/sync` with the rest.
- Card approvals are inside the item, so an approval given on the VPS counts on the PC. An approval and an edit made to the same item on both sides before a sync: the later one wins whole (rare; accepted).

### Other paths

- **Fork / Clone room:** the vault is global; `vault-approval` items copy as history, a pending one reads `interrupted` in the copy.
- **Notifications:** only through the existing `waiting` push; payload unchanged (chat title only).
- **Pause:** a fill is a main-thread tool call; the pause hook blocks new ones like any other.
- **Logs:** only item ids and codes; never values, names or hosts.
- **Local mode** works the same, with its own key at the same default path.
- `CLAUDE.md` gets a Vault paragraph, and Data lists `vault.json` and the key path; `SETUP-VPS.md` says to back up the key file.

## Testing

- Unit (shared/backend): seal/open, a tampered id, time or byte fails to open, `keyId`, the four states, site matching (exact, `*.`, punycode, loopback, http refused), element rules, env name rules, the event scrubber and browser output scrubber, card brand and last 4, TOTP codes, grant rename/removal, the `sync.mjs` merge (by id, tombstones, ties) and re-seal under the VPS key.
- Backend: RPCs never return secrets except `vault:reveal`; approval lifecycle (allow remembers, deny, Stop, turn end, restart → interrupted); `pendingCount` and routine `waiting` include it; env reaches only main runs of granted agents.
- **`npm run e2e:vault`** with the fake claude and real Chromium against local fixture sites (a login page on `127.0.0.1`, a checkout on `localhost` whose card form is an iframe on `127.0.0.1`, so the hosts differ): fill a login, refused on a non-matching host, the approval card's Allow and Deny, screenshot shows dots, no secret in any tool result the fake receives, in the chat JSON or in the server log; an API key reaches the fake's Bash env and is scrubbed in the stored items. Costs no quota. The harness sets `ZUMIBOT_VAULT_KEY_FILE` to a temp path.
- `e2e:sync`: two temp homes, key copy one way, mismatched keys re-sealed, merged vault opens on both sides.

## Decided by the user

- The four kinds: logins, cards, contact details, API keys.
- Passwords and card numbers are never shown to agents.
- A saved card's first use on a site needs the user's approval.
- The vault unlocks by itself after a restart, with the key in a file kept outside the data folder (no passphrase).
- The vault exists on both the PC and the VPS, joined by sync.
- Access is chosen per item, no agents by default.
- API keys: the builder's choice; the user accepted env vars with server-side scrubbing and the stated limit.
- Vault files: a speed bump (deny rules plus a Bash hook, with a real-CLI probe) and a plain statement that a determined agent on the same OS user can still reach them; no separate OS user.
- API key use: no approval card; the auto-mode classifier and the prompt rule are the guard, so routines never wait for a key.
- The approver is the signed-in user; 2FA secrets in logins, browser only, a Settings › Vault page (proposed, not objected to).

## Builder's calls (made while writing this; open to change)

1. A card's expiry and CVC are hidden from agents too, not only the number.
2. A card approval is remembered per (page host, card-form frame host) pair, so an ad iframe on an approved shop can't take the card.
3. A login fills only when both the page and the frame holding the field match its sites, on https or loopback.
4. A password goes only into `input[type=password]`, and every secret fill is masked with `-webkit-text-security`.
5. Observation reaches into child frames, needed for card forms.
6. All browser output is scrubbed of every vault secret before the agent sees it.
7. Listing goes through a new `zumibot_vault` bridge in every run plus a constant prompt paragraph, rather than per-agent prompt text, to keep the cache prefix.
8. API keys go only to main runs; values under 8 characters are refused; a reserved-name list.
9. Key path `~/.config/zumibot-vault/vault.key`; on mismatched keys the VPS key wins.
10. Delete is a tombstone with a confirm, no Undo toast or Trash.
11. Show/Copy of a secret in Settings needs no extra sign-in (the page is already behind sign-in and 2FA on the VPS).
12. Contact fields are also fillable with `browser_fill_from_vault`.
13. No notes field on items (it would be unclear whether agents see it).
14. Host and element checks run in the browser worker, repeated after an approval card.
15. Permission replies send the raw input back; only stored and shown copies are scrubbed.
16. Scrubbing also covers split streaming deltas, side runs, and text arriving over the to-do and ask bridges.
17. Sync leaves the vault untouched on both sides when either side's file doesn't match its own key.
18. `vault_items` and `browser_fill_from_vault` are added to non-empty `tools:` lists.
19. The Bash hook matches resolved paths only, so work on ZumiBot's own source isn't blocked.

## Left to the builder

- Module layout (`core/vault/`, `shared/src/vault.ts`), RPC argument checks, the editor's exact look within the Settings style.
- Where the event scrubber hooks in (one place every run's parsed events pass through).
- How the observation labels frames and spends its budget across them.
- The exact text of `VAULT_SYSTEM` and of each refusal, keeping them short and free of values.
