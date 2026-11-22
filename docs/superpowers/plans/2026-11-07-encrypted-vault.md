# Encrypted Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **User rule:** never `git commit` unless the user says so. Each task ends with a **Checkpoint** step (typecheck + the task's tests green) instead of a commit.

**Goal:** An encrypted vault in Settings for logins, cards, contacts and API keys that chosen agents use without ZumiBot ever sending them a password, 2FA code or card number.

**Architecture:** `VaultStore` keeps `<data>/vault.json` (items sealed one by one with AES-256-GCM) and a key file outside the data folder. Agents list their items through a new `zumibot_vault` stdio bridge, fill login/card fields through a new `browser_fill_from_vault` browser tool whose value the browser worker types itself, and get API keys as env vars that the server scrubs from everything it stores. A card's first use on a site waits on a `vault-approval` chat card.

**Tech Stack:** Node 22 `node:crypto`, TypeScript, Playwright (`playwright-core`) in the browser worker, MCP SDK stdio bridge, React 19, vitest, `playwright-core` e2e.

**Spec:** `docs/superpowers/specs/2026-11-07-encrypted-vault-design.md` (read it with this plan; the plan argues from it).

## Global Constraints

- Sealing: AES-256-GCM, fresh 12-byte nonce, `sealed = base64(nonce | ciphertext | tag)`, additional data `claudebot-vault:v1:<id>:<updatedAt>`.
- `vault.json` (0600): `{v: 1, keyId, items: [{id, updatedAt, deleted, sealed}]}`; tombstone = `deleted: true, sealed: null`, never pruned.
- Key: 32 random bytes, base64 in `vault.key` (0600, folder 0700). Path: `ZUMIBOT_VAULT_KEY_FILE`, else `$XDG_CONFIG_HOME/zumibot-vault/vault.key`, else `~/.config/zumibot-vault/vault.key`. Refused inside the data folder. Made at the first save only.
- `keyId` = first 16 hex of SHA-256(`claudebot-vault-key-id` + key bytes).
- Status: `empty | ready | keyMissing | keyMismatch`.
- Caps: 500 live items; name 100; username and contact fields 300; password 1 000; site 253; sites 1–10; 2FA secret 128; API key value 8–8 000; description 300; card number 12–19 digits after dropping spaces and dashes (Luhn failure is a warning only).
- TOTP: RFC 6238, SHA-1, 6 digits, 30 s.
- Env names: `^[A-Z][A-Z0-9_]{1,63}$`; reserved prefixes `ZUMIBOT_`, `CLAUDE_`, `ANTHROPIC_`, `NODE_`, `ELECTRON_`, `LD_`, `DYLD_`, `XDG_`; reserved names `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `PWD`, `LANG`, `TERM`, `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`.
- Fill fields: login `username|password|code`; card `number|expiry|expiryMonth|expiryYear|expiryYear2|cvc|holder`; contact `fullName|company|email|phone|line1|line2|city|region|postalCode|country`. Secret fields: `password|code|number|expiry|cvc`.
- Hosts must be `https:` or loopback (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). Site `example.com` = exact host; `*.example.com` = any subdomain, not the apex; lowercased punycode.
- Browser scrub replacement: `[hidden by vault]`. Run scrub replacement: `[vault: <name>]`. Passwords scrubbed from 6 characters; API keys always (min 8).
- `vault:reveal`: 30 a minute, never logged.
- Never log values, item names or hosts: only item ids and codes.
- Zumi Bot (`ZUMI_BOT_NAME`) can never be granted an item.
- `VAULT_SYSTEM` and `browserPrompt` are constant text, so the cache prefix never depends on the vault.
- Every e2e and backend test that starts a server sets `ZUMIBOT_VAULT_KEY_FILE` to a temp path; nothing may touch the real `~/.config/zumibot-vault`.

## Review Focus

1. An item deleted, or the agent's grant removed, while its approval card waits → Allow must not fill; the fill ends `not_allowed`. (Task 9, `refuses a fill whose grant was removed while its approval waited`.)
2. The page navigates to another host while an approval card waits → the worker re-checks hosts after Allow and asks again for the new pair or fails `wrong_site`. (Task 9, `rechecks hosts after an approval`.)
3. A site typed as a URL or with odd casing (`https://Dev.Azure.com/org/`, `Example.COM.`, `bücher.de`) → stored as the bare lowercased punycode host. (Task 1, `normalizes pasted URLs, case, trailing dots and IDN`.)
4. A secret with regex characters, or a password under 6 characters → scrubbing is literal, never a regex built from the value; short passwords are left alone instead of blanking common text. (Task 5, `scrubs literally`; Task 2, `secrets() skips passwords under 6 characters`.)
5. A corrupt `vault.json` (bad JSON, unknown `v`, a key that no longer opens it) → status `keyMismatch`, saves refused with `VAULT_UNAVAILABLE`, the file never overwritten until **Start a new vault**. (Task 2, `never overwrites an unreadable vault`.)

---

### Task 1: Shared vault types and pure rules

**Files:**
- Create: `zumi-bot-server/shared/src/vault.ts`
- Test: `zumi-bot-server/shared/tests/vault.test.ts`

**Interfaces:**
- Produces (all exported from `@zumibot/shared/vault`):
  - `type VaultKind = 'login' | 'card' | 'contact' | 'apiKey'`
  - `const CONTACT_FIELDS = ['fullName','company','email','phone','line1','line2','city','region','postalCode','country'] as const`, `type ContactField`
  - `interface VaultApproval { site: string; frameSite: string; at: number }`
  - `type VaultItem = { id: string; updatedAt: number; name: string; agents: string[] } & ({ kind: 'login'; sites: string[]; username: string; password: string; totp: string | null } | { kind: 'card'; holder: string; number: string; expiry: string; cvc: string; approved: VaultApproval[] } | ({ kind: 'contact' } & Record<ContactField, string>) | { kind: 'apiKey'; env: string; value: string; description: string })`
  - `type VaultInput` = `VaultItem` without `updatedAt`/`approved`, `id` optional, secret fields (`password`, `totp`, `number`, `expiry`, `cvc`, `value`) optional (absent = keep stored).
  - `type VaultListItem` (UI view: no secret, plus `hasPassword`, `hasCode`, `label`, `approved`, `hasValue`) and `type VaultAgentItem` (agent view per spec table), with `listView(item: VaultItem): VaultListItem` and `agentView(item: VaultItem): VaultAgentItem`.
  - `type VaultStatus = 'empty' | 'ready' | 'keyMissing' | 'keyMismatch'`
  - `type VaultFillField`, `const FILL_FIELDS: Record<VaultKind, readonly VaultFillField[]>`, `const SECRET_FIELDS: ReadonlySet<VaultFillField>`
  - `interface VaultApprovalRequest { id: string; chatId: string; turnId: string; profileId: string; itemId: string; itemName: string; label: string; site: string; frameSite: string; status: 'pending' | 'allowed' | 'denied' | 'interrupted' }`
  - `normalizeSite(input: string): string | null`, `siteMatches(site: string, host: string): boolean`, `secureHost(url: string): string | null`
  - `cardDigits(number: string): string | null`, `cardBrand(digits: string): 'Visa' | 'Mastercard' | 'Amex' | 'Discover' | 'Card'`, `cardLabel(digits: string): string` (`Visa •4242`), `luhnOk(digits: string): boolean`
  - `totpSecretOf(input: string): string | null` (base32, or the `secret` of an `otpauth://totp/` URI; uppercased, spaces dropped)
  - `envNameError(name: string): string | null`
  - `vaultInputError(input: VaultInput, others: readonly VaultItem[]): string | null` (caps from Global Constraints; env clash = another apiKey with the same `env` sharing any agent; Zumi Bot in `agents`)
  - `withVaultTools(tools: string[] | null): string[] | null` adding `mcp__zumibot_vault__vault_items` (same contract as `withTodoTools`)
  - Constants: `VAULT_MAX_ITEMS = 500`, `VAULT_TOOL = 'mcp__zumibot_vault__vault_items'`, `FILL_TOOL = 'mcp__zumibot_browser__browser_fill_from_vault'`.

- [ ] **Step 1: Write the failing tests** in `shared/tests/vault.test.ts`:

```ts
it('normalizes pasted URLs, case, trailing dots and IDN', () => {
  expect(normalizeSite('https://Dev.Azure.com/org/')).toBe('dev.azure.com')
  expect(normalizeSite('Example.COM.')).toBe('example.com')
  expect(normalizeSite('bücher.de')).toBe('xn--bcher-kva.de')
  expect(normalizeSite('*.Example.com')).toBe('*.example.com')
  expect(normalizeSite('ex ample.com')).toBeNull()
})
it('matches exact hosts and wildcard subdomains but not the apex', () => {
  expect(siteMatches('example.com', 'example.com')).toBe(true)
  expect(siteMatches('example.com', 'www.example.com')).toBe(false)
  expect(siteMatches('*.example.com', 'a.b.example.com')).toBe(true)
  expect(siteMatches('*.example.com', 'example.com')).toBe(false)
  expect(siteMatches('*.example.com', 'badexample.com')).toBe(false)
})
it('accepts https and loopback hosts only', () => {
  expect(secureHost('https://shop.example.com/pay')).toBe('shop.example.com')
  expect(secureHost('http://127.0.0.1:4000/')).toBe('127.0.0.1')
  expect(secureHost('http://app.localhost/')).toBe('app.localhost')
  expect(secureHost('http://shop.example.com/')).toBeNull()
  expect(secureHost('about:blank')).toBeNull()
})
it('reads card digits, brand, label and Luhn', () => {
  expect(cardDigits('4242 4242-4242 4242')).toBe('4242424242424242')
  expect(cardDigits('1234')).toBeNull()
  expect(cardLabel('4242424242424242')).toBe('Visa •4242')
  expect(cardBrand('378282246310005')).toBe('Amex')
  expect(luhnOk('4242424242424241')).toBe(false)
})
it('refuses bad and reserved env names', () => {
  expect(envNameError('AZURE_DEVOPS_EXT_PAT')).toBeNull()
  for (const n of ['path', '1ABC', 'ZUMIBOT_X', 'ANTHROPIC_API_KEY', 'HOME', 'XDG_DATA_HOME']) expect(envNameError(n)).not.toBeNull()
})
it('reads a TOTP secret from base32 or an otpauth URI', () => {
  expect(totpSecretOf('jbsw y3dp ehpk 3pxp')).toBe('JBSWY3DPEHPK3PXP')
  expect(totpSecretOf('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=y')).toBe('JBSWY3DPEHPK3PXP')
  expect(totpSecretOf('not base32!')).toBeNull()
})
it('refuses Zumi Bot, caps, and an env var two keys give one agent', () => {
  const key = (env: string, agents: string[]): VaultInput => ({ kind: 'apiKey', name: 'K', env, value: 'x'.repeat(8), description: '', agents })
  expect(vaultInputError(key('GH_TOKEN', [ZUMI_BOT_NAME]), [])).not.toBeNull()
  expect(vaultInputError({ ...key('GH_TOKEN', []), value: 'short' }, [])).not.toBeNull()
  expect(vaultInputError({ ...key('GH_TOKEN', []), name: 'n'.repeat(101) }, [])).not.toBeNull()
  const other = { ...key('GH_TOKEN', ['a']), id: 'o', updatedAt: 1 } as VaultItem
  expect(vaultInputError(key('GH_TOKEN', ['a', 'b']), [other])).not.toBeNull()
  expect(vaultInputError(key('GH_TOKEN', ['b']), [other])).toBeNull()
})
it('shows agents no secret', () => {
  for (const item of [login, card, contact, apiKey]) {
    const view = JSON.stringify(agentView(item))
    for (const secret of ['hunter22', '4242424242424242', '12/30', '123', 'JBSWY3DPEHPK3PXP', 'sk-test-12345678']) expect(view).not.toContain(secret)
  }
  expect(agentView(card)).toMatchObject({ label: 'Visa •4242', holder: 'Ada Lovelace' })
})
```

- [ ] **Step 2: Run** `npx vitest run --project shared shared/tests/vault.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `shared/src/vault.ts`.** No `node:` imports (the frontend imports it). `normalizeSite` uses `new URL('https://' + host).hostname` for punycode after stripping a scheme, path, port and trailing dot; it keeps a leading `*.`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck` passes.

---

### Task 2: Key file, sealing and `VaultStore`

**Files:**
- Create: `zumi-bot-server/backend/src/core/vault/vaultCrypto.ts`, `zumi-bot-server/backend/src/core/vault/vaultStore.ts`
- Modify: `zumi-bot-server/backend/src/config.ts` (add `vaultKeyFile`)
- Test: `zumi-bot-server/backend/tests/core/vaultCrypto.test.ts`, `zumi-bot-server/backend/tests/core/vaultStore.test.ts`, `zumi-bot-server/backend/tests/config.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `validate`/`view` helpers.
- Produces:
  - `config.vaultKeyFile: string` (`resolveVaultKeyFile(env, home, dataDir): string`, throws naming `ZUMIBOT_VAULT_KEY_FILE` when relative or inside `dataDir`).
  - `vaultCrypto.ts`: `newKey(): Buffer`, `keyIdOf(key: Buffer): string`, `seal(key: Buffer, id: string, updatedAt: number, body: unknown): string`, `open(key: Buffer, id: string, updatedAt: number, sealed: string): unknown` (throws on any tamper), `readKey(path: string): Promise<Buffer | null>`, `writeKey(path: string, key: Buffer): Promise<void>` (folder 0700, file 0600, exclusive create).
  - `class VaultStore` with `constructor(o: { dataDir: string; keyFile: string; now?: () => number; newId?: () => string })` and:
    - `load(): Promise<void>`; `status(): VaultStatus`
    - `list(): VaultItem[]`; `get(id: string): VaultItem | null`; `grantedTo(agent: string): VaultItem[]`; `agents(): string[]`
    - `save(input: VaultInput, updatedAt?: number): Promise<VaultItem>` — errors `VAULT_CHANGED` (stale), `VAULT_UNAVAILABLE` (not `empty`/`ready`), `VAULT_FULL`, or `vaultInputError`'s text
    - `delete(id: string): Promise<void>`; `addApproval(id: string, site: string, frameSite: string): Promise<void>`; `removeApproval(id, site, frameSite): Promise<void>`
    - `reset(): Promise<void>` (renames `vault.json` to `vault.json.unreadable-<stamp>`, status `empty`)
    - `renameAgent(from: string, to: string): Promise<void>` (memory updated before the first `await`), `forgetAgents(names: readonly string[]): Promise<void>`
    - `secrets(): { values: string[]; cards: string[] }` (passwords ≥ 6 chars, API key values, card digit strings)
    - `onChange(cb: () => void): () => void`
  - All writes go through one promise queue; `vault.json` written with `writeFileAtomic` mode 0600; every write bumps the item's `updatedAt` and re-seals.

- [ ] **Step 1: Write failing tests.**
  - `vaultCrypto.test.ts`: `opens what it sealed`; `fails to open after the id, updatedAt or one byte changed`; `keyIdOf is stable and 16 hex`; `writeKey makes 0700/0600 and refuses to overwrite`.
  - `config.test.ts`: `vaultKeyFile defaults to XDG_CONFIG_HOME then ~/.config`; `refuses a vault key inside the data dir` (message contains `ZUMIBOT_VAULT_KEY_FILE`, not the path value).
  - `vaultStore.test.ts`:
    - `is empty with no key and makes the key at the first save` (no key file after `load()`; key file exists after `save`)
    - `keeps stored secrets when an input leaves them out`
    - `refuses a stale save with VAULT_CHANGED`
    - `deletes as a tombstone` (file item `{deleted: true, sealed: null}`, `list()` lacks it)
    - `reports keyMissing and keyMismatch and refuses saves` 
    - `never overwrites an unreadable vault` (write `{` to `vault.json` → status `keyMismatch`; `save` rejects `VAULT_UNAVAILABLE`; file bytes unchanged; `reset()` moves it aside and status becomes `empty`)
    - `moves grants on rename synchronously` (call `renameAgent` without awaiting, then `grantedTo('new')` already returns the item)
    - `forgets removed agents`
    - `writes only ids, times and sealed blobs` (raw `vault.json` text contains no item name, username, password or card number)
    - `secrets() skips passwords under 6 characters`
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/core/vaultCrypto.test.ts backend/tests/core/vaultStore.test.ts backend/tests/config.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `config.ts` `vaultKeyFile`, `vaultCrypto.ts`, `vaultStore.ts`. An unknown `v`, bad JSON or a `keyId` that differs from the key file's is `keyMismatch`; live items with no key file is `keyMissing`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 3: Vault RPCs, API and server wiring

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.vault`), `zumi-bot-server/backend/src/rpc/handlers.ts`, `zumi-bot-server/frontend/src/net/api.ts`, `zumi-bot-server/backend/src/app.ts`
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts` (or a new `backend/tests/rpc/vaultHandlers.test.ts` if handlers tests are split that way)

**Interfaces:**
- Consumes: `VaultStore` (Task 2), Task 1 views.
- Produces:
  - `ZumiBotApi.vault: { status(): Promise<VaultStatus>; list(): Promise<VaultListItem[]>; reveal(id: string, field: 'password' | 'totp' | 'code' | 'number' | 'expiry' | 'cvc' | 'value'): Promise<string>; save(input: VaultInput, updatedAt?: number): Promise<VaultListItem>; delete(id: string): Promise<void>; removeApproval(id: string, site: string, frameSite: string): Promise<void>; reset(): Promise<void>; answer(chatId: string, requestId: string, decision: 'allow' | 'deny'): Promise<void> }` and event `vault:changed` (no payload), mapped in `api.ts` like `jev`/`voice`.
  - Handlers `vault:status|list|reveal|save|delete|removeApproval|reset` (`vault:answer` lands in Task 8). `reveal` with `code` returns the current TOTP code (reusing `backend/src/auth/totp.ts`); limited by `createLimiter` to 30 a minute.
  - `save` refuses agent names that are not loadable agents (`agents.list()`), and Zumi Bot.
  - `app.ts`: `const vault = new VaultStore({ dataDir, keyFile: config.vaultKeyFile })`, `await vault.load()` before services; in `renameAgent` add `await vault.renameAgent(from, to)` right after `approvals.renameAgent`; `removed` also `await vault.forgetAgents(names)`; `remembered` also spreads `vault.agents()`; `vault.onChange(() => hub.broadcast({ event: 'vault:changed', payload: null }))`.

- [ ] **Step 1: Write failing tests:** `vault:list never returns a secret` (JSON of the list contains no password, number, cvc, expiry, value, totp); `vault:reveal returns one value and is rate limited after 30`; `vault:save refuses Zumi Bot and unknown agents`; `vault:save checks every argument` (non-object input, bad kind, non-number `updatedAt` → error); `rename pipeline moves vault grants` (in `backend/tests/app.test.ts` if it already drives `renameAgent`, else via `agentsSync.test.ts` with a stub vault).
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/rpc` — Expected: FAIL.
- [ ] **Step 3: Implement** the API contract, handlers, mapping and wiring.
- [ ] **Step 4: Run** `npx vitest run --project backend backend/tests/rpc backend/tests/app.test.ts backend/tests/core/agentsSync.test.ts` — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 4: `zumibot_vault` bridge and the agent-facing prompt

**Files:**
- Create: `zumi-bot-server/backend/src/core/vault/vaultTools.ts`, `vaultIpc.ts`, `vaultBridge.ts`, `vaultPrompt.ts`
- Modify: `zumi-bot-server/backend/vite.config.ts` (input `vaultBridge`), `zumi-bot-server/backend/src/core/browser/browserRuntime.ts` (`vaultBridgeEntry`, checked in the access list), `zumi-bot-server/backend/src/core/chat/chatService.ts`, `zumi-bot-server/backend/src/core/agents/agentStore.ts`, `zumi-bot-server/backend/src/core/agents/zumiBot.ts`, `zumi-bot-server/backend/src/app.ts`, `zumi-bot-server/shared/src/toolSummary.ts`
- Test: `backend/tests/core/vaultIpc.test.ts`, `backend/tests/core/vaultBridge.test.ts`, `backend/tests/core/chatService.test.ts`, `backend/tests/core/agentStore.test.ts`, `backend/tests/browserPackaging.test.ts`, `shared/tests/toolSummary.test.ts` (or wherever tool summaries are tested)

**Interfaces:**
- Consumes: `VaultStore.grantedTo`, `agentView`, `withVaultTools`, `VAULT_TOOL`.
- Produces:
  - `serveVaultIpc(o: { items: (agent: string) => VaultAgentItem[]; socketPath?: string; runtime?: Runtime }): Promise<{ socketPath: string; createVaultTurn(owner: VaultOwner): VaultTurn; close(): Promise<void> }>` — same framing, limits, 0700 `/tmp/cb-v-*` dir, auth line, and `alwaysLoad: true` config as `serveTodoIpc`; env `ZUMIBOT_VAULT_CAPABILITY`, `ZUMIBOT_VAULT_IPC` via `${…}` placeholders.
  - `interface VaultOwner { chatId: string; agent: () => string; turn: string }`, `interface VaultTurn { args: string[]; env: NodeJS.ProcessEnv; dispose(): void }`
  - Tool: `vault_items`, no arguments (exact empty object), returns `JSON.stringify(items)`.
  - `VAULT_SYSTEM: string` (constant; the spec's "What the agent gets" paragraph, no values).
  - `ChatServiceDeps.vaultTurns?: { create(owner: VaultOwner): VaultTurn }`; `ChatService` creates one per attempt for every run (like `todoTurn`), adds its env values to the `browser` `PRIVATE_ENV` list, answers `mcp__zumibot_vault__*` permission requests itself (`ownVault`, like `ownTodo`), appends `VAULT_SYSTEM` after `TODO_SYSTEM` when `vaultTurns` is set, and `sideBrowser` joins the vault bridge for side runs in the same `--mcp-config` order as main runs.
  - Stored tool row for `vault_items`: result `Checked the vault (N items)` plus only item names; `toolSummary` labels it "Checked the vault".
  - `AgentStore.save`: `withAskTool(withTodoTools(withVaultTools(tools)))` for non-empty lists. `zumiBot.ts`: the sentence telling Zumi Bot which tool names to add to `tools:` lists also names `VAULT_TOOL`.

- [ ] **Step 1: Write failing tests:**
  - `vaultIpc.test.ts`: `lists only the owner agent's items`; `refuses a revoked token`; `ignores caller-supplied chat or agent fields` (exact keys only).
  - `vaultBridge.test.ts`: `exposes one tool vault_items with an empty schema`; `deletes its capability env before serving`.
  - `chatService.test.ts`: `every run gets the vault bridge and VAULT_SYSTEM whatever the grants` (two runs of agents with different grants produce byte-identical `--append-system-prompt` and identical vault `--mcp-config` except the token placeholders); `answers the vault tool's permission request without a card`; `side runs join the vault bridge`.
  - `agentStore.test.ts`: `adds vault_items to a non-empty tools list`.
  - `browserPackaging.test.ts`: `ships vaultBridge.mjs`.
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/core/vaultIpc.test.ts backend/tests/core/vaultBridge.test.ts backend/tests/core/chatService.test.ts backend/tests/core/agentStore.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Wire `serveVaultIpc` in `app.ts` with `items: agent => vault.grantedTo(agent).map(agentView)`, closed at server stop like the to-do IPC.
- [ ] **Step 4: Run** the same command plus `npm run build:server` then `npx vitest run --project backend backend/tests/browserPackaging.test.ts` — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 5: API keys as env vars, and scrubbing

**Files:**
- Create: `zumi-bot-server/backend/src/core/vault/scrub.ts`, `zumi-bot-server/backend/src/core/vault/vaultEnv.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`, `zumi-bot-server/backend/src/core/btw/sideRun.ts`, `zumi-bot-server/backend/src/app.ts` (scrub to-do adds, ask messages, side questions)
- Test: `backend/tests/core/vaultScrub.test.ts`, `backend/tests/core/chatService.test.ts`, `backend/tests/core/sideRun.test.ts`, `backend/tests/core/todoIpc.test.ts` or `askService.test.ts` as fits the wiring

**Interfaces:**
- Consumes: `VaultStore.grantedTo`.
- Produces:
  - `vaultEnvOf(items: readonly VaultItem[]): { env: Record<string, string>; scrub: Map<string, string> }` — apiKey items only; `scrub` maps value → `[vault: <name>]`.
  - `scrubText(text: string, scrub: ReadonlyMap<string, string>): string` — literal replace (reuse `redactPrivate`'s split/join), longest value first.
  - `scrubEvent(e: RunEvent, scrub: ReadonlyMap<string, string>): RunEvent` — every string inside every event kind, except it returns a `permissionRequest` unchanged (the caller scrubs only the card copy).
  - `class DeltaScrubber { constructor(scrub: ReadonlyMap<string, string>); push(text: string): string; flush(): string }` — keeps back the last `longest - 1` characters so a value split across deltas is caught.
  - `ChatServiceDeps.vaultEnv?(agent: string): { env: Record<string, string>; scrub: Map<string, string> }` — read per attempt for main runs only (not `spec.compact`, not side runs); env merged after the other envs; its `scrub` entries also go into `privateValues`.
  - In `onEvent`: non-permission events pass through `scrubEvent`; `textDelta` through the attempt's `DeltaScrubber` (flushed before `assistantText`, `result` and the attempt's end); for `permissionRequest` the stored card's `input`, `description` and `reason` are scrubbed while `slot.pending` keeps the raw input that `allowResponse` returns.
  - `SideBase.scrub?: ReadonlyMap<string, string>` set from the base agent's grants; `sideRun.ts` scrubs its events and error with it.
  - `app.ts`: to-do `agentAdd` item texts, `ask` messages and `side_question` questions are scrubbed with the owner agent's map before they are stored.

- [ ] **Step 1: Write failing tests:**
  - `vaultScrub.test.ts`: `scrubs literally` (value `a.b*c(d)+e$` replaced exactly, and `abXcde` left alone: regex chars never interpreted); `scrubs every string of every event kind`; `leaves permissionRequest unchanged`; `DeltaScrubber catches a value split across deltas` (value `ABCD1234`; `push('tok-ABC') + push('D1234-end') + flush()` equals `'tok-[vault: K]-end'`).
  - `chatService.test.ts`: `gives API keys only to main runs of granted agents` (fake run args/env: granted agent's env has `AZURE_DEVOPS_EXT_PAT`; another agent's and a compact run's do not); `stores a scrubbed tool result but answers a permission with the raw input` (fake permission request whose input holds the value → stored card has `[vault: K]`, reply sent to the fake carries the value).
  - `sideRun.test.ts`: `scrubs a side answer with the base agent's keys`.
  - A to-do add whose text holds the value is stored scrubbed.
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/core/vaultScrub.test.ts backend/tests/core/chatService.test.ts backend/tests/core/sideRun.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; wire `vaultEnv: agent => vaultEnvOf(vault.grantedTo(agent))` in `app.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 6: Guarding the vault files, and its probe

**Files:**
- Create: `zumi-bot-server/backend/src/core/vault/vaultGuard.ts`, `zumi-bot-server/e2e/vaultGuardProbe.mjs`, `zumi-bot-server/backend/tests/vaultGuardProbe.test.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`, `zumi-bot-server/backend/src/app.ts`, `zumi-bot-server/backend/tests/fixtures/fake-probe-claude.mjs`, root `package.json` (`e2e` script)
- Test: `backend/tests/core/vaultGuard.test.ts`, `backend/tests/core/claudeRunner.test.ts`

**Interfaces:**
- Produces:
  - `vaultGuardSettings(o: { keyFile: string; vaultFile: string; home: string }): string` — JSON with `permissions.deny` = for each of `Read, Edit, MultiEdit, Write, Grep, Glob`: the key folder (`<Tool>(/<abs key dir>/**)` in the CLI's `//`-absolute form) and `vault.json`; and `hooks.PreToolUse` = `[{ matcher: 'Bash', hooks: [{ type: 'command', command }] }]` where `command` is a plain `sh` test (`grep -qF -e … && { printf '%s\n' "$VAULT_GUARD_TEXT" >&2; exit 2; }; exit 0`, each pattern shell-quoted with `pauseSettings`' `quote`) over the absolute, `~/` and `$HOME/` forms of both paths.
  - `VAULT_GUARD_TEXT = 'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.'`
  - `ChatServiceDeps.vaultGuard?: string`; every main run adds `['--settings', vaultGuard]` to `extraArgs` (merged by `oneSettings`); side runs and Compact unchanged.
  - Probe CLI: `node e2e/vaultGuardProbe.mjs [--soft]` exits 0 PASS, 1 FAILED, 2 INCONCLUSIVE (retried once; `--soft` turns 2 into 0 with a loud warning); `ZUMIBOT_SKIP_VAULT_PROBE=1` skips; `ZUMIBOT_PROBE_CLAUDE` picks the binary. It loads `vaultGuard.ts` with Node type stripping (INCONCLUSIVE on Node < 22.18), runs the real CLI in auto mode with `--strict-mcp-config` in a temp home with a dummy key file, and asks the model to Read the key path, then to `cat` it.

- [ ] **Step 1: Write failing tests:**
  - `vaultGuard.test.ts`: `denies file tools on the key folder and vault.json`; `the Bash hook blocks every spelling of both paths and allows others` (run the hook command with `sh -c` on JSON stdin: `cat /abs/key`, `cat ~/.config/zumibot-vault/vault.key`, `cat $HOME/.config/zumibot-vault/vault.key` → exit 2 with the text; `grep vault.json src/` → exit 0).
  - `claudeRunner.test.ts`: `merges the vault guard with the pause hook and desktop ask rules into one --settings`.
  - `chatService.test.ts`: `main runs carry the vault guard; side runs and compact do not`.
  - `vaultGuardProbe.test.ts`: PASS, FAILED (the fake's Read returns the key), INCONCLUSIVE (no tool call) verdicts against `fake-probe-claude.mjs`.
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/core/vaultGuard.test.ts backend/tests/core/claudeRunner.test.ts backend/tests/vaultGuardProbe.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; wire `vaultGuard: vaultGuardSettings({ keyFile: config.vaultKeyFile, vaultFile: join(dataDir, 'vault.json'), home: homedir() })`; append `&& node zumi-bot-server/e2e/vaultGuardProbe.mjs --soft` to the root `e2e` script.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then, with a logged-in CLI, `node zumi-bot-server/e2e/vaultGuardProbe.mjs` — Expected: exit 0 PASS (report INCONCLUSIVE output if it is).
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 7: Observation reaches into frames

**Files:**
- Modify: `zumi-bot-server/backend/src/core/browser/browserObservation.ts`, `zumi-bot-server/backend/src/core/browser/browserTools.ts` (`boundBrowserResult` keeps `frame`), `zumi-bot-server/e2e/fixtures/browser-site.mjs`
- Test: `zumi-bot-server/backend/tests/core/chromiumAdapter.test.ts`, `backend/tests/core/browserBridge.test.ts` (bound result)

**Interfaces:**
- Produces: observation elements `{ ref; role; name; text; frame?: string }` — `frame` is the child frame's host (absent for the main frame), bounded to 253 characters by `boundBrowserResult`. Elements of every attached child frame (main frame first, then `page.frames()` order) share the existing 256-element and character budgets; page text stays the main frame's. Refs into frames work with `click`, `type`, `select`.
- Fixture: `browserSite()` also serves `/login` (username + `input[type=password]` + a plain text field), `/checkout?frame=<origin>` (main page embedding `<iframe src="<origin>/card-frame">`) and `/card-frame` (inputs labelled Card number, Expiry, CVC; an expiry-month `<select>`), and returns `hostUrl` = the same server as `http://localhost:<port>`.

- [ ] **Step 1: Write failing tests** in `chromiumAdapter.test.ts`: `observes elements inside a cross-origin iframe with their frame host` (load `${site.url}/checkout?frame=${site.hostUrl}`; observe has `Card number` with `frame: 'localhost'`); `types into an iframe field by its ref`. In `browserBridge.test.ts`: `keeps a bounded frame label`.
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/core/chromiumAdapter.test.ts backend/tests/core/browserBridge.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; skip a frame that throws while being read (detached mid-collection) without failing the observation; the existing "observation changed" check still covers navigation.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`; `npm run e2e:browser` still green.

---

### Task 8: Card approvals: server side, chat card and answer

**Files:**
- Create: `zumi-bot-server/backend/src/core/vault/vaultApprovals.ts`, `zumi-bot-server/frontend/src/components/VaultApprovalCard.tsx`
- Modify: `zumi-bot-server/shared/src/types.ts` (ChatItem `vault-approval`), `zumi-bot-server/backend/src/core/chat/chatService.ts` (card publishing, `vaultPending`, `pendingOf`), `zumi-bot-server/backend/src/core/store/chatStore.ts` (restart → `interrupted`; rename covers `agent`), `zumi-bot-server/backend/src/core/chat/fork.ts` (pending copies read `interrupted`), `zumi-bot-server/backend/src/rpc/handlers.ts` (`vault:answer`), `zumi-bot-server/backend/src/app.ts`, `zumi-bot-server/frontend/src/components/MessageList.tsx`, `zumi-bot-server/frontend/src/state/groupChat.ts`, `zumi-bot-server/frontend/src/styles.css`
- Test: `backend/tests/core/vaultApprovals.test.ts`, `backend/tests/core/chatService.test.ts`, `backend/tests/core/chatStore.test.ts`, `backend/tests/core/fork.test.ts`, `backend/tests/rpc/handlers.test.ts`, `frontend/tests/groupChat.test.ts` (if present; else the pure module that counts room waiting)

**Interfaces:**
- Consumes: `VaultApprovalRequest` (Task 1).
- Produces:
  - ChatItem `{ type: 'vault-approval'; id: string; ts: number; agent: string; turn?: string; request: VaultApprovalRequest }`.
  - `class VaultApprovals` with `constructor(o: { now: () => number; newId: () => string })`, `registerTurn(turnId: string, cb: (r: VaultApprovalRequest) => Promise<void>): () => void`, `request(o: Omit<VaultApprovalRequest, 'id' | 'status'>, signal: AbortSignal): Promise<'allow' | 'deny' | 'interrupted'>`, `answer(chatId: string, requestId: string, decision: 'allow' | 'deny'): Promise<void>` (throws `Stale vault request` for an unknown, other-chat or finished id), `pendingId(profileId: string): string | null`. At most one pending per `profileId` (a second `request` resolves `deny` at once with no card). No timer: it ends on an answer, the signal (Stop, turn end) or server stop (`close()` → `interrupted`).
  - `ChatServiceDeps.vaultApprovals?: Pick<VaultApprovals, 'registerTurn'>`; per turn the callback places or updates the card through `ref` like `handoffCard`, keeps `slot.vaultPending: Set<string>`, and `pendingOf` adds `vaultPending.size`, so the badge, the `approvals` push, `waiting` notifications, routine `waiting` and A→B roll-up all count it.
  - `vault:answer {chatId, requestId, decision}`: refuses unless that chat holds a pending `vault-approval` with that id, then `approvals.answer`.
  - `VaultApprovalCard` renders the spec's text ("**@agent** wants to use **Work Visa (Visa •4242)** on **shop.example.com**", plus "card form from js.stripe.com" when `frameSite !== site`) with **Allow**/**Deny** while pending, and "Allowed — remembered for <site>" / "Denied" / "Interrupted" after. `MessageList`'s `waiting` and `groupChat`'s working tray treat a pending `vault-approval` like a pending `browser-action`.

- [ ] **Step 1: Write failing tests:** `vaultApprovals.test.ts`: `resolves allow and deny by answer`; `a Stop resolves interrupted and publishes the final status`; `refuses an answer from another chat or after it ended`; `one pending per profile`. `chatService.test.ts`: `a vault approval counts as pending and pushes approvals`. `chatStore.test.ts`: `a pending vault approval reads interrupted after a restart`. `fork.test.ts`: `a forked pending vault approval reads interrupted`. `handlers.test.ts`: `vault:answer needs a pending card in that chat`.
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/core/vaultApprovals.test.ts backend/tests/core/chatService.test.ts backend/tests/core/chatStore.test.ts backend/tests/core/fork.test.ts backend/tests/rpc` — Expected: FAIL.
- [ ] **Step 3: Implement** backend, then the card and the frontend waiting checks.
- [ ] **Step 4: Run** the same command plus `npx vitest run --project frontend` — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 9: `browser_fill_from_vault`

**Files:**
- Modify: `zumi-bot-server/shared/src/browser.ts` (`fillVault` command, `BrowserFill` type), `zumi-bot-server/backend/src/core/browser/types.ts` (`BrowserInstance.fill`), `browserTools.ts` (tool definition), `browserPrompt.ts`, `browserManager.ts`, `workerAdapter.ts`, `browserWorker.ts`, `chromiumAdapter.ts`, `browserApplication.ts` (pass the vault dep), `zumi-bot-server/backend/src/core/vault/scrub.ts` (`scrubBrowserResult`), `zumi-bot-server/backend/src/core/chat/chatService.ts` (stored row), `zumi-bot-server/shared/src/toolSummary.ts`, `zumi-bot-server/backend/src/app.ts`
- Create: `zumi-bot-server/backend/src/core/vault/vaultFill.ts`
- Test: `shared/tests/browser.test.ts`, `backend/tests/core/vaultFill.test.ts`, `backend/tests/core/browserManager.test.ts`, `backend/tests/core/chromiumAdapter.test.ts`, `backend/tests/core/vaultScrub.test.ts`, `backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 7, 8.
- Produces:
  - `BrowserCommand` adds `{ op: 'fillVault'; stamp: BrowserStamp; ref: string; item: string; field: VaultFillField }` (parser: item 1–128 chars, field in the union of `FILL_FIELDS`). Agents can't send anything carrying a value: the value only travels in `BrowserFill`, which is not a `BrowserCommand` and is not parsed at the IPC.
  - `interface BrowserFill { stamp: BrowserStamp; ref: string; value: string; secret: boolean; target: 'password' | 'input' | 'inputOrSelect' | 'any'; hosts: { kind: 'login'; sites: string[] } | { kind: 'card'; approved: { site: string; frameSite: string }[] } | { kind: 'any' } }`; `BrowserInstance.fill(f: BrowserFill, signal: AbortSignal): Promise<BrowserResult>` → `{ok: true, data: {filled: true}}`, `{ok: true, data: {approve: {site, frameSite}}}`, or failures `stale_reference | insecure_site | wrong_site | wrong_field_type`. Worker op `'fill'`; the adapter checks hosts (`secureHost` on `page.url()` and the handle's `ownerFrame().url()`), the element rule, fills (`fill` or `selectOption` by value or label), then masks secret `<input>`s with `style.setProperty('-webkit-text-security', 'disc', 'important')`.
  - `vaultFill.ts`: `fillPlan(item: VaultItem | null, agent: string, field: VaultFillField, now: number): { ok: true; value: string; secret: boolean; target: BrowserFill['target']; hosts: BrowserFill['hosts']; itemName: string; label: string } | { ok: false; code: 'not_allowed' | 'no_field' | 'vault_unavailable'; message: string }` (`code` from TOTP; `expiry` `MM/YY`, `expiryMonth` `MM`, `expiryYear` `20YY`, `expiryYear2` `YY`; `password` target `password`; other secret fields `input`; expiry parts `inputOrSelect`; non-secret `any`).
  - `BrowserManagerDependencies.vault?: { item(id: string): VaultItem | null; status(): VaultStatus; addApproval(id: string, site: string, frameSite: string): Promise<void>; approve(o: Omit<VaultApprovalRequest, 'id' | 'status' | 'chatId' | 'turnId' | 'profileId'> & { owner: BrowserOwner }, signal: AbortSignal): Promise<'allow' | 'deny' | 'interrupted'>; secrets(): { values: string[]; cards: string[] } }`.
  - `BrowserManager.run` for `fillVault`: plan with the entry's agent → `instance.fill` → on `approve`: hold the lease with `leases.protect(owner)` while `vault.approve` waits; `allow` → `addApproval`, re-plan (a removed grant or item now fails `not_allowed`), fill again (the worker re-checks hosts); `deny` → `denied`; `interrupted` → `cancelled`. Success returns `{filled: true, item: itemName, field}`.
  - `scrubBrowserResult(r: BrowserResult, s: { values: string[]; cards: string[] }): BrowserResult` — every string except image `base64`; card numbers matched as their digits with optional single spaces or dashes between; applied by the manager to every result it returns to an agent.
  - Tool `browser_fill_from_vault` `{stamp, ref, item, field}` in `browserTools` definitions. `browserPrompt`'s sign-in sentence: check `vault_items` and fill with `browser_fill_from_vault`; only when nothing fits, call `browser_request_user_action`.
  - Stored row: input `{item: <item name or 'unknown item'>, field}`; result keeps the fixed line, with `: <reason>` for `wrong_site`, `denied`, `not_allowed`, `insecure_site`, `wrong_field_type`; `toolSummary` reads "Filled from vault · <item> · <field label>".

- [ ] **Step 1: Write failing tests:**
  - `browser.test.ts`: `parses fillVault and refuses unknown fields and extra keys` (an extra `value` key is refused).
  - `vaultFill.test.ts`: `refuses another agent's item`; `gives card expiry parts in each format`; `gives a current TOTP code`; `targets password fields for passwords`.
  - `chromiumAdapter.test.ts` (real Chrome, Task 7 fixture): `fills a password only into a password field and masks it` (into the plain text field → `wrong_field_type`; into the password field → filled, and the field's computed `-webkit-text-security` is `disc`, read by the test through the instance's page); `masks a card number in a plain text input`; `refuses a login on a host not in its sites` (`wrong_site`); `asks approval for a new page and frame pair` (returns `approve` with `{site: '127.0.0.1', frameSite: 'localhost'}`); `refuses http hosts` (navigate to `http://example.test/` served by a `context.route` fixture → `insecure_site`).
  - `browserManager.test.ts` (fake instance): `fills after Allow and remembers the pair`; `Deny types nothing`; `refuses a fill whose grant was removed while its approval waited`; `rechecks hosts after an approval` (fake `fill` returns `approve` for a second pair after Allow → a second approval is requested); `scrubs vault secrets from observations, tab titles and errors`.
  - `chatService.test.ts`: `stores a fill row with the item name and field only`.
- [ ] **Step 2: Run** `npx vitest run --project shared shared/tests/browser.test.ts && npx vitest run --project backend backend/tests/core/vaultFill.test.ts backend/tests/core/browserManager.test.ts backend/tests/core/chromiumAdapter.test.ts backend/tests/core/chatService.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; in `app.ts` pass `vault` to the browser application: `item: id => vault.get(id)`, `approve` → `vaultApprovals.request({...}, signal)` with `chatId`/`turnId`/`profileId` from the owner, `secrets: () => vault.secrets()`.
- [ ] **Step 4: Run** the same commands — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`; `npm run e2e:browser` green.

---

### Task 10: Settings › Vault

**Files:**
- Create: `zumi-bot-server/frontend/src/components/VaultSettings.tsx`, `zumi-bot-server/frontend/src/state/vaultSettings.ts`
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (`'vault'` after `'notifications'` in `SETTINGS_SECTIONS`), `frontend/src/state/settings.ts` (label `Vault`), `frontend/src/components/Settings.tsx` (icon and section), `frontend/src/components/MenuIcon.tsx` (new `lock` shape), `frontend/src/styles.css`
- Test: `zumi-bot-server/frontend/tests/vaultSettings.test.ts`, existing route/settings tests

**Interfaces:**
- Consumes: `api.vault` (Task 3), Task 1 validators and views.
- Produces (pure, `state/vaultSettings.ts`):
  - `type VaultDraft` (form state: all fields as strings, secrets `''` = keep, `agents: string[]`, `sitesText: string` one site per line)
  - `groupVault(items: readonly VaultListItem[], query: string): { kind: VaultKind; items: VaultListItem[] }[]` (order Login, Card, Contact, API key; query matches name and the row line, case-insensitive)
  - `rowLine(item: VaultListItem): string` (login `username · site, site`; card `Visa •4242 · holder`; contact email; apiKey `$ENV`)
  - `emptyDraft(kind: VaultKind): VaultDraft`, `draftOf(item: VaultListItem): VaultDraft`, `inputOf(draft: VaultDraft): VaultInput` (blank secrets left out; sites normalized)
  - `draftErrors(draft: VaultDraft, others: readonly VaultListItem[]): Partial<Record<string, string>>` (uses `vaultInputError`-equivalent rules on list views; env clash per agent; Luhn failure reported as `warning`, not an error)
  - `agentChoices(agents: readonly AgentSummary[]): string[]` (loadable, not Zumi Bot, sorted)
- `VaultSettings.tsx`: heading line from the spec; search; **Add** menu; grouped rows with agent count; an item form with **Show**/**Copy** per secret (fetches `api.vault.reveal`, never stored in state longer than shown), 2FA Show shows the code, **Agents that can use this**, a card's **Approved sites** with remove, **Delete** through `ConfirmDialog` with the spec's text; `keyMissing`/`keyMismatch` replace the list with the explanation, the key path text and **Start a new vault** (confirm first); dirty form goes through the Settings unsaved-changes guard the other sections use; refetches on `vault:changed`; usable on a phone.

- [ ] **Step 1: Write failing tests** in `vaultSettings.test.ts`: `groups by kind in order and filters by query`; `rowLine per kind`; `inputOf leaves blank secrets out and normalizes sites`; `draftErrors flags an env var another key gives the same agent`; `a failed Luhn check is a warning only`; `agentChoices leaves out Zumi Bot and broken agents`. Route test: `/settings/vault parses and round-trips`.
- [ ] **Step 2: Run** `npx vitest run --project frontend` — Expected: FAIL.
- [ ] **Step 3: Implement** the pure module, then the component and styles.
- [ ] **Step 4: Run** `npx vitest run --project frontend` — Expected: PASS. Then `npm run build:server`, start the app (`run` skill or `npm run dev`) and check the page in light and dark and at 375 px wide: add a login, a card, a contact and an API key; Show/Copy; delete; screenshots via `npm run shot` if it supports the route.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 11: Sync

**Files:**
- Create: `zumi-bot-server/deploy/vaultSync.mjs`
- Modify: `zumi-bot-server/deploy/sync.mjs`, `zumi-bot-server/deploy/config.mjs` (key path rule for the local side), `zumi-bot-server/deploy/deploy.env.example`, `zumi-bot-desktop/electron.vite.config.ts` (copy `vaultSync.mjs`), `zumi-bot-desktop/src/main/syncDesktop.ts` (allow `VPS_VAULT_KEY_FILE` in `sync.env`)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`, `zumi-bot-server/backend/tests/core/vaultCrypto.test.ts` (cross-format), `zumi-bot-desktop/e2e/sync.e2e.mjs`

**Interfaces:**
- Produces (`vaultSync.mjs`, plain ESM, `node:crypto` only):
  - `keyIdOf(key: Buffer): string`, `openItem(key, item): unknown`, `sealItem(key, id, updatedAt, body): string` — byte-compatible with `vaultCrypto.ts` (Global Constraints format).
  - `mergeVault(local: VaultFile | null, vps: VaultFile | null): VaultFile | null` — by id; later `updatedAt` wins; tie → tombstone, then VPS; result `keyId` = the inputs' (callers only merge files under one key).
  - `planVaultKeys(o: { localKey: Buffer | null; vpsKey: Buffer | null; localFile: VaultFile | null; vpsFile: VaultFile | null }): { action: 'none' | 'pullKey' | 'pushKey' | 'merge' | 'reseal' | 'refuse'; reason?: string }` — `refuse` when either side's file `keyId` differs from that side's own key (or has live items and no key); `reseal` when both keys exist and differ.
  - `resealFile(file: VaultFile, fromKey: Buffer, toKey: Buffer): VaultFile` — opens each live item with `fromKey`, seals with `toKey` (same id and `updatedAt`), throws if any item fails (nothing written then).
- `sync.mjs`: before "Joining chats", read the local key (config rule) and the VPS key via `ssh` (`base64 < "$F"` of `VPS_VAULT_KEY_FILE`, default `~/.config/zumibot-vault/vault.key`), plan, then: `pullKey` writes the local key (0700/0600); `pushKey` sends it over ssh stdin (`umask 077; mkdir -p dir; cat > f.tmp && mv f.tmp f`); `reseal` reseals the local file under the VPS key, then renames the old local key to `vault.key.replaced-<stamp>` (0600) and writes the VPS key; `refuse` logs a plain line and leaves both vaults alone. Then the merged `vault.json` (0600) is written locally and added to the upload `sources` and the swap's `for f in … vault.json` list. Key bytes never go into argv, logs or the backup folders.

- [ ] **Step 1: Write failing tests** in `sync.test.ts`: `mergeVault joins by id and keeps tombstones`; `mergeVault tie prefers the tombstone then the VPS`; `planVaultKeys covers none, pull, push, merge, reseal and refuse`; `resealFile reseals and opens with the new key`; `resealFile throws and changes nothing when an item won't open`. In `vaultCrypto.test.ts`: `vaultSync.mjs opens what vaultCrypto sealed and back`.
- [ ] **Step 2: Run** `npx vitest run --project backend backend/tests/sync.test.ts backend/tests/core/vaultCrypto.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `vaultSync.mjs`, then the `sync.mjs` steps, the desktop copy list and `sync.env` key, and a commented `# VPS_VAULT_KEY_FILE=` line in `deploy.env.example`.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then extend `zumi-bot-desktop/e2e/sync.e2e.mjs` with: a key on the VPS home only → copied to the PC; different keys → PC items resealed and both sides open the merged vault with the VPS key; the key never appears in the sync log. Run `npm run e2e:sync` — Expected: PASS.
- [ ] **Step 5: Checkpoint** — `npm run typecheck`.

---

### Task 12: End-to-end suite and docs

**Files:**
- Create: `zumi-bot-server/e2e/vault.e2e.mjs`
- Modify: `zumi-bot-server/e2e/harness.mjs` (always set `ZUMIBOT_VAULT_KEY_FILE` to `<temp root>/vault-key/vault.key`), `zumi-bot-server/backend/tests/fixtures/fake-browser-claude.mjs` (scenario steps may name a server: `zumibot_vault` for `vault_items`; a step that emits a Bash `tool_use`/`tool_result` whose result text is the value of a named env var), root `package.json` (`"e2e:vault": "npm run build && node zumi-bot-server/e2e/vault.e2e.mjs"`), `CLAUDE.md`, `zumi-bot-server/deploy/SETUP-VPS.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `vault.e2e.mjs`** (fake browser claude, real Chromium, Task 7 fixture), checking:
  - an agent with a granted login lists it with `vault_items` (no password in the tool result) and fills `/login` (`filled: true`); the server-side page has the password in the field, and the agent's next observe holds no password;
  - the same login on `hostUrl` (a host not in its sites) fails `wrong_site`;
  - the checkout card fill shows a `vault-approval` card with both hosts; **Deny** → `denied`, nothing typed; again, **Allow** → filled and the pair listed under Approved sites in Settings › Vault; a third fill needs no card;
  - after the card number fill, the agent's `browser_screenshot` succeeds and the card field's computed `-webkit-text-security` is `disc` (read through the e2e's own CDP connection to the agent browser, as `browser.e2e.mjs` inspects pages);
  - an API key granted to the agent reaches the fake's Bash env, and the stored chat JSON, items feed and server log hold `[vault: <name>]`, never the value;
  - no password, card number, CVC, 2FA code or API key value appears in `chats/*.json`, the server log, or any tool result the fake received (`FAKE_MCP_RESULTS_OUT`-style log).
- [ ] **Step 2: Run** `npm run e2e:vault` — Expected: FAIL until the harness and fake changes are in, then PASS.
- [ ] **Step 3: Docs.** `CLAUDE.md`: a **Vault** architecture paragraph (store, key path, bridge, fill, approval card, env + scrub, guard + probe, sync) in the house style; Data lists `vault.json` and the key path; the e2e list names `e2e:vault` (fake claude, no quota) and `vaultGuardProbe.mjs` in `npm run e2e`. `SETUP-VPS.md`: back up `~/.config/zumibot-vault/vault.key`; without it the vault can't be opened.
- [ ] **Step 4: Full run** — `npm test`, `npm run typecheck`, `npm run e2e:vault`, `npm run e2e:browser`, `npm run e2e:sync` — Expected: all PASS. Kill any Chrome/playwright processes left behind (user rule).
- [ ] **Step 5: Checkpoint** — report results; no commit unless the user asks.
