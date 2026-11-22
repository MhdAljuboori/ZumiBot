# Chat export (Markdown and HTML)

## Why

A result reached in a chat often has to leave the app: pasted into a GitHub issue or Slack, mailed, or handed to someone
with no ZumiBot. Copy on one message gives raw Markdown of that message only; there was no way to take a chat, or a
reply, out as a file that reads well elsewhere.

## What

- **Entry points.** Export… in a chat or room row's menu (sidebar and Archived), and Export reply in an agent message's
  hover actions. One dialog for all of them.
- **Dialog.** Format: Markdown (`.md`) or a web page (`.html`). Include tool steps and errors (off). Opened from a
  message: This reply (default) or Whole chat. Download saves the chosen format; Copy Markdown copies Markdown.
- **Content.** The conversation: user messages (with attachment names), agent replies, answered questions with their
  answers, plans. With steps: one line per tool call (`toolSummary`), errors, unanswered questions. Never: notices,
  approval cards, browser/desktop handoffs, vault cards, side questions, to-dos, dispatched agents' insides, hidden
  message versions, or the chat's folder (a local path means nothing to the reader and may say too much).
- **Reply scope.** The agent's run of items around the message, up to the next user message or another agent's message.

## How (decided)

- **Server-side.** The client loads chats newest-first in pages, so only the server has the whole history. A gated
  `GET /api/export/<chatId>` reads the stored items and returns the text; the dialog saves it through a blob. HTTP, not
  the RPC socket, so a big export never holds up pushes on the shared socket.
- **Served as text.** The route always answers `text/plain` + nosniff with an attachment name, never `text/html`, so an
  exported page can never run on the app's origin.
- **HTML is built by allowlist.** Messages parse as the chat parses them (GFM, math, the shared Pandoc price rule), raw
  HTML becomes text as in the chat, and a small serializer emits only Markdown's own elements and fixed attributes. Links
  must be relative, http(s) or mailto; images https only. The page has no script and a CSP meta that allows inline style
  and https images only.
- **Self-contained page.** Inline CSS, light and dark from `prefers-color-scheme`, per-block bidi so Arabic reads right.
- **Times** in the page's own zone (sent with the request), else the last zone the page reported, else the server's.
- **Copy is Markdown only.** It is the format chat apps, issues and docs accept as pasted text; HTML source would not be.

## Calls made without the user (they skipped the questions)

- Steps off by default: sharing a result usually wants the answer, not the tool log.
- Math stays TeX source and Mermaid stays a code block in the HTML page: rendering them would mean shipping KaTeX's CSS
  and fonts or Mermaid's script inside every file.
- Remote https images in a reply still load when the page is opened (as they do in the chat).
- No PDF: a browser's Print to PDF of the HTML page covers it.

## Limits

- An export made while a reply streams holds what was last saved (about once a second).
- A link to an app address (`/chat/<id>`) is kept but leads nowhere outside the app.
