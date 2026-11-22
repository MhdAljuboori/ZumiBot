# Slim CLAUDE.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut root `CLAUDE.md` from 286 124 bytes to at most 16 384 by moving every feature paragraph, unchanged, into `docs/architecture/<area>.md`, with an index, folder pointer files and a guard test.

**Architecture:** A throwaway Node script splits the old file by paragraph start (from the spec's Mapping table) into 37 area docs and leaves everything else in root. Root then gets short pointer lines and a `## Docs by area` index. Folders that belong to one area get a pointer `CLAUDE.md`. A vitest test in the `shared` project keeps root small and every link and pointer valid.

**Tech Stack:** Markdown, Node 22 scripts (scratchpad only), vitest (`shared` project, node env).

**Spec:** `docs/superpowers/specs/2026-11-12-claude-md-slim-design.md`

## Global Constraints

- No `git commit` and no `git add` unless the user says so (user's global rule). Never `git stash`.
- Moved text is copied by script, never retyped. The only change to moved text is the cross-reference links the spec lists.
- Root `CLAUDE.md` ≤ 16 384 bytes.
- Area docs live in `docs/architecture/`; file names, titles and paragraph starts exactly as the spec's Mapping table.
- The old text is `git show c8615d5:CLAUDE.md`, saved first as `<scratchpad>/old-CLAUDE.md`. Every check compares against that file.
- Scripts go in the session scratchpad (`$SCRATCH` below), never in the repo.
- Worktree setup before any vitest, typecheck or build run: link `node_modules` as the `worktree-build-links` memory says (`node_modules/@zumibot/{backend,frontend,shared}` symlinks plus `frontend/node_modules` and `backend/node_modules` links to the main checkout).

## Review Focus

1. A paragraph lost, cut or changed during the move. Expect `ALL LINES PRESENT` from the completeness check (Task 1 Step 6, rerun in Task 3).
2. A link written inside a backtick code span, which then shows as raw text. Expect the link script to rewrite outside code spans only, and expect its change count to match its own match count minus the skipped ones (Task 1 Step 7).
3. An index line or pointer that names a real doc, but the wrong one. Expect each index line's "read when" paths to match the spec table; a reviewer checks this by reading, since no test can.
4. A pointer `CLAUDE.md` shipping in a build. Expect none under `zumi-bot-server/backend/dist` after `npm run build:server` (Task 3 Step 3).
5. Claude Code not loading folder `CLAUDE.md` files. Expect a fresh `claude -p` that reads a file in `core/codex/` to quote `docs/architecture/codex.md` (Task 3 Step 4).

---

### Task 1: Split into area docs, slim root, guard test

**Files:**
- Create: `zumi-bot-server/shared/tests/repoDocs.test.ts`
- Create: `docs/architecture/*.md` (37 files, names from the spec's Mapping table)
- Modify: `CLAUDE.md` (whole file rewritten by the split, then edited)
- Scratch: `$SCRATCH/old-CLAUDE.md`, `$SCRATCH/split-claude-md.mjs`, `$SCRATCH/check-moved.mjs`, `$SCRATCH/link-refs.mjs`

**Interfaces:**
- Produces: `docs/architecture/<doc>.md` for each Mapping row; root `CLAUDE.md` with `## Docs by area`; test file exporting nothing, with `describe('repo docs')`, which Task 2 extends. Task 2 reuses `ROOT: string`, `DOCS: string` and `docNames(text: string): string[]` from that file.

- [ ] **Step 1: Write the failing test** `zumi-bot-server/shared/tests/repoDocs.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DOCS = join(ROOT, 'docs/architecture')
// Root CLAUDE.md loads into every session; feature detail goes to docs/architecture.
const ROOT_MAX = 16_384

const areaDocs = () => (existsSync(DOCS) ? readdirSync(DOCS).filter(f => f.endsWith('.md')).sort() : [])
const docNames = (text: string) => [...text.matchAll(/docs\/architecture\/([a-z0-9-]+\.md)/g)].map(m => m[1])
// Code spans are dropped first: moved text quotes link syntax such as `[<name>](<path>)`.
const relLinks = (text: string) =>
  [...text.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map(m => m[1]).filter(t => !/^[a-z]+:/.test(t))

describe('repo docs', () => {
  it('keeps root CLAUDE.md within 16 KB', () => {
    expect(statSync(join(ROOT, 'CLAUDE.md')).size).toBeLessThanOrEqual(ROOT_MAX)
  })

  it('names every area doc in root CLAUDE.md, and only existing ones', () => {
    const named = [...new Set(docNames(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')))].sort()
    expect(areaDocs().length).toBeGreaterThan(0)
    expect(named).toEqual(areaDocs())
  })

  it('resolves every relative link in root CLAUDE.md and the area docs', () => {
    const files = [join(ROOT, 'CLAUDE.md'), ...areaDocs().map(f => join(DOCS, f))]
    const broken = files.flatMap(f =>
      relLinks(readFileSync(f, 'utf8')).filter(t => !existsSync(resolve(dirname(f), t))).map(t => `${f}: ${t}`))
    expect(broken).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts`
Expected: FAIL. The 16 KB test reports 279860; the index test fails on `areaDocs().length`.

- [ ] **Step 3: Save the old file**

Run: `git show c8615d5:CLAUDE.md > "$SCRATCH/old-CLAUDE.md" && wc -c "$SCRATCH/old-CLAUDE.md"`
Expected: `286124`.

- [ ] **Step 4: Write and run `$SCRATCH/split-claude-md.mjs <old> <repoRoot>`**

Data: the spec's Mapping table as `[{doc, title, starts: string[]}]`, plus the root-kept starts `**Transport.**`, `**Chat items as deltas.**`, `**Wiring.**`, `**Running claude.**`, `**Single chats vs. groups.**`, `**Dev/test hooks.**`. Rules:
- Every start (moved or kept) must match exactly one line by `line.startsWith(start)`; otherwise throw and name it.
- A block runs from its start line to the line before the next start line or `## ` heading, with trailing blank lines dropped. This makes the Auth block take its two bullets and the "Error messages…" line.
- Each doc is written as `# <title>\n\n` + its blocks in old-file order, joined by `\n\n`, plus a final `\n`.
- Root is the old file minus every moved block, with runs of 2+ blank lines collapsed to one.
- Print each doc's byte size and the root's.

Expected: 37 docs written; the largest is `e2e.md` (about 35 KB), then `codex.md` (about 26 KB); root is about 9 KB.

- [ ] **Step 5: Edit root `CLAUDE.md` by hand (Edit tool)**

Add exactly these, and nothing else:
1. After the Commands code block, where the moved Commands blocks were:
   `E2E suites, probes and the Codex smoke run: [docs/architecture/e2e.md](docs/architecture/e2e.md). Run \`npm run e2e\` after every Claude Code update: it checks the hidden \`--resume-session-at\`/\`--fork-session\` flags that edit and resend rely on. Deploy, \`npm run sync\` and the desktop Sync window: [docs/architecture/deploy-and-sync.md](docs/architecture/deploy-and-sync.md).`
2. In Layout, after the `docs/superpowers/` bullet: `` - `docs/architecture/` – one doc per feature area, moved out of this file; see Docs by area. ``
3. At the end of Architecture: `` **Data.** `ZUMIBOT_DATA_DIR`, default `~/.local/share/zumibot`; every file in it is listed in [docs/architecture/data.md](docs/architecture/data.md). ``
4. In Conventions, as the first bullet: `- Secrets never go into logs, URLs or error messages; error messages name the env var, never its value.`
5. A `## Docs by area` section before `## Testing notes`: the spec's root rules text (exact), a blank line, then one bullet per Mapping row in table order: `` - [<Title>](docs/architecture/<doc>): <Read when touching> ``.

- [ ] **Step 6: Run the completeness check `$SCRATCH/check-moved.mjs <old> <repoRoot>`**

It normalises Markdown links to their text (`/\[([^\]]+)\]\([^)]+\)/g` → `$1`) on both sides, then reports each non-blank old line that is not, after normalising, a whole line of root `CLAUDE.md` or of a doc. It prints `LOST: <first 100 chars>` per missing line, else `ALL LINES PRESENT`.

Run: `node "$SCRATCH/check-moved.mjs" "$SCRATCH/old-CLAUDE.md" .`
Expected: `ALL LINES PRESENT`

- [ ] **Step 7: Write and run `$SCRATCH/link-refs.mjs <repoRoot>`** for the spec's Cross-references rule

Sections are tried longest first, with a word boundary after the name, so `see Agents for` never takes `Agent asks` or `Agent memory`. For each of root `CLAUDE.md` and the area docs, outside backtick code spans only, it replaces `see <Section>` with `see [<Section>](<target>)` for each section in the spec's list, where target is `<doc>` inside `docs/architecture/` and `docs/architecture/<doc>` in root. It skips a section whose doc is the file itself. It prints every replacement (`file: see X → doc`), every skipped same-doc match, and every `see [A-Z]…` match left plain because it is not in the list.

Run: `node "$SCRATCH/link-refs.mjs" .`
Expected: replacements plus same-doc skips equal the occurrences of the listed sections in `grep -o 'see [A-Z][A-Za-z -]*' "$SCRATCH/old-CLAUDE.md"`. Each plain match is reported to the user (none expected beyond `Hooks`).

- [ ] **Step 8: Rerun the completeness check (links must not have broken a line)**

Run: `node "$SCRATCH/check-moved.mjs" "$SCRATCH/old-CLAUDE.md" .`
Expected: `ALL LINES PRESENT`

- [ ] **Step 9: Run the test and see it pass**

Run: `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts`
Expected: 3 passed. If the 16 KB test fails, shorten index lines, never moved text.

### Task 2: Folder pointer files and other references

**Files:**
- Create: 28 `CLAUDE.md` pointer files, exactly the folders in the spec's "Pointer `CLAUDE.md` files" section
- Modify: `zumi-bot-server/backend/src/core/chat/chatTmp.ts:7` (comment only)
- Modify: `zumi-bot-server/deploy/SETUP-VPS.md:114`
- Modify: `zumi-bot-server/shared/tests/repoDocs.test.ts` (one more test)

**Interfaces:**
- Consumes: `ROOT`, `DOCS`, `docNames` from Task 1's test file.

- [ ] **Step 1: Add the failing test** to `describe('repo docs')`

```ts
// Folder CLAUDE.md files load when Claude reads a file there; each must lead to a real doc.
const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'release', '.git', '.claude'])
function nestedClaudeMds(dir = ROOT, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP.has(e.name)) nestedClaudeMds(join(dir, e.name), acc)
    else if (e.isFile() && e.name === 'CLAUDE.md' && join(dir, e.name) !== join(ROOT, 'CLAUDE.md')) acc.push(join(dir, e.name))
  }
  return acc
}

it('points every folder CLAUDE.md at existing area docs', () => {
  const files = nestedClaudeMds()
  expect(files.length).toBeGreaterThanOrEqual(28)
  const bad = files.flatMap(f => {
    const named = docNames(readFileSync(f, 'utf8'))
    return named.length === 0 ? [`${f}: names no doc`] : named.filter(d => !existsSync(join(DOCS, d))).map(d => `${f}: ${d}`)
  })
  expect(bad).toEqual([])
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts -t "folder CLAUDE.md"`
Expected: FAIL with `expected 0 to be greater than or equal to 28`.

- [ ] **Step 3: Write the 28 pointer files**

Each file has a `# <folder> — docs` heading and then lines of the form `` Before changing code here, read `docs/architecture/<doc>` (repo-root path). ``, one per doc the spec names for that folder. `core/chat/CLAUDE.md` instead lists the spec's per-file mapping as bullets (`` - `pauseSettings.ts`, `pauseHook.ts`, `chatTmp.ts`: `docs/architecture/pause-resume.md` ``), ending with the "everything else" line. No feature text goes in any pointer.

- [ ] **Step 4: Update the two references**

`chatTmp.ts:7`: `(see CLAUDE.md, Data)` → `(see docs/architecture/data.md)`. `SETUP-VPS.md:114`: the Vault paragraph reference → `` `docs/architecture/vault.md` ``. Then run `grep -rn "CLAUDE.md" zumi-bot-server --include=*.ts --include=*.mjs --include=*.md | grep -v node_modules`. Expected: only `deploy/sync.mjs` (`~/.claude/CLAUDE.md`) and `deploy/workflows/w5-design-audit.mjs` (another repo's).

- [ ] **Step 5: Run the test file and see it pass**

Run: `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts`
Expected: 4 passed.

### Task 3: Whole-change verification

**Files:** none changed.

- [ ] **Step 1: Full unit tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: every project passes; typecheck exits 0. Only the `chatTmp.ts` comment changed in code.

- [ ] **Step 2: Completeness and size, once more**

Run: `node "$SCRATCH/check-moved.mjs" "$SCRATCH/old-CLAUDE.md" . && wc -c CLAUDE.md && ls docs/architecture | wc -l`
Expected: `ALL LINES PRESENT`, a size ≤ 16384, and `37`.

- [ ] **Step 3: No pointer reaches a build**

Run: `npm run build:server && find zumi-bot-server/backend/dist -name CLAUDE.md | wc -l`
Expected: `0`.

- [ ] **Step 4: Claude Code loads folder pointers (one short `claude` call, costs a few cents: ask the user first)**

Run from the worktree root: `claude -p --max-turns 3 "Read the first 5 lines of zumi-bot-server/backend/src/core/codex/codexRunner.ts. Then say which docs/architecture file any CLAUDE.md in that folder tells you to read, quoting its path."`
Expected: the answer quotes `docs/architecture/codex.md`. If it does not, report it: the root index still works, but the spec's Goal 3 needs another way in.

- [ ] **Step 5: Report to the user**

Report the root size before and after, the doc count, the plain `see` matches left (Task 1 Step 7), and the result of Step 4. Leave everything uncommitted; the user decides about commits.
