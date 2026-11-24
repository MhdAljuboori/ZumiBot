# Suggested replies: option buttons and a Tab placeholder

Design, approved 2026-11-24.

## Why

The Claude Code desktop app offers the next message after a reply: when the reply asks the user to pick between named
options it shows them as buttons, and a click sends that text as the user's message; when there is one likely answer it
shows it as the composer's placeholder, and Tab writes it into the box for the user to send. Answering "Native" or
"Yes, commit it" by hand is friction the user wants gone in ZumiBot too.

## Goals

- After a turn ends on a reply that asks the user something, ZumiBot offers what the user may send next.
- **2 or 3 options:** buttons right above the composer. A click sends that exact text as the user's message, through the
  same path as the composer's Send.
- **1 option:** the composer's placeholder, while the box is empty. Tab writes it into the box (nothing is sent); the user
  can edit it and press Send. On a touch screen (no Tab key) a small button in the composer does the same.
- Works for every engine (Claude, Codex, ACP, remote agents), in single chats and in rooms.
- **Settings switch "Suggested replies", on by default** (user's ask). Off: no Haiku call runs, and neither the buttons
  nor the placeholder appear anywhere, also for options stored before it was turned off.

## Non-goals

- The agent knows nothing of it: no system prompt line, no tool, no prompt-cache change.
- Nothing mid-turn: `AskUserQuestion` cards already cover a question asked during a turn.
- No Telegram/Slack channel buttons, no voice talk, no sidebar or notification text.
- The CLI's own `--prompt-suggestions` is not used (Claude only, one suggestion, skipped on a session's first turn and
  in Plan mode, behind a feature flag with its own back-off, and a cached re-read of the whole chat on the agent's model).

## Anti-goals

- Never sends anything without a click.
- Never answers an open question for the user ("What should the page do?" gets no options).
- Never delays a turn's end, holds the chat busy, or blocks the next send.
- Never shows options that belong to an older reply (after a new message, an edit, a resend, a version switch, or a send
  from another tab).

## Approaches

1. **Reply reader (picked by the user).** After a turn ends, a separate `claude -p --model haiku` call (the pattern
   `acknowledge.ts` already uses for the ack line) reads the user's message and the end of the reply and returns 0 to 3
   options. 1 is the placeholder, 2 or 3 are buttons. One mechanism, every engine, about one small Haiku call per reply
   that ends on a question. It sees only the last exchange, so it can miss context from earlier in the chat.
2. **Native + reader.** Placeholder from the CLI's `--prompt-suggestions` (probed on CLI 2.1.329: a
   `{"type":"prompt_suggestion","suggestion":"Local only"}` line arrives about 0.7 s after `result`, also when stdin is
   closed at `result`), buttons from the reader. Better placeholder, but two mechanisms and a Claude-only placeholder.
   Rejected.
3. **Agent decides.** A new ZumiBot MCP tool and a system prompt line; the agent calls it at the end of its turn. Most
   accurate, but a tool call every turn, a new bridge, a one-time prompt-cache reset for every agent, and nothing for
   engines without bridges (ACP). Rejected.

## Design

### The reader (`backend/src/core/chat/replyOptions.ts`)

Built like `acknowledge.ts`, through `runJsonCall` (`moderator.ts`):

- Args: `-p --model haiku --tools '' --setting-sources '' --strict-mcp-config --no-session-persistence
  --output-format json --json-schema <SCHEMA> --system-prompt <SYSTEM_PROMPT>`. Schema:
  `{"options": string[]}`, at most 3 items, no other keys.
- Input on stdin: the agent's display name, the user message that started the exchange (what the agent read, as
  `ackMessage` builds it; capped at 2 000 characters with `…`), and the tail of the reply (its last 4 000 characters).
  Both are wrapped in tags and called material, never instructions, as the ack prompt does.
- System prompt, in substance:
  - Write the messages the user is most likely to send next, in the user's voice and the reply's language.
  - Only when the reply ends by asking the user to choose or to confirm. An open question, a reply that asks nothing, or
    a question only the user can answer from their own knowledge gets `[]`.
  - Named choices (for example "Native" or "Subagent-driven") give one option per choice, using the choice's own name.
    A yes/no offer ("Want me to commit?") gives one option, the yes ("Yes, commit it").
  - Each option short (aim for 1 to 6 words), no quotes, no emoji, never a fact the reply does not hold.
- Parse (`parseReplyOptions`): `structured_output.options`, else the JSON in `result`, as `parseAck` does. Each option is
  trimmed and whitespace-collapsed; empty ones, ones over 80 characters, and ones starting with `/` or `@` (they would
  run as a command or a mention) are dropped; duplicates (case-insensitive) are dropped; more than 3 means none. Any
  other shape is `[]`.
- Gate before any call (`asksUser(reply)`): the reply's last paragraph holds `?` or `؟`. No question mark, no call.
- Timeout 20 s. Cost recorded as a moderator call (`usage.recordModerator`), as the ack line's is.

### When it runs (`ReplyOptions` service, wired in `app.ts`)

- Trigger: ChatService's `onIdle(chatId)` (fired by `release()` for single chats and for rooms). Called last in the
  `onIdle` hook, after the task queue and the others had their chance to start a new run.
- It reads meta and items and stops unless all hold:
  - the setting is on and `claude` is found;
  - the chat is not `inFlight` and not paused;
  - the chat is one the user converses with in the app. Ordinary single chats, rooms and routine-run chats qualify.
    These are skipped, because their questions go elsewhere or nobody answers them in the composer: A→B asked chats
    (`asked`, read-only), task chats (`task`) and card-comment chats (`cardComments`), whose questions go on the card;
    parallel-attempt chats (`attempt`); workflow step chats and step tests (`workflow`, `workflowTest`); chats driven
    from Telegram or Slack (`channel`) and voice requests (`voice`), where the user answers away from the composer;
  - the last item is an `assistant` item with text (an error, a notice, a stopped turn all fail this);
  - `suggested.after` is not already the last item's id (a Compact, or any idle that added no item, reads nothing
    twice);
  - `asksUser` passes on the text read (below).
- What is read:
  - Single chat: the last item's text. The user message is the last `user` item before it.
  - Room: members of one round often finish in parallel, so the last item can be a member's "Done" while another
    member asked the user to choose. The reader takes every member's last `assistant` text after the last `user` item,
    in order, each headed by the member's display name; the reply tail cap (4 000 characters) applies to their joined
    text, keeping the end. `asksUser` passes when any of those texts passes it.
- One read per chat at a time: a new idle aborts the earlier read for that chat.

### Where options live

- `ChatMeta.suggested?: { after: string; options: string[] }`, `after` being the id of the chat's last item when the
  read began (in a single chat, the reply read; in a room, the round's last item). Meta, not
  items: nothing is written into the item list after the turn released the chat, so no item write can race a new
  send, and exports, search, versions and the item feed stay untouched.
- Write: `store.patchInPlace(chatId, cur => ...)`, which returns null (no write) when `cur.inFlight` is true or when
  nothing changes. Options `[]` are stored too (`{after, options: []}`), so the same reply is never read again; the
  frontend treats an empty list as nothing to show. The new meta is pushed (`kind: 'meta'`), so every tab gets it.
- A stale value is harmless: the frontend shows options only when `after` is the id of the chat's last item.

### The setting

- `AppSettings.suggestedReplies: boolean`, default true (`raw.suggestedReplies !== false` in `settingsStore.ts`).
- `ZumiBotApi.app.getSuggestedReplies()` / `setSuggestedReplies(on)` (handler `app:getSuggestedReplies` /
  `app:setSuggestedReplies`, mapping in `net/api.ts`), as house style does.
- Every open tab must learn a change at once, so the block disappears everywhere: the setter broadcasts a server event
  (for example `app:suggestedReplies {on}`, the way `sidebar:changed` is broadcast). The frontend reads the setting on
  connect and on that event, and shows nothing until it knows the setting is on.
- Settings page: a switch next to house style. Label "Suggested replies"; hint "After a reply that asks you something,
  offer what you might send next. Uses a small Haiku call per reply."

### Frontend

- Pure rule (`state/replyOptions.ts`, tested): `replyOptionsOf({ suggested, lastItemId, running, draftEmpty, on })`
  returns `{ buttons: string[] }`, `{ placeholder: string }` or null. Null when the setting is off, the chat or any turn
  in it is running, `after` is not the last loaded item's id, or `suggested` is absent or empty. Buttons only while the draft
  is empty (no text, no files, no reply quote): typing hides them. The placeholder only while the draft is empty.
- Buttons (`ReplyOptions.tsx`): a row of pill buttons right above the composer, where the task tray sits (also on
  mobile and in the Island's compact view). A click calls ChatView's `send(option)`. After the click the chat runs, so
  the rule hides them.
- Composer: a new `suggestion?: string` prop. With an empty box it is the placeholder, with a small "Tab" hint. Tab with
  an empty box, no menu open, no modifier and not composing writes the suggestion into the box with the caret at the
  end, and is consumed; otherwise Tab behaves as today. On a coarse pointer the hint is a small button that does the
  same. Rooms: the suggestion replaces `GROUP_PLACEHOLDER` while it shows.

### Docs and tests

- `docs/architecture/ui.md`: a "Suggested replies" paragraph next to "Ack line"; `backend/src/core/chat/CLAUDE.md`
  points `replyOptions.ts` at it; `data.md` if it lists `ChatMeta` fields.
- User docs: a section in `zumi-bot-docs/.../chatting/chats-and-composer.mdx`.
- Backend tests: the reader's args, prompt caps and parse cases (shape, too many, `/` and `@`, duplicates, bad JSON),
  `asksUser`; the service's gates (setting off, inFlight, paused, each skipped chat kind, last item not a reply, already
  read, no `?`), the room read (several members, the asking one not last), the guarded meta write and the abort of an
  earlier read, with a fake `claude` script as `acknowledge.test.ts` uses.
- Frontend tests: `replyOptionsOf` cases.

## Left to the builder

- File and component names above are proposals.
- Whether to also abort a read when the chat is claimed again (the write guard already makes it safe).
- The exact wording of the system prompt, within the rules above.
- The look of the buttons and the Tab hint, within the app's existing pill and hint styles.
- Whether an e2e case is worth adding.

## Calls made by Claude (not discussed with the user)

- Up to 3 buttons, not only 2, so a reply offering three named choices still gets buttons.
- A button's text is exactly the message it sends.
- Buttons sit right above the composer, not inside the message list.
- Options are stored in chat meta, not on the reply item.
- The `?` gate, the input caps, the 80-character option cap and the 20 s timeout.
- Which chats get options: single chats, rooms and routine runs do; asked, task, card-comment, attempt, workflow step,
  channel and voice chats don't.
- In a room, every member's last reply of the round is read, not only the last item.
- A reply already read (same last item) is never read again, so a Compact costs no extra call.
