# Channels (Telegram and Slack)

**Status: phases 1–4 built (channel core, Telegram direct messages, cards in Telegram, Slack on the same interface, and channels as a notification target).** Where a built phase differs from the phase 0 design, the text below describes what was built and says why. Sections marked **To verify** rest on platform facts that could not be read from the official pages while this was written (see Sources); they must be checked against the live docs before relying on them.

**Decisions taken at the phase 0 review.** Zumi Bot is never usable from a channel. Agent `/` commands, `/todo`, `/btw` and `/compact` are not available from a channel. `/pause` and `/resume` are. Waiting items with no channel form get a link only. Phase 4's title-only notifications go for every chat. Telegram is direct messages only (no groups or topics), with reply routing.

**What it is.** A channel is another place to talk to the same agents and answer the same cards: a Telegram bot in a direct message with the user, and a Slack app in a DM or a channel thread. A channel is a client of the server's own services, like a browser tab. It has no powers of its own. A message from the paired user becomes a user turn through the same queue as `chats:send`. A button press answers a card through the same `ChatService.answer`, `answerQuestions` and `answerPlan` as the RPCs. Everything else (tool rows, thinking, the to-do board, diagrams) stays in the web UI.

## Sources and what was verified

The official pages (`core.telegram.org`, `docs.slack.dev`, `api.slack.com`) could not be fetched from the session that wrote this (its network policy blocks them). The facts below come from search results that quote those pages, plus client libraries that track them. The source is noted next to each fact.

| Fact | Value used | Source / state |
|---|---|---|
| Telegram `getUpdates` offset | Pass `offset = last update_id + 1`. That call confirms every earlier update, and the server then forgets them. Up to 100 unconfirmed updates per call. | Bot API text as quoted by python-telegram-bot and the Bots FAQ. Verified. |
| Telegram `getUpdates` vs webhook | `getUpdates` fails while a webhook is set. Two concurrent pollers get `409 Conflict`. | From memory. **To verify.** |
| Telegram `callback_data` | 1–64 bytes | `InlineKeyboardButton` reference (Telegram's `.md` mirror) and python-telegram-bot constants. Verified. |
| Telegram message text | 4096 characters after entity parsing | Quoted for `sendMessageDraft`. The same limit for `sendMessage` is **to verify**. |
| Telegram streaming | `sendMessageDraft(chat_id, draft_id, text)`: private chats only, non-zero `draft_id`, changes to one `draft_id` animate, empty text shows "Thinking…". The draft is a temporary preview that disappears (about 30 s, or when the bot sends a message), so the final text must still go out with `sendMessage`. Bot API 9.5 (March 2026) opened it to all bots. 10.3 added `can_stop` and `keep_on_stop`. | aiogram docs, the changelog via search. Its rate limit is **to verify**. |
| Telegram rate | About 1 message a second per chat, with short bursts allowed. A 429 carries `parameters.retry_after` (seconds). The often-quoted "20 a minute in a group" appears only in third-party pages. | Bots FAQ, quoted. Verified apart from the group figure. |
| Telegram files | A bot downloads files up to 20 MB through `getFile`. The upload limit (commonly 50 MB) is **to verify**. | Bots FAQ. |
| Telegram private-chat topics | Bot API 10.0 had a regression where topic messages in private chats failed. | GitHub issue `tdlib/telegram-bot-api#847`. Topics are not used (see Mapping). |
| Slack Socket Mode ack | Ack each envelope with its `envelope_id` within 3 s, or Slack retries it. An ack payload of 20 KB or more is silently dropped. | Bolt docs, slack-go. Verified. |
| Slack app token | `xapp-…`, with the `connections:write` scope, for `apps.connections.open`. | Library docs. Scope name and the `disconnect` / `refresh_requested` flow are **to verify**. |
| Slack streaming | `chat.startStream`, `chat.appendStream` and `chat.stopStream` (changelog of 2025-10-07), authorized by `chat:write`. `assistant:write` belongs to the "Agents & AI Apps" feature, which channels do not use. | Slack changelog, `chat.appendStream` reference via search. Whether a stream needs a thread is **to verify**. |
| Slack `chat.postMessage` | About 1 message a second per channel, plus a workspace-wide limit. `chat.update` is commonly listed as Tier 3 (about 50 a minute). | Slack rate-limit page (quoted). The `chat.update` tier is **to verify**. |
| Slack button `value` | 2000 characters | Third-party summaries. **To verify** (ids are 22 characters, so only the order of magnitude matters). |
| Slack files | Upload with `files.getUploadURLExternal`, then `files.completeUploadExternal`. `files.upload` is being phased out. | Slack docs via search. Verified. |

## Rules (from the request; every phase keeps them)

- A channel never widens what an agent may do. No `--dangerously-skip-permissions` or `bypassPermissions`. Turns run on the chat's own mode, approvals and remembered rules, exactly as from the web.
- Content leaves the machine only for agents switched on for channels. Vault values never go out: every outbound text passes the vault scrub (see Outbound).
- Bot tokens, pairing codes and card ids never appear in logs, URLs or errors. An error names the setting ("Telegram bot token"), never a value. Telegram's own API puts the token in the request path (`/bot<token>/method`). That URL is built only inside `telegramApi.ts` and is never logged, put in an error or passed through. A fetch error is reduced to its code before logging.
- Channel text is untrusted. It reaches an agent only as a user message from the paired user. It never picks a tool, mode, effort, model, folder or setting. Names typed in a channel are matched against the server's own lists only.
- Agents get no tool to post to a channel, read channel history or change pairing. Only the user, from Settings, pairs, unpairs or flips switches. Nothing about channels enters the system prompt.
- The server still binds `127.0.0.1` only. All traffic is outbound: Telegram long polling and the Slack Socket Mode WebSocket. There is no webhook and no new HTTP route.

## Ownership: one machine runs a bot

**Two machines cannot share one bot.**

- **Telegram.** Only one `getUpdates` caller works at a time (the second gets 409, **to verify**). Even if both worked, they would race on the offset and each would see half the messages.
- **Slack.** Socket Mode allows several connections, but each event goes to just one of them, so each machine would see a random half.

**Which machine.** Each platform's settings carry `run: boolean`, meaning "this machine runs the bot". It is off until the user turns on **Run the bot here** in Settings › Channels, on any machine. (Phase 0 proposed on-by-default in VPS mode; an explicit switch is simpler and never starts a poller nobody asked for.) `npm run sync` treats `channels.json` like `routines.json`: the pulled copy written on this PC gets `run: false` for every platform. The VPS keeps its own. So after a sync only the VPS polls, the same way routines stay enabled on the VPS only. Settings on a machine with `run: false` says "Runs on the other machine" beside the **Run the bot here** switch. That switch takes effect only on this machine, and the next sync turns it off here again.

**Safety net.** A Telegram 409 (another poller, or a webhook set on the bot), puts the platform in `conflict` state. Settings shows "Another machine (or a webhook) is using this bot". The poller backs off (30 s, doubling up to 5 min) and never fights for the bot: it never calls `deleteWebhook`. A 401 or 404 is `badToken` and stops the poller. Network failures and 5xx are `error`, retried from 2 s doubling up to 60 s, or after a 429's `retry_after`.

**The token.** It is sealed with the vault key, but in `channel-tokens.json`, not as an item of `vault.json` (phase 0 proposed a vault item kind). An older server that syncs a `vault.json` holding an item kind it does not know reads the whole vault as unreadable, so a new kind there would break the vault on a machine one version behind. `ChannelTokens` seals `{token}` through `VaultStore.sealExtra(id, updatedAt, body)` (the vault's own AES-256-GCM seal, the key made at first use, `channel-token:<platform>` in the additional data) and opens it with `openExtra`. The key never leaves `VaultStore`. The file is per machine and never synced: the token is needed only where the bot runs. Its value joins the vault's scrub set (`VaultStore.setExtraSecrets`), so it is hidden wherever vault values are. A token that no longer opens (the vault key is missing or another one, after **Start a new vault**) puts the platform in `vault` state, and Settings asks for it again.

## The interface (`core/channels/`)

One adapter per platform implements `ChannelAdapter` (`adapter.ts`). Everything above it is shared and platform-free: `ChannelService` (routing, pairing, commands, streams), the stores, and the pure modules for commands, pairing codes, formatting and splitting.

```ts
// backend/src/core/channels/adapter.ts (as built)
interface InboundMessage { updateId: string; conv: string; from: { id: string; name: string }; direct: boolean; text: string; replyTo: string | null; files: InboundFile[]; voice: InboundFile | null }
interface InboundFile { ref: string; name: string; mime: string; size: number | null } // ref: the platform's file id, fetched only on use
interface ButtonPress { pressId: string; conv: string; from: { id: string; name: string }; direct: boolean; msg: string | null; token: string }
interface OutText { html: string; plain: string } // plain: the fallback when the platform refuses the HTML
interface ChannelSink {
  message(m: InboundMessage): Promise<void> // resolves once durably handled; the adapter confirms the update only then
  press(p: ButtonPress): Promise<void>
  state(s: ChannelState, bot: string | null): void
}
interface ChannelAdapter {
  readonly platform: ChannelPlatform
  readonly limits: { text: number; uploadBytes: number; downloadBytes: number }
  botId(): string | null
  start(sink: ChannelSink, offset: number, saveOffset: (next: number) => Promise<void>): void
  stop(): Promise<void>
  send(conv: string, text: OutText, o?: { buttons?: Button[][]; replyTo?: string | null }): Promise<string> // the message id
  draft(conv: string, draftId: number, text: OutText): Promise<boolean> // a live preview; false where the platform has none
  typing(conv: string): Promise<void>
  clearButtons(conv: string, msg: string): Promise<void>
  ackPress(p: ButtonPress, notice?: string): Promise<void>
  sendFile(conv: string, name: string, bytes: Uint8Array, caption?: string): Promise<string>
  fetchFile(f: InboundFile): Promise<Uint8Array> // refused past limits.downloadBytes
}
```

Phase 2 added `edit` (a card's outcome), `setButtons` (a multi-select's ticks) and `ask` (a ForceReply prompt for typed answers). Phase 3 added `sharedConvs` and `isShared(conv)` (Slack channel threads others can read), `mentioned` on a message, and the optional `userName` (Slack events carry only ids).

**One service per platform.** `ChannelService` takes its `platform` and holds that platform's dialect (`TELEGRAM` HTML or `SLACK` mrkdwn from `shared/src/channelText.ts`), label and command prefix. `app.ts` builds one for each (`makeChannel`) over the shared stores: `ChannelStore` keyed by platform, `ChannelStateStore.view(platform)` for each one's slice of `channel-state.json`, and `ChannelTokens` (Slack's entry holds the bot token and the app-level token). `push` hands every chat change to both, and each reads only chats it drives. The handlers route each `channels:*` call to its platform's service.

Every outbound call of an adapter goes through its `Outbox` (`outbox.ts`): one queue per conversation, at most one call a second in it, a 429's `retry_after` honoured (capped at 300 s), and previews coalesced so only the newest waits. A final message is retried on a 429 or a network failure, up to 5 tries, and rejects on anything else. A preview (draft, "typing…") is dropped when it can't go. `close()` (on stop) rejects what is queued, so nothing is sent after the server stops. `answerCallbackQuery` bypasses the queue, because Telegram expects it quickly and it is not a chat message.

Transport: plain `fetch` (Node 22) for both HTTPS APIs (`telegramApi.ts`, `slackApi.ts`), and the existing `ws` dependency (8.22.0) for Slack's Socket Mode client. **No new dependency.** The platform SDKs (Telegraf, grammY, Bolt) are not added: they pull in many transitive packages for a few calls, and their logging and retry layers would have to be audited to keep tokens out of logs. `telegramApi.ts` builds the URL that holds the token in one place. A fetch error is replaced by `TelegramError(method, code, retryAfter, description)`, whose message names the method and the code only. The cause, which can carry the URL, is never kept.

## Mapping: conversations and chats

**Telegram (phase 1, private chat only).** The paired DM is one conversation with a **current chat** pointer. Messages go to the current chat. Groups, supergroups and channels are ignored without a reply, even from the paired user (phase 1 scope). Forum topics in private chats are not used: Bot API 10.0 broke them for a while, and a pointer plus reply routing covers the need.

- **Reply routing.** Every message the bot sends is recorded in `channel-state.json` as `msgId → chatId` (the newest 2000 per conversation). A Telegram reply to one of them goes to that chat and makes it current. That is how two chats stay usable side by side in one DM.
- **Headers.** The first reply message of each channel-driven run of turns starts with a bold header, `<agent display name> · <chat title>` (`Room: <title>` for a room). In a room each member's reply starts with the member's name. `/new`, `/where`, a `/chats` pick and Continue in Telegram show the header too. (Phase 0 said "every reply"; once per run reads better on a phone.)

**Slack (phase 3, as built).**

- **DMs work as in Telegram** (phase 0 proposed one chat per DM thread; matching Telegram keeps one model and keeps cards' typed replies working).
  - The DM channel (`D…`) is one conversation with a current chat. The bot posts top-level.
  - A reply in the thread of a bot message routes to that message's chat (`replyTo` is the event's `thread_ts`).
- **In a channel, each thread is one chat**, conversation `<channel>/<thread ts>`. The bot posts in that thread.
  - The paired user mentions the bot (`<@bot>` in the text, removed before anything else reads it) to start: `@bot !new tester` makes the mention's own message the thread root.
  - Later messages in that thread from the paired user count without a mention.
  - A top-level message without a mention is ignored, as is any thread that isn't a chat yet.
- **Other people.** Their messages are dropped by `ChannelService` before anything else reads them: never a turn, never stored, never logged, never passed as context. The adapter reads no history (`conversations.history` and `conversations.replies` are never called).
- **Events.** Only `message` events are used (`message.im`, `message.channels`, `message.groups`), with a mention detected in the text, rather than `app_mention`: Slack sends both for one mention, and one source means one turn.
- **Dropped by `slackMessageOf`:** bots, the bot's own messages, edits, and joins. Only no subtype, `file_share` and `thread_broadcast` are read.
- **The paired identity** is `<team>:<user>`, and the pairing DM's channel is its `chatId`.

**Picking an agent or room** (commands below). Names are matched with the existing `matchAgent` (`shared/src/agentMatch.ts`) against **channel-enabled agents only**. A room is matched by title against rooms whose every member is channel-enabled. An unknown or disallowed name answers "No agent named X is available here", which says nothing about whether the name exists.

**New chat.** `/new <agent>` calls the `chats:create` handler with the agent's last folder (`lastFolderByAgent`), else home, so the worktree rule of `chats:create` applies as from the web. It uses the default mode and effort. The channel never names a folder. A new room is not created from a channel (a room needs a member list and a folder). Rooms made in the web UI can be continued.

**Continuing a web chat.** Two ways:
- `/chats` lists the 10 most recent chats and rooms that are channel-eligible. Each is a button (an opaque token like a card's), and pressing one makes it current.
- The chat menu in the web UI gets **Continue in Telegram**, which sets the pointer and posts the header there.

A chat that becomes a conversation's current chat gets `ChatMeta.channel: { platform }`, cleared by **Stop continuing in Telegram**. The sidebar row shows a small paper-plane mark (`channel-mark`), and the chat's right-click menu holds **Continue in Telegram** / **Stop continuing in Telegram** (`chat-menu-channel`). A refusal (not paired, the agent off) shows in a dialog. The chat stays fully usable in the web UI.

**Which turns go out.** A turn is **channel-driven** when the user message that started it came from the channel. In a room, every member reply until the room settles counts as part of it. Only channel-driven turns stream their reply and send their cards to the channel. A turn started in the web UI in a linked chat stays in the web UI. Phase 4 notifications cover it if you are away, so typing at the desk never copies content to the phone unasked.

**Eligibility, checked at every send and press** (not only at link time, since switches change):
- A single chat qualifies when its agent is channel-enabled.
- A room qualifies when every current member is.
- Zumi Bot is never eligible, because its tools change agents, routines and workflows (decided at review). `channels:setAgents` drops it, and the store drops it on read.
- An asked (A→B) chat is read-only, as for `chats:send`.

A chat that stops qualifying keeps its link mark. Its next message from the channel answers "This chat's agent is not available from Telegram" and nothing is sent.

## Commands

The commands are a fixed list, parsed by a pure `parseChannelCommand(text, platform)`. On Telegram, `setMyCommands` sets the menu. **On Slack they start with `!`** (`COMMAND_PREFIX`): Slack's composer takes a leading `/` as one of its own slash commands and never sends it. A `/` that does arrive works too. In a channel they follow the mention (`@bot !new tester`). There are no Slack slash commands, which would need registering in the app. Help, hints and the refusal texts use the platform's prefix.

| Command | Effect |
|---|---|
| `/agents` | Lists channel-enabled agents as buttons. A press is `/new <agent>`. |
| `/new <agent>` | Starts a new chat with that agent and makes it current. |
| `/new` | Starts a new chat with the current chat's agent. |
| `/chats` | Lists the 10 most recent eligible chats and rooms as buttons. |
| `/stop` | The `chats:stop` handler on the current chat (the same as Stop). |
| `/pause` | The `chats:pause` handler (the same as Pause, with its refusals). |
| `/resume` | The `chats:resume` handler (the same as Resume). |
| `/where` | The current chat's header and state (idle, replying, paused, queued N). |
| `/help` | The list. |

`/start` (what Telegram sends first) reads as `/help`. Any other text starting with `/` answers "Unknown command. /help lists them." It is never forwarded, so channel text cannot reach the agent's own `/` commands, `/todo`, `/btw` or `/compact` (decided at review). The `//` escape phase 0 proposed was dropped, because a literal leading `/` would still be read as a command by the CLI.

**Commands run at most once.** A command's update id is written to `channel-state.json` (`cmds`, the newest 50) before it runs, so a redelivered `/new` never makes a second chat. A crash in between loses the command instead, which the user sees and can repeat.

## Inbound pipeline

1. **Identity.** `ChannelService` drops anything not from the paired user. On Telegram that means `from.id` equals the paired id, the chat is one-to-one (`chat.type` is `private` and `chat.id` equals `from.id`), and it is the paired chat. On Slack (phase 3) it will mean team plus user id equal the paired ones. There is no reply and no log line. Bots' own messages, edits and channel posts never reach the sink (`inboundOf`).
2. **Pairing.** Before pairing, the only thing the sink reads is a message whose whole text matches the code shape (see Security).
3. **Dedupe and durability (no replay, no drop).**
   - **Telegram.** The poller handles updates in order. For each one it derives a message id, `tg-<botId>-<update_id>`, which fits `MESSAGE_ID_RE`. That id is passed as `chats:send`'s `mid` to `TaskQueue.submit`. `submit` gets an `ifAbsent` option and checks, under the chat's lock, that no item or queued task already carries that id. The poller writes `offset = update_id + 1` to `channel-state.json` only after the sink resolves, and the next `getUpdates` confirms it.
     - A crash before the offset write makes Telegram send the update again, and the id check drops it. That gives no replay.
     - A crash before the submit leaves the offset unwritten, so the update comes back. That gives no drop.
     - Commands run at most once (see Commands).
     - `submit`'s `once` option checks under the chat's lock for the id among the chat's items, its queued tasks, and the ids this process launched in the moment before a turn writes its user item. Its `committed` callback settles the sink as soon as the message is stored, queued or found a duplicate, so the poller never waits for a turn.
     - An update whose handling throws (the disk is full, the server is stopping) is not confirmed and comes back. After 3 failures in a row it is skipped, so one update that always fails can't block the rest.
   - **Slack.**
     - Envelopes are handled one at a time and acked (`{envelope_id}`) only after the sink resolves.
     - The sink only stages and queues, so it fits Slack's 3 s window except for a large file. A late or missing ack makes Slack deliver it again.
     - A redelivery carries the same `event_id`, which gives the same message id (`ch-sl-<bot>-<event id>`), and the same check drops it.
     - There is no offset to keep.
   - A redelivery that arrives while the first copy's turn still runs finds its id already in the drive and leaves it there. Phase 3's test found that the duplicate path used to remove it, which lost that turn's reply.
4. **Attachments.** Documents, the largest size of a photo, and audio files are fetched (refused past `downloadBytes`: 20 MB on Telegram, and never past `ATTACH_MAX_BYTES`, 25 MB), with names cleaned of slashes and control characters, and staged with `AttachmentStore.stageBytes`, the same path as `attachments:stageBytes`. A refused file answers its stage error and the text still goes.
5. **Voice notes.** Only when Settings › Voice input is on. The clip (OGG/Opus) goes through the existing transcriber (`transcriber.transcribe(…, 'ogg', 'auto')`) and `cleanTranscript` with the user's cleaning switches, and the transcript is sent as the text (after any caption). The audio is never stored. The bot first replies "🎙 <transcript>" so you can see what was heard. With voice off, it answers "Voice input is off in ZumiBot".
6. **Send.** `TaskQueue.submit(chatId, text, staged, undefined, mid, …, 'user', …, { once, committed })`, what `chats:send` does after its checks. No command is resolved, since `/` text never reaches this step. Queue, Pause, held tasks, spend caps, usage-limit waits and the "Server is shutting down" refusal behave as for the web. A refusal is answered in the channel as its plain message. The text is capped at 16 000 characters (Telegram's own cap is 4096, Slack's is larger).

The send is fire-and-forget toward the channel: the sink resolves when `submit` has committed the message (sent or queued), not when the turn ends.

## Outbound: streamed replies

`ChannelService.chatPush` is called first in `app.ts`'s `push`. It reads `delta`, `items` and `meta` pushes, and only for chats with a **drive**: the set of channel message ids (`anchors`) whose turns stream back. Pushes are handled one at a time, in order.

- **Items.** A walk over the pushed list turns on at a user item whose id is an anchor and off at any other user item (one typed in the web UI). While it is on, every item not yet sent goes out once, by id:
  - an `assistant` item as the reply (the CLI adds one only when its message is complete);
  - an `error` as "Error: …" (cut to 500);
  - a `notice` as its `NOTICE_TEXT`;
  - a pending approval, browser handoff or vault card as the waiting line (see Things with no channel form).
  - A `tool` item only counts a step and adds its file changes.
- **End.** When a `meta` push shows the chat idle, with no anchor still queued, the stored items are read once more, the drive closes, and the changed files are offered. Sending those items takes a while, and a channel message that arrives meanwhile joins the same drive: the drive then stays open for that message's turn (checked again after the send, with nothing awaited before the close). Before this check, such a message's reply and cards never reached the channel. A late `meta` push may only close the drive it was routed to, never one a newer message opened.
- Eligibility is checked again at every items push, so an agent switched off mid-turn sends nothing more.

**Telegram, private chat.**
- While the reply streams, the bot shows `sendMessageDraft` with one random `draft_id` per drive, refreshed at most once a second with the last 3500 characters of the live text (`tailOf`), or "Working… (N steps)" while tools run.
- Each complete assistant message goes out with `sendMessage`, split (below). Sending a message ends the draft by itself.
- If `sendMessageDraft` is refused for a reason other than a rate limit or the HTML (an older Bot API), drafts stop for that adapter and the bot shows "typing…" (`sendChatAction`) instead. Phase 0 proposed editing a placeholder message; "typing…" costs no edits against the rate limit and leaves no stale message behind.
- HTML that Telegram can't parse goes again as its plain Markdown source, so a reply is never lost to formatting.
- The draft cadence is a constant to be tuned once the real rate limit is checked (**to verify**).

**Slack (as built).**
- **No live preview.** Each complete assistant message goes out with `chat.postMessage`.
  - `chat.startStream` is still to verify, and editing a placeholder would spend the workspace's `chat.update` budget on every reply.
  - Socket Mode has no bot "typing…".
- The outbox keeps one message a second per Slack channel. A 429's `Retry-After` header is honoured.
- **Messages and buttons.** A message's mrkdwn is its `text`, with link unfurling off. Buttons go in Block Kit: the text in a `section` and one `actions` block per row. Each button's `value` is its opaque token and its label is cut to 75.
- **Edits.** `chat.update` replaces text and blocks. The adapter keeps each sent message's text (the newest 2000) so `setButtons` and `clearButtons` can resend it.

**Restart mid-reply.** Each drive is recorded in `channel-state.json` (`open`: `{chatId, conv, anchors}`) when a channel message joins it, and removed when it closes. The turn itself ends as `interrupted` through the existing `recoverInterrupted`. On the next start (after `tasks.resume()`), `ChannelService.recover()` sends "(Interrupted: ZumiBot restarted before this reply finished.)" for a drive whose message had started. A drive whose message is still a queued task is rebuilt, so its reply streams back when the task runs. Phase 2 adds clearing the buttons of open card messages.

**Stopping.** `ChannelService.stop()` runs first in the server's `close()`: it stops the poller, closes the outbox, waits for the outbound queue and the state file's writes, and refuses any later message (unconfirmed, so it comes back at the next start). Nothing is written to the data folder after the lock goes.

**Rooms.** Each member's reply is its own stream, headed by the member's name. Members run side by side, and the outbox serializes them per conversation.

## Formatting and splitting (pure, `shared/src/channelText.ts`)

`renderTelegram(markdown)` emits Telegram **HTML** parse mode rather than MarkdownV2. HTML needs only `<`, `>` and `&` escaped, while MarkdownV2 needs 18 characters escaped and fails a whole message on one miss. The mapping:

| Markdown | Telegram HTML |
|---|---|
| bold, italic, strike | `<b>`, `<i>`, `<s>` |
| inline code, fenced code | `<code>`; `<pre><code class="language-x">` |
| links | `<a href>` (http and https only; any other scheme becomes plain text) |
| headings | bold lines |
| lists | `•` and `1.` lines |
| blockquotes | `<blockquote>` |
| tables | a `<pre>` block with aligned columns |
| images | link text |
| raw HTML in the source | escaped, never passed through |

**Dialects.** The parser and splitter are shared, and a `Dialect` (`TELEGRAM`, `SLACK`) says how to mark text up. `renderSlack(markdown)` emits mrkdwn:
- `*b*`, `_i_`, `~s~`, `` `c` ``, triple-backtick blocks (no language, a ``` inside the code becomes a look-alike), `<url|label>` (`|` in a URL percent-encoded, `|` and `>` dropped from a label), `&gt;` quotes;
- `&`, `<` and `>` always escaped, so `<!here>`, `<!channel>` or `<@U…>` in an agent's text never pings anyone;
- each mark held as it is made, so Slack's `*` bold is never read again as Markdown italic.

`splitMessage(md, limit, dialect)`.

`splitMessage(markdown, limit)` splits on the source and measures the **rendered** length. Each part is `{html, plain}`, where `plain` is the part's Markdown source, the fallback when Telegram refuses the HTML:
- It cuts at a blank line first, then a line break, then a space, and inside a word only as a last resort.
- A cut inside a fenced block closes the fence and reopens it with the same language at the top of the next part. Code blocks are never broken in a way that changes their text.
- A single line longer than the limit inside code is cut hard, with the fence kept.
- Telegram's limit is 4096. Slack's is 3000 (`SLACK_TEXT_MAX`: a section block's mrkdwn limit, used for plain messages too, so a card's text always fits its block).

The parser is a small hand-written block and inline scanner, the same rules the tests pin. The frontend's `remark` stack is not bundled into the server for this.

## Things with no channel form

| In ZumiBot | In the channel |
|---|---|
| Tool call rows, their input and results | Not sent. While a turn works, the draft shows "Working… (N steps)": a count only, no tool names, inputs or paths. |
| Thinking | Never sent. |
| Subagent (dispatch) rows, background processes | Not sent. They are part of the step count. |
| To-dos made by a turn (`todos` on the item) | Not sent in phase 1 (phase 0 proposed a count line). |
| Browser and desktop handoffs, vault card approvals, a question card the web shows as a plain approval (`parseQuestions` null) | "<Agent> is waiting for you in ZumiBot." plus the link in VPS mode (`<origin>` + `pathFor(chatId)`, `CHAT_PREFIX` in `shared/src/appPaths.ts`, which is behind the sign-in) or "open ZumiBot on your computer" in Local mode. Nothing about the card goes out: no tool name, input or question. Answered only in ZumiBot. To-do card questions and A→B asks live outside the chat's items and send nothing. |
| Mermaid diagrams | The source as a code block, headed "Diagram (open in ZumiBot to see it drawn)". Rendering images on the server is out of scope. |
| Math (KaTeX) | Display math (`$$…$$`) as a preformatted block. Inline `$…$` stays as written, since prices like "$5 and $10" would read as math. |
| Images the reply links to | The link only, never fetched. |
| Memory saved, cost chip, context meter, git chip | Not sent. |
| Notices (Stopped, Paused, spend cap paused, usage-limit wait with its time, interrupted) | Their `NOTICE_TEXT` or own text, as a plain line. |
| Error items | "Error: <text>", vault-scrubbed and cut to 500 characters. |

**Files an agent produces.** When a drive closes, the `FileChange`s of its tool items (Write and Edit, the same list the Files panel reads; the newest per path) are shown as "Files changed: name1, name2 (+3)", file names only, never paths. The first 5 with an after-snapshot get a **Send <name>** button carrying an opaque token (`ButtonTokens`, reusable, 24 hours). Pressing it uploads that file's snapshot (`file-snapshots/`, so it is what the turn wrote, not what the disk holds now) with `sendDocument`, up to 10 MB. Nothing is uploaded without the press, because an agent may write a `.env`. Uploads are refused for files under the vault key folder or the data folder.

## Cards (phase 2)

`ChannelCards` (`core/channels/cards.ts`) with the pure layout in `shared/src/channelCards.ts`. A pending `approval` item of a channel-driven turn becomes a card. Cards of turns started in the web UI reach the channel only with a waiting notice (see Notifications, Cards with a notice).

**Tokens.** Every button carries its own `ButtonTokens` token (16 random bytes, base64url, 22 characters, within Telegram's 64-byte `callback_data`), mapped in memory to `{kind: 'card', key, act, q?, o?}`. `key` names the chat, the member and the request, and `act` names what the button does: `allow`, `deny`, `approve`, `keep`, `pick`, `toggle`, `done` or `type`. A token never carries the answer, which is looked up on the server. All of a card's tokens share one group.

A press is honoured only when every check passes:
1. The presser is the paired account, in the paired chat (checked before the token is read).
2. The token was issued for this conversation, is unused, and is under 24 hours old.
3. The card is still open here, and the request still waits in a running turn: `ChatService.isPending(chatId, requestId, agent)`, not the message text.

A failed check gets "Already answered." or "That button is no longer active." and changes nothing. A stranger gets an empty acknowledgement. Once a card is answered, from anywhere, its group is burned. Tokens never reach a log, and the e2e suite checks that.

**Approval card.** "<Agent> wants to use **Tool**" (`approvalCardHtml`), then:
- for Bash, the whole command in a code block (judging it is the point) and its description;
- for any other tool, the web row's `toolSummary`;
- then the request's description and reason.

Each part is cut on a line boundary (600 characters for the command or summary, 300 for each other line) with "(cut, see ZumiBot)". Every string of the input is scrubbed of vault values first. The buttons are **Allow once** and **Deny** only, sent as `allow-once` and `deny` through the `chats:answer` handler. "Always allow" and "Allow for this chat" are left out: a remembered rule outlives the message, and a phone screen with a cut summary is the wrong place to widen an agent for good. `onceOnly`, connector and routine-delete cards offer only these two anyway.

**Question card** (`AskUserQuestion`, `parseQuestions`). Each question is its own message (`questionHtml`: the heading on the first, `n/N`, the header, the text, each option with its description).
- A single-select question has one button per option (labels cut to 40, two per row).
- A multi-select question's option buttons tick on and off (`setButtons`), and **Done** takes the ticked ones (at least one).
- **Other…** (**Type an answer…** for a text or number question) sends a ForceReply prompt. The reply, or a reply to the question's own message, is that question's answer. A number is checked against `min`/`max` (`typedAnswerProblem`). In a multi-select it joins the ticked options.
- An answered question's message shows "✓ <answer>" without buttons.
- Once every question has an answer (`answersOf`), the set goes through the `chats:answerQuestions` handler, whose `checkAnswers` refuses anything malformed as for the web. A refusal is told in the channel and the card stays open.
- The answers carry the agent's own labels unscrubbed, since the CLI matches them; only the shown copies are scrubbed.
- There is no Skip button.

**Plan card** (`ExitPlanMode`). The plan, under "Plan for your approval" or "Plan from <member>", is rendered and split like a reply. The last part carries **Approve** and **Keep planning**.
- Approve goes through the `chats:answerPlan` handler, so Plan mode's setMode-on-approve rule applies unchanged.
- Keep planning sends a ForceReply prompt ("What should change? … or reply /skip"). The reply is the feedback (`checkFeedback` limits it), and `/skip` sends none.
- A reply to any of the plan's messages is feedback with Keep planning.
- A plan is never auto-allowed or remembered.

**Typed answers never become turns.** In `onMessage`, before commands, a message that replies to a card's prompt, question or plan goes to `ChannelCards.reply` and stops there. A reply to a card that is no longer pending gets "Already answered." Any other message goes on as before.

**Both ways.** Every items push of the chat is checked by `ChannelCards.sync`. A card whose item is no longer `pending` (answered in the web UI, the Inbox or the channel, auto-allowed, or interrupted) gets its outcome line (`outcomeLine`), and its buttons are removed (`editMessageText`):
- "✓ Allowed once", "✗ Denied", "✓ Answered", "✓ Plan approved", "↩ Sent back to keep planning", each with "in ZumiBot" when the answer came from elsewhere;
- "No longer pending" when the turn ended unanswered.

A drive closing (the turn's end) closes what is still open. A press in the channel goes through the same handlers, so the web card updates through the existing pushes.

**Rooms.** The card carries the member (`item.agent`), passed to every answer call as the RPCs do.

**Restart.** Card messages that still carry buttons are recorded in `channel-state.json` (`cards`), written even while the server stops, since `stop()` waits for those writes. At the next start their buttons are removed and one line says "Cards from before ZumiBot restarted are no longer pending." The tokens died with the process, so a late press is inactive.

**Slack cards.** The same cards, in Slack's markup (`approvalCardHtml`, `questionHtml` and `pickedLine` take the dialect).
- A press arrives as a `block_actions` envelope (`slackPressOf`); its conversation is the DM or `<channel>/<thread>` of the message.
- Slack has no ForceReply, so `ask` posts the prompt and says where to answer:
  - in a DM, in that message's thread (the reply's `thread_ts` is the prompt);
  - in a channel thread, in the thread itself. A message there has no reply target, so the newest open prompt in that conversation takes the next message (`ChannelCards.reply`'s `implicit`), and each prompt is used once.
- `/skip` or `!skip` sends a plan back with no note.

**Shared Slack channels.** Cards in a channel thread are **off by default**. `channels.json`'s `slack.sharedCards` is set by **Settings › Channels › Shared channels** (`channels:setSharedCards`, Slack only).
- Off: the thread gets "<Agent> is waiting for you in ZumiBot." with the link (VPS), or the Local-mode sentence. Nothing about the card goes there.
- On: the card goes to the thread, visible to everyone in the channel. Only the paired user's press counts. Anyone else's press gets an ephemeral "Only <name> can answer this." (`chat.postEphemeral`, seen by the presser alone) and changes nothing.
- DMs always show cards.
- Settings says that in a channel, the paired user's messages, the agent's replies and file names are visible to everyone there.

## Pairing and settings

**Settings › Channels** (`ChannelsSettings.tsx`, pure rules in `state/channels.ts`, route `/settings/channels` after Connectors, palette keywords "telegram bot …"):
- **Telegram bot.** A password field (`channel-token`). Save checks the token's shape, asks Telegram's `getMe`, seals it and clears the field. Paste a new one to replace it, or **Remove token**. There is no Show or Copy. Under it is the connection line (`channel-state`, `stateLine`) and the **Run the bot here** switch (`channel-run`).
- **Your account.** **Pair my account** (`channel-pair`, only once a token is saved and the bot runs here) shows the code with the minutes left (`channel-code`) and "Send this code to @botname". Once paired it shows the account name (`channel-paired`) with **Unpair**.
- **Agents you can use from Telegram.** One switch per loadable agent (`channel-agent-<name>`), every one off until turned on. Zumi Bot and broken agents are not listed. A remote agent's row names its host.
- **Slack** (phase 3) is a second section of the same page (`PlatformSettings`, test ids `slack-…`; Telegram keeps `channel-…`). It differs from Telegram's:
  - two password fields, the bot token (`xoxb-`) and the app-level token (`xapp-`, with `connections:write`), both required, checked with `auth.test` and `apps.connections.open` before they are sealed;
  - the scopes, bot events and switches the Slack app needs (Socket Mode, Interactivity);
  - the **Shared channels** note and the **Show approval, question and plan cards in channels** switch (`slack-shared-cards`, off).
- The chat menu has **Continue in Telegram** and **Continue in Slack** (`chat-menu-channel`, `chat-menu-channel-slack`), and the sidebar mark names the platform (`data-platform`).
- **Phase 4:** notification toggles.

**Buttons.** `/agents`, `/chats` and **Send file** carry opaque tokens from `ButtonTokens` (`buttons.ts`): 16 random bytes as base64url, 22 characters, mapped in memory to an action and the conversation it was sent to. A list's tokens are burned by its first press, and the message's keyboard is cleared. Tokens expire after 24 hours, and 5000 are kept at most. A press from anyone but the paired account, or a token that is unknown, used, expired or from another conversation, does nothing. The paired user gets "That button is no longer active.", and a stranger gets an empty acknowledgement.

**Pairing code.**
- 8 characters from an unambiguous 31-letter alphabet (no 0/O/1/I/L), shown as `ABCD-EFGH`. It is valid for 10 minutes, single use, and one at a time (a new one voids the old).
- The bot accepts a message whose text is that code, ignoring case, spaces and a dash (`pairCodeIn`), compared in constant time. On success it binds that sender (Telegram: user id and private chat id; Slack: team and user id), answers "Paired with ZumiBot. /help lists the commands.", and Settings updates through a `channels:changed` event.
- Attempts are rate limited. Each unknown sender gets 5 tries per 10 minutes. After 20 wrong tries in all, the code is void and Settings says so.
- A wrong try gets **no reply**, so a stranger cannot even learn that the bot listens. Unpaired senders are never answered.
- While a pairing is open, the code shape is the only thing read from an unpaired sender. Once paired, nothing from anyone else is read.
- The code lives in memory only and is never logged or sent anywhere but to the page that asked.

**Vault.** See The token (above): sealed under the vault key in `channel-tokens.json`, never listed in Settings › Vault, never granted to an agent, never in env, and scrubbed like any vault value.

**RPCs** (each one in `ZumiBotApi`, `rpc/handlers.ts` and `net/api.ts`, every argument checked):
- `channels:status`: a list, one `ChannelStatus` per platform (`{platform, configured, run, state, bot, paired: {name} | null, pairing: {expiresAt} | null, agents}`), never a token or code. It is empty on a server built without channels.
- `channels:setToken(platform, token)`: shape-checked first (`tokenShapeOk`: `<3–20 digits>:<30–64 of [A-Za-z0-9_-]>`), answered "That doesn't look like a Telegram bot token." without echoing it, then `getMe` with a 15 s timeout: "Telegram refused this bot token." on 401/404, "Telegram could not be reached…" otherwise. A new token resets the offset, the current chats and the message map (a new bot's updates start over).
- `channels:removeToken(platform)`.
- `channels:setRun(platform, on)`.
- `channels:pairStart(platform)` returns `{code, expiresAt}`.
- `channels:pairCancel(platform)`.
- `channels:unpair(platform)`.
- `channels:setAgents(platform, names)`: at most 200, kept only when they name a current agent. Zumi Bot is dropped.
- `channels:link(chatId, platform)` and `channels:unlink(chatId)`, for Continue in Telegram. Link refuses before pairing and for an ineligible chat.

Each handler checks every argument before anything else. A server built without channels refuses with "Channels are not available on this server". Every change broadcasts `channels:changed` with no payload. None of these are reachable by an agent: no bridge or tool exposes them.

## Notifications (phase 4)

A paired channel is a **notification target** (`NotifyTarget`, `ChannelService.notifyTarget()`), next to the devices of [Notifications](notifications.md).
- `app.ts` hands both platforms' targets to `NotifyService` through `targets()`, read per event.
- A target answers its toggles, or null while it can't take one: not paired, or the bot doesn't run on this machine.

**Toggles** (`channels.json`'s `notify`, `ChannelNotifyToggles`): push's four kinds plus `workflow`, **all off** until turned on in **Settings › Channels › Notifications in <platform>**.
- The switches are `channel-notify-<kind>` (Telegram) and `slack-notify-<kind>` (Slack), enabled once paired, and set through `channels:setNotify(platform, toggles)`.
- The handler takes exactly the five booleans (`isChannelToggles`).

**The same rules as push.**
- Chat events go through `NotifyService`'s own path, so a target gets them only when the device rules would send them: held while anyone has the chat on screen, dropped when input followed, sent when they look away.
- `kindFor` decides by its toggles, so a routine run failed by its turn's error comes once, as `routine-failed` or else `error`.
- The rate cap is the same 10 non-waiting a minute, keyed by the target (`channel:<platform>`).
- Workflow runs (an Approval step waiting, a failed run, a Notify step) have no chat on screen and are never held.
- A Notify step obeys the `workflow` toggle. Push sends it whatever its toggles say; a channel never does without the switch.
- A spend cap's notice goes under `waiting`.

**Not told twice.** A chat whose turn already talks to that channel (a drive, or one that closed within the last 60 s, `DRIVEN_GRACE_MS`, since a turn's end can reach the notifications just after its drive closed) is skipped for that channel. Its reply, card and error already went there. Push devices are still told as before.

**What it says.** `channelNotifyText`: the push's own words, one message to the paired direct chat (the Telegram private chat, the Slack DM):
- the title in bold (the chat's title, or the routine's or workflow's name), vault-scrubbed;
- what happened ("Tester replied", "… needs you", "… reply ended with an error", "Routine failed", a spend cap's amounts);
- on a VPS, the chat's link.

A Notify step sends only its title and "A workflow sent you a message. It is in the Inbox.": its own text may hold an agent's output, so it stays in the Inbox (decided in phase 4). No prompt text, reply text, tool input, answers or paths. A notice about a chat is remembered like any bot message, so replying to it writes to that chat (if its agents are on for the channel).

**Cards with a notice.** A `waiting` notice about a chat (not an Inbox one) is followed by that chat's pending `approval` items as cards (`noticeCards`), sent to the paired direct chat: an approval card (Allow once and Deny), a question card (the question, its options as bullets with their descriptions, and the buttons) or a plan card, so each can be answered from the phone. Only when the chat's agents are on for the channel (`refusal`); otherwise the notice stays title-only. Browser and desktop handoffs and vault cards never come with a notice. The cards are the same `ChannelCards` as a driven turn's: a press goes through the same handlers, and since the chat has no drive, `chatPush` passes its pushes to `ChannelCards.sync` while it has an open card, and its turn's end (`meta` not in flight) closes them.

**Not done.** A channel notice is never cleared or edited once the card is answered or the chat is opened; push's `notify:clear` has no channel side.

## Data

- **`channels.json`** (0600, `writeFileAtomic`, `ChannelStore`): `{v: 1, telegram: {run, paired: {userId, chatId, name} | null, agents: string[], sharedCards: false, notify: {waiting, replied, error, routineFailed, workflow}}, slack: {… same, paired.userId `<team>:<user>`, chatId the DM channel, sharedCards}}`, read field by field (Zumi Bot dropped from `agents`; ids checked per platform). It holds no secret. `npm run sync` copies the VPS's file over this PC's with `run` forced false (`disableChannels`), the way routines come from the VPS switched off; it is never pushed. An agent rename moves its name in `agents` (a step of the agent-rename pipeline, caught and logged like voice talk). A deleted agent drops out.
- **`channel-state.json`** (0600, per machine, never synced, in `sync.mjs`'s `PULL_EXCLUDES`, `ChannelStateStore`): one entry per platform, `{v: 1, telegram: {offset, current: {conv: chatId}, msgs: [conv, msgId, chatId][] (newest 2000), open: [{chatId, conv, anchors}], cards: [{conv, msg, chatId}], cmds: [updateId] (newest 50)}, slack: {…, offset unused}}`. A Slack conversation key is a DM channel id or `<channel>/<thread ts>`. Its values mean nothing on another machine and the poller owns them.
- **`channel-tokens.json`** (0600, per machine, never synced, in `PULL_EXCLUDES`): `{v: 1, tokens: {telegram: {updatedAt, sealed}, slack: {updatedAt, sealed}}}`, Slack's sealed body `{token, appToken}` (see The token).
- **Pairing codes and button tokens:** memory only.
- **`ChatMeta.channel`:** in `chats.json`, synced with the chat (a mark only).

## Dev hooks and tests

**Hooks** (through `devEnv()`, ignored in production):
- `ZUMIBOT_TEST_TELEGRAM_URL` replaces `https://api.telegram.org`, and also serves file downloads.
- `ZUMIBOT_TEST_SLACK_URL` replaces `https://slack.com` (its `/api/<method>`), and is the only origin allowed for file downloads and upload URLs.

Each accepts only an `http://127.0.0.1:<port>` origin with no path (`testChannelOrigin`, like `testVoiceOrigin`). Anything else is ignored. With the Slack hook set, the `url` that `apps.connections.open` returns must be `ws://127.0.0.1:<that port>/…`. Without it, only `wss://` on `slack.com` or a `*.slack.com` host is accepted (`socketUrlOk`), and files only from `https://*.slack.com` (`fileUrlOk`).

**Pure tests** (phase 1, as built):
- `shared/tests/channels.test.ts`: commands, pairing codes, token shape, message ids.
- `shared/tests/channelText.test.ts`: escaping, links with bad schemes, emphasis, tables, math, diagrams; splitting with fences across a cut, long lines, the rendered length at the limit.
- `backend/tests/core/channels/channelsUnits.test.ts`: the outbox (gap, coalescing, 429 `retry_after`, finals), pairing (once, expiry, per-sender and total limits), button tokens, `scrubOutbound`, the API client (no token in an error, error codes, the download limit, the dev hook), `inboundOf`.
- `frontend/tests/channels.test.ts`: the settings page's rules.
- `handlers.test.ts`: argument checks, and a refused token never echoed.
- `sync.test.ts`: `disableChannels`, and the two per-machine files staying put.

**Fakes** in `backend/tests/fixtures/`:
- `fake-telegram.mjs` (+ `.d.mts`): `getMe`, `getUpdates` with long-poll and offset semantics (a lower offset gets unconfirmed updates again), `sendMessage`, `sendMessageDraft`, `sendChatAction`, `editMessageText`, `editMessageReplyMarkup`, `answerCallbackQuery`, `getFile` plus download, `sendDocument` (multipart), `setMyCommands`; `failNext(method, {code, retry_after})` injects a 429, 409 or other error. Used by both the backend test and the e2e suite.
- `fake-slack.mjs` (+ `.d.mts`): `auth.test` and `apps.connections.open` (each checking its token), `users.info`, `chat.postMessage` (returning a ts), `chat.update`, `chat.postEphemeral`, the upload pair and the upload URL, file downloads with the bot token, and a Socket Mode WebSocket that sends `hello`, events (`dm`, `say`, a raw `event` with a chosen `event_id` for redelivery), presses and `disconnect`, and records every ack. `failNext` injects a 429 with `Retry-After` or an error code.

`backend/tests/channelsApp.test.ts` drives the fake against a real `startServer` with the fake claude: the sealed token and refused tokens; pairing (wrong codes and a stranger get nothing, the code works once); a turn end to end with the header; strangers, a disabled agent and `/compact` turning into nothing; a 429 on the reply; a restart with the offset not saved (the message and the `/new` before it replayed: no second message, no second chat); a restart mid-reply (the interrupted line); a file staged as an attachment; a voice note while voice input is off; a used or stranger button press. Phase 2 added: an approval card (Allow once and Deny only, a stranger's press, the outcome edit, a second press stale), a card answered in the web UI (its message edited "in ZumiBot", a late press stale), a question card (a pick, a multi-select with Done, a typed answer through the ForceReply, all sent once), plan cards (Keep planning with typed feedback; Approve), a restart while a card waits (buttons cleared, the press inactive), and a message sent while the last reply is still going out (a 429 holds the queue; the second turn's reply must still arrive). `shared/tests/channelCards.test.ts` covers the layout, cuts, answers, typed-answer checks and outcome lines.

`backend/tests/slackApp.test.ts` (phase 3) does the same for Slack:
- both tokens checked and sealed, a refused app token;
- pairing only in a DM (the code in a channel does nothing; a stranger gets nothing), named from `users.info`;
- a DM turn with `!new`, `/where` still working, every envelope acked;
- a channel thread started by a mention, with someone else's thread message and mention never read and the owner needing no mention in the thread;
- a redelivered event handled once, and a reply through a 429;
- a DM card (Allow once and Deny only, the outcome edit, a stale press told ephemerally);
- a shared channel with cards off (the link) and on (a stranger's press told privately, Keep planning answered by the next thread message, which never becomes a turn);
- a file staged from a DM, and a reconnect after Slack's `disconnect`.

`backend/tests/core/channels/slackUnits.test.ts` covers `slackMessageOf`, `slackPressOf`, `blocksOf`, and the API client (the token only in the header and in no error, `Retry-After`, the app token only for the socket, socket and file URL checks). `shared/tests/channelText.test.ts` covers `renderSlack` and splitting for Slack, and `shared/tests/channels.test.ts` covers `!` commands and Slack token shapes.

**E2E:** `e2e:telegram` (`zumi-bot-server/e2e/telegram.e2e.mjs`) covers the UI side: Settings › Channels (token saved sealed, Run, the agent switch, pairing with the shown code), a Telegram turn showing in the web UI with the sidebar mark, Continue in Telegram on a web chat (and its refusal for an agent left off), and no token or code in any log. Phase 2 added a card answered in the web UI updating the fake's message, one answered in Telegram updating the web card, and a stale press. `e2e:slack` (`slack.e2e.mjs`) covers Slack's side: both tokens saved sealed and the socket connecting; pairing in a DM, named from Slack; a DM turn with the sidebar mark (`data-platform="slack"`); a mention starting a thread chat with a stranger's thread message never read; cards in that shared thread, a link while off, and once switched on the card, a stranger's press told privately and a web answer editing it; and no token, code or card token in any log. No test reaches a real platform. The hand run against a real test bot happens only after the user agrees.

## What leaves the machine

Destination: `api.telegram.org`, or Slack (`slack.com`, its Socket Mode host and its file host). On Slack, everything sent to a channel thread is visible to everyone in that channel. Only for channel-enabled agents, and only for channel-driven turns, except where noted. Every text passes the vault scrub first.

| Kind | Content sent |
|---|---|
| Pairing | "Paired with ZumiBot". Nothing else, and nothing to anyone unpaired. |
| Command answers | Agent display names (`/agents`), chat titles and agent names (`/chats`, `/where`, headers), chat state words. Only eligible agents and chats are listed. |
| A reply | The agent's reply text in full, rendered and split, plus the header (agent, chat title, room member). |
| While working | "Working… (N steps)". A count only. |
| Errors and notices | The notice text, error text (scrubbed, cut to 500). |
| To-dos | Nothing (phase 1). |
| Queue and command answers | "Queued: …", "Stopped.", "Pausing…", "Resumed.", refusals as their messages (scrubbed, cut to 500). |
| Files changed | File names (no paths). File bytes only on your **Send file** press, up to 10 MB. |
| Approval card | Agent name, tool name, the tool summary (for Bash the command), the description and reason, cut to 600. |
| Question card | The heading, the questions, headers, descriptions, and option labels and descriptions as the agent wrote them (scrubbed); your picked answer on the message. |
| Plan card | The full plan text (scrubbed), and the feedback prompt. |
| Card outcome edits | "Allowed once", "Denied", "Answered in ZumiBot", and similar. |
| Waiting items with no channel form | "<Agent> is waiting for you in ZumiBot." plus a link to the chat (VPS) or a sentence (Local). Nothing about the card itself. |
| Files you send (inbound) | Fetched from Telegram's file host and stored as the chat's attachments, as an upload from the web would be. |
| Notifications (phase 4, per toggle, all off by default) | The chat's title (or routine or workflow name), what happened in push's words (agent display name, "replied", "needs you", a spend cap's amounts), and the chat's link on a VPS. Any chat, title only, like web push; a workflow Notify step's own text never goes. To the paired direct chat only. |
| Slack, shared channel thread | Replies, notices and file names as in a DM, readable by the channel; cards only when Shared channels is on, otherwise the waiting line. |
| Slack, someone else's press | An ephemeral "Only <name> can answer this." to that person only (your Slack display name). |
| Slack pairing | `users.info` for your display name (a read; nothing sent). |
| Voice notes (inbound) | The clip goes to OpenRouter (Scribe, zero data retention) exactly as dictation does, then the transcript is echoed to the channel. |

Inbound to the server: your messages, files (fetched from the platform's file host) and button presses. Nothing from other people is stored or passed on.

## Still open

- **Tuning.** The Telegram draft interval, and whether to add Slack's streaming methods, wait for the **to verify** items, which need `core.telegram.org` and `docs.slack.dev` reachable from the session (or checked by hand).
