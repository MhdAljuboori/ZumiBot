# Hive recall: agents search past chats

## Intent

An agent can look up what was said in earlier chats on its own, so "what did we decide last week?" just works. Read-only,
scoped, and off unless the user turns it on per agent. It reuses the message search index (`core/search/searchIndex.ts`);
no second index.

## Goals

- Per-agent opt-in, off by default.
- Two scopes: the agent's own chats, or every chat in the same folder (any agent: the "hive").
- Read-only: search and read, never write, edit or delete.
- Works in single chats and rooms, on Claude and Codex.

## Non-goals

- No automatic injection of past messages into the prompt (costs tokens every turn and breaks the prompt cache).
- No semantic or vector search: the same word matching as the sidebar's message search.
- No access to tool calls, results, approvals or hidden items: only what the index already holds (user and agent text).

## Anti-goals

- An agent reading chats outside its scope, or naming a chat id to get around the scope.
- The bridge token or message text in logs.
- The tools showing up for an agent with recall off.

## Approaches

1. **Own MCP bridge `zumibot_recall` (picked).** Same pattern as the vault list tool: a per-turn capability token, the
   server knows the chat and the speaking agent, the bridge carries nothing of its own. Works in rooms and for Zumi Bot.
2. Add the tools to the ask bridge (`zumibot_agents`). Less code, but that bridge exists only for single chats and never
   for Zumi Bot, so rooms would get no recall.
3. Inject recalled snippets into the prompt each turn. Not a tool, costs tokens every turn, breaks the cache prefix.

## Design

- **Setting.** Frontmatter key `recall: agent | folder` (ZumiBot-only, like `memory`). Absent or anything else = off.
  Agent Studio: a **Recall** card with Off, Own chats, This folder. Not shown for ACP or remote agents (no bridges).
- **Scope** (checked on the server, per call, from the token's owner):
  - `agent`: single chats whose agent is the speaking agent, and rooms where it is a member.
  - `folder`: every chat whose folder equals the current chat's folder. A chat's folder is `worktree.folder ?? cwd`.
  - Archived chats are in. The chat the call comes from is out (its history is already the agent's).
- **Tools** (`mcp__zumibot_recall__search`, `mcp__zumibot_recall__read`):
  - `search {query, since?, until?, offset?}`: up to 10 hits, newest first: chat id, chat title, message id, date,
    who wrote it, snippet. `since`/`until` are ISO dates filtering by message time.
  - `read {chatId, messageId}`: that message's text (capped) and up to two indexed messages before and after it, in the
    same chat; the scope is checked again.
- **Approvals.** No card: the user's opt-in is the consent, as for the vault list.
- **Prompt.** One short paragraph, only when recall is on.
- **When the bridge exists.** Only on turns whose agent has recall on, on engines with `bridges`. A room member's
  setting is read per call, since the speaking member is known only when it runs; the bridge is attached for the room
  when any member has recall on, and a call from a member with recall off is refused.

## Left to the builder

Caps (read text length), exact tool descriptions and prompt wording, the Studio card's copy, tests.
