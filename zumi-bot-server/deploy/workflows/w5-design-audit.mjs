#!/usr/bin/env node
// The "W5 design audit" workflow: the 5-6 Nov 2026 hand-run audit (a ui-ux-specialist chat that scanned the 36 parents of
// the Workiom W5 Backlog against https://workiom.github.io/v5/ and filed 170 cards) as a workflow.
// Design: docs/superpowers/specs/2026-11-08-w5-design-audit-workflow-design.md
//
// Usage (needs a ZumiBot build that has the For each step):
//   node zumi-bot-server/deploy/workflows/w5-design-audit.mjs            # add it to the data dir's workflows.json
//   node zumi-bot-server/deploy/workflows/w5-design-audit.mjs --update   # replace the steps of the one already there (id, switch, runs kept)
//   node zumi-bot-server/deploy/workflows/w5-design-audit.mjs --print    # print the definition, change nothing
//   --data-dir <dir>  (default: $ZUMIBOT_DATA_DIR or ~/.local/share/zumibot)   --time-zone <zone>
// It refuses when a workflow of that name exists, never touches another one, and writes the file atomically. Run it
// while no workflow is being saved in the app (the app and this script both rewrite the file whole).
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME = 'W5 design audit'
const REPO = '/home/mhdaljuboori/Developments/Angular/WebFrontend'
const APP = 'Product New'
const LIST = 'W5 Backlog (list 9cda7a92-3626-4222-81b8-c59c678b60b5 in app f8d95a2d-057c-4a73-b01f-044150a315be)'
const DESIGN = 'https://workiom.github.io/v5/'
const QA =
  'tenant e2e, with the Vault login item named "E2e Workspace" (its username and password; you never see them: browser_fill_from_vault types them for you)'
const LAST_LINE = 'End your reply with exactly one last line: RESULT: OK or RESULT: FAIL followed by a short reason.'

const PREPARE = `Set up the environment for a Workiom W5 design audit. The Workiom frontend repo is ${REPO}. No code changes to that repo, no commits, no pushes.

Do these in order and stop at the first failure:
1. Audit folder: AUDIT=$HOME/w5audit-$(date +%F) (if it exists, add -2, -3 ... until it is new). Make it with the subfolders parents, design, shots.
2. Worktree: git fetch origin workiom-v5 in the repo, then a detached worktree at ${REPO}-w5audit on origin/workiom-v5 (if that path exists and is a registered worktree, reuse it and reset it to origin/workiom-v5; if it exists but is not, stop with FAIL). Reuse the main checkout's node_modules or run the usual install in <worktree>/angular if it is missing.
3. Dev server: port 4200 must be free (check with ss -ltnp 'sport = :4200'); if something listens there, stop with FAIL (never kill it, never start a second server). Start ng serve detached from <worktree>/angular with setsid nohup yarn start > $AUDIT/ng.log 2>&1 &, record its PID (and its launcher shell's PID), and wait until the log says the build finished and curl http://localhost:4200/ returns 200.
4. Design copy: save ${DESIGN} to $AUDIT/design/index.html (curl). If the page links a design-system bundle, save it under $AUDIT/design/ds/.
5. Check: curl -s -o /dev/null -w '%{http_code}' ${DESIGN} must return 200 and $AUDIT/design/index.html must be larger than 100 KB. You do not sign in or open a browser: the reviewers use ZumiBot's agent browser with the Vault login.
6. Write $AUDIT/README.md with the rules the reviewers follow: one area at a time; shots are saved with browser_save_screenshot and copied into $AUDIT/parents/<Parent-NNN>/shots/ with cp; never print or write the QA password (they never see it); never change the account language; any test data created in the QA account is logged in $AUDIT/test-data.md (what was created, and deleted or not) and deleted by the reviewer that made it, else by the Clean up step.

Reply with these lines (they become the facts every later step reads): AUDIT=<folder>, WORKTREE=<path>, BASE=<commit hash served>, PORT=4200, PID=<server pid> LAUNCHER=<shell pid>, LOG=<path>. ${LAST_LINE}`

const RESOLVE = `Turn the user's request into the exact list of W5 Backlog parent cards to audit. The Workiom list is ${LIST}; use the Workiom CLI (workiom, see your workiom skill). The parents are the records whose Key starts with Parent- (there are 36 today: Parent-107 Grid View ... Parent-230 Org Chart View). List them with a Key contains Parent filter and page with --limit 10 (larger limits silently return only 10) until a page is empty; use the Summary field as the area name.

The request (may be empty):
{{trigger.text}}

Rules:
- Empty, or the word All (any case): every parent.
- Otherwise the request names areas, separated by commas, semicolons, or new lines: each is a parent key (Parent-226, or just 226) or an area name matched without case against the Summary, exact first, else a single unambiguous partial match (Gallery matches Gallery View). A bare word may match several parents (for example Views): then do not guess, list them as the problem.
- Keep the order the user wrote, or key order for All. No repeats.

Reply with ONLY the list, one line per parent, in this exact form: Parent-NNN Area name (e.g. Parent-226 Gallery View). No other text, no bullets, no heading.
If any part of the request cannot be matched or is ambiguous, reply instead with ONE line starting with ERROR: that names the unmatched or ambiguous text and the closest parent names. Never reply with a partial list plus an error.`

const SCAN = `You are the UI/UX reviewer doing ONE small, bounded piece of a full W5 design re-scan of the Workiom frontend: the parent area

{{item}}

(the key is the first word, the rest is its name). Compare the product with the live Workiom 5.0 design ${DESIGN}. Environment facts from the setup step (AUDIT folder, worktree, commit, port):

{{steps.prepare.output}}

Your output file is $AUDIT/parents/<Parent-NNN>/findings.md. Write it FIRST, within about 10 tool calls of starting (counts line and the findings you have so far), then keep appending after every surface you check, so a cut-off loses nothing. If that file already exists (a retry), read it and continue instead of starting over.

## What to compare
- Design: ${DESIGN}, source copy $AUDIT/design/index.html. Dated design decisions are comments like (29 Oct 2026, Homam: ...): grep -nE '\\((\\d{1,2}) (Oct|Nov) 2026' on it. Changes after a card merged are the main reason old cards are wrong. The design's base components (central controls) are the [style*="--wk-..."] CSS at the top of index.html and the producers textBoxSt, searchBoxSt, menuRowSt, menuPick, secBtn, smBtn, ghostBtn, primaryBtn, iconBtnSt, tagSt, valueChipSt, toggleChipSt, cardSt, listRowSt, dialogTitleSt, panelHeadSt, raisedBoxSt, sectionHeadSt, countSt, countPillSt, inlineBar.
- Product: http://localhost:4200, reached with ZumiBot's agent browser (see How to browse and shoot). Read code in the worktree, never edit it.
- Cards: the Workiom list is ${LIST}. Pull every subtask of your parent (all statuses) with the Workiom CLI (page with --limit 10; larger limits return only 10) and save them as $AUDIT/parents/<Parent-NNN>/cards.md with each card's key, status, summary and description. These are the cards you must judge.

## How to browse and shoot
Read $AUDIT/README.md first and follow it. You work with ZumiBot's agent browser tools (browser_navigate, browser_observe, browser_click, browser_type, browser_select, browser_scroll, browser_hover, browser_set_viewport, browser_computed_style, browser_save_screenshot, browser_fill_from_vault, browser_release); never a system browser, never Playwright scripts.
- Window: browser_set_viewport 1440 x 900 first (add 1920 or a narrow width only where layout depends on width), then browser_observe again (it replaces the element references). Set it again if a saved shot's width differs from what you set.
- Sign in to the product (${QA}): browser_navigate to http://localhost:4200, browser_observe; if a sign-in page shows, type the tenant e2e in its tenant field if there is one, call vault_items to get the item id of "E2e Workspace", and browser_fill_from_vault its username and then its password into the sign-in fields (never browser_type for them), then submit. The browser keeps the session between areas, so a signed-in page needs nothing. If you cannot sign in after two tries, do not ask the user for help (nobody is waiting): write findings.md with one line "BLOCKED: sign-in" and finish.
- The design page: browser_navigate to ${DESIGN}. If a welcome overlay shows, click through it. Its clickable things are mostly spans, so use the references browser_observe gives you; when something cannot be reached, read its state from the source copy $AUDIT/design/index.html instead and say "code-only" under Verified.
- Themes: light is the default in both; switch to dark by the theme control in the UI (the design has a toggle; the product has it in its settings), shoot, then switch back.
- Measure with browser_computed_style (stamp and ref from the latest observation): it gives colour, background, font, spacing, border, radius, shadow and size. For hover states browser_hover the element, then shoot or measure it with the same stamp and ref.
- Evidence: browser_save_screenshot (name like p226-row-hover-product-light, lowercase letters, digits, - and _ only; with ref and stamp for one element; fullPage only without a ref) returns a file path. Copy each file you need into $AUDIT/parents/<Parent-NNN>/shots/ with cp, keeping the name, and refer to it by that path. Take the design and the product shot of the same state with the same viewport; the name ends in -design or -product.
- Call browser_release when you finish the area, so the next area starts clean. If a page dialog is pending, answer it with browser_dialog; if a result says dialog_interrupted, run the command again.

## Checklist
1. Enumerate every surface of the area in the design: pages, every tab, every menu (more, right-click, dropdowns), every dialog, popover, panel and side sheet, every setting and button, and states (rest, hover, focus, active, disabled, empty, loading, error, long text).
2. Reach the same surface in the product and compare: spacing, sizes, type (size, weight, line-height), colours (measure them), radii, borders, shadows, icons (name, weight Light or Regular, size), alignment, copy casing, order.
3. For every Merged card decide whether what it shipped still matches the current design: still valid, superseded (the design changed after it: say what and when), regressed (the product drifted), or incomplete.
4. Record the surfaces that match too (Checked OK), so we know the area was covered.

## What counts
- Only fail what the product can support. Skip design-only features: AI agents as identities, trust, permissions or asks, agent activity dock, Mila settings page, Spaces, vibe surfaces beyond today's feature, app home or overview pages, personas, Mila onboarding, guide or tour, keyboard hint bar, connected tools or MCP, voice input, chat attachments, prototype modes, Skills, Data sync, My day, threaded comments, snooze, Map pins and new view types the product lacks, Start the list and New view Mila panels. When unsure, list it under Skipped (feature).
- Raw localization keys (like EditAppTitle) are expected locally and are never a finding. Title Case that comes from a real English value is a finding only if the design shows sentence case (note the key name).
- Standing rulings (do not re-file): kit menu rows (14px label, 32 row, 15 glyph) beat design menu rows except the picked-row fill; kit components beat per-screen design variants (no one-caller look); "+ App" stays "New App"; create and confirm buttons keep the app colour; design-system heights (labelled buttons 28, inputs 32); entity-card busy fade kept; dark filled controls stay solid under white ink; the worktree's docs/w5-known-differences.md lists accepted differences.
- Before filing a finding, check the open W5 Backlog cards (not Merged, not Canceled) for the same thing; if one exists, report it as a gap in that card instead of a new finding.

## findings.md format
First line: <Parent-NNN name>: N findings (B blockers, S should-fix, n nits); M merged cards checked: v valid, s superseded, r regressed, i incomplete. Then one block per finding:
### <PREFIX>-<NN> . <Blocker|Should-fix|Nit> . <short title>   (PREFIX = the parent's number, e.g. P226)
- Parent: <key and name> . Old card: <KEY superseded|regressed|incomplete> or none
- Where: <screen/state> . <file:line in the worktree if known>
- Now: <product value(s), measured>
- Design: <value(s)> . element or producer name . date if dated
- Fix: <kit component, token or role to use; kit-wide or local>
- Kit: fits | extends kit once (what) | outside kit (why)
- Evidence: parents/<Parent-NNN>/shots/<name>-design.png and <name>-product.png (the same state, same viewport), more shots if needed
- Verified: measured | visual | code-only
One cause is one finding (list every screen it touches). Then the sections: ## Old cards (table: key, verdict, one-line reason), ## Checked OK, ## Skipped (feature), ## Unverified (what shot would settle it), ## Questions (only real decisions for the user, each with options and a Recommended one).

## Do not
Edit the repo, commit, push, create or edit Workiom cards, post comments, use the ZumiBot app browser, or change server or account settings. Close every browser you start.

Your final reply (at most 150 words): the counts line, the 3 most important findings (one line each), old-card verdict counts, any test data you created and deleted, and the findings.md path.`

const CONSOLIDATE = `Consolidate a finished W5 design re-scan of the Workiom frontend (product vs the live design ${DESIGN}). Do NOT shoot anything new; work from the files.

Facts from the setup step:
{{steps.prepare.output}}

What the per-parent reviewers answered (their summaries; the full findings are in the files):
{{input}}

Inputs: every $AUDIT/parents/*/findings.md and cards.md, and the open W5 Backlog cards (${LIST}; use the Workiom CLI, page with --limit 10). If a parent listed above has no findings.md, say so in the file's header and carry on.

Produce $AUDIT/consolidated.md. Save it with ONE shell command (python or cat with a heredoc) after the first third of the work, then rewrite it as you go. Contents:
1. Header: totals (cards, by severity, by parent), the commit the scan used.
2. Cards: one card per cause. Merge findings that share a cause across parents (kit-wide items such as icon buttons, search in menus, glyph sweeps, scrollbars, focus rings, confirm dialogs, dialog close buttons, and every Title Case localization value, which becomes ONE localization card listing key, current value, sentence-case value). For each card: "### C-NN . <Blocker|Should-fix|Nit> . <title>", then Parent (the W5 Backlog parent it belongs to; kit-wide causes go under the Kit parent, overlay or theme causes under theirs), Merges (finding ids), Sites (every screen with file:line), Now, Design (value, producer, date), Fix, Kit (fits, extends once, outside), Old cards (keys superseded, regressed or incomplete that this card replaces or continues), Evidence (shot image paths, design and product, existing files only; check each with ls), Depends on (question numbers). Severity is the highest among the merged findings. Keep each card to 12 lines.
3. Gaps in open or merged cards: per card key, what the re-scan found missing or regressed, and whether it needs a NEW follow-up card (merged cards) or a note on the open card.
4. Old-card verdicts: one table of every merged card judged superseded, regressed or incomplete (key, verdict, parent, which C-NN covers it).
5. Questions for the user: dedupe the Questions sections into one numbered list, grouped; each with options and a Recommended one, and which C-NN cards wait on it.
6. Skipped and unverified, in a few lines.
Do not invent findings and do not drop any: every finding id must appear in exactly one card's Merges line, or under Gaps, or as "Dropped (reason)". End the file with a check list: every finding id and where it went.

Your final reply: ONE line of counts (cards by severity, number of questions) and the path. ${LAST_LINE}`

const STRUCTURE = `You are the structure reviewer for a W5 design re-scan of the Workiom frontend. Read-only review: no repo edits, no commits.

Facts from the setup step (the worktree is the code to review; paths below are under its angular/src/):
{{steps.prepare.output}}

Input: $AUDIT/consolidated.md (the cards, UI part written by the UI/UX reviewer). Project rules: ${REPO}/CLAUDE.md (v5 rules: tokens only, kit-first, logical properties, the lint and test gates it names).

Work in batches of about 40 cards so no context grows too large: for each batch run ONE subagent (the Agent tool) that reviews only that batch and writes $AUDIT/structure-<n>.md with ONE shell command, saved after the first ~15 cards and rewritten as it goes. Each card gets a structure part of 5-10 lines:
1. Re-check at the audited commit: is the described state still in the code (still present, fixed, changed)? Mandatory for cards the consolidated file marks RECHECK. Correct wrong file:line pointers.
2. Files to change, and whether it belongs in the kit (src/styles/w5, src/app/w5) or locally; any new token, parts entry, icon name or localization key; which callers it reaches.
3. Gates to run and baselines to re-shoot.
4. Kit verdict: fits, extends once (what), or outside (why).
5. Split, merge and order advice, and file collisions with other cards.
6. Anything in the UI part that contradicts the code.
Each batch file ends with a "## Collisions and merge order" section and a "## Questions" section (only real decisions).

When every batch is saved, YOU (not a subagent) check that each card has a structure part, and write $AUDIT/questions.md: the UI questions and the structure questions merged into one numbered list (Q1..Qn, S1..Sn), each with options and a Recommended one, grouped by theme, with the cards that wait on each.

Your final reply is what the user reads in the approval step, so make it complete and short: line 1: counts (cards by severity; how many structure parts say still present, fixed, changed; cards that should be dropped because they are fixed). Then the list of questions exactly as in questions.md (each one with its options and the Recommended one marked), then the folder path. ${LAST_LINE}`

const BUILD = `Build the final card set from the audit, applying the user's answers.

Facts from the setup step:
{{steps.prepare.output}}

The user's answers (empty text means every question takes its Recommended option; text and notes below override the questions they name):
{{input}}

Inputs: $AUDIT/consolidated.md, $AUDIT/structure-*.md, $AUDIT/questions.md. Apply the answers: drop, add, split or reword cards as they decide, and drop every card whose structure part says fixed. For the cards that remain write $AUDIT/cards-batch-1.md, cards-batch-2.md ... of at most 40 cards each, ordered by parent. Each card is one block:
### C-NN . <Severity> . <Type> . <Summary>
Type is Design Issue, Design Mismatch, Re-skin or Missing Feature (the W5 Backlog Type options). Then Parent: Parent-NNN (its Parent Task), Images: (paths of existing evidence files relative to $AUDIT; verify each with ls; at most 4), Land after: (other C-NN ids or none), and the body: UI part, Structure part, Checks to run, and one line "Found in the W5 design audit of <date> at <commit>. Decisions: <the answers that shaped this card>".
Also write $AUDIT/notes.md: the gaps in open or merged cards from the consolidated file that need a comment on an open card (card key, text).

Final reply: ONE line: number of cards, number of batch files, number of notes. ${LAST_LINE}`

const FILE = `Create the W5 Backlog cards from the audit. The Workiom list is ${LIST}. Use the Workiom CLI (see your workiom skill; attach images with the CLI's attach feature, never as links).

Facts from the setup step:
{{steps.prepare.output}}

Batches: $AUDIT/cards-batch-1.md, cards-batch-2.md ... Do one batch at a time, in order. Each "### C-NN . <Severity> . <Type> . <Summary>" block is one card: Summary = the card title; the Parent: line is its Parent Task (resolve the record by its Key); Type = the matching W5 Backlog Type option; Status To Do. Description = everything under the heading plus two lines you add at the top: "Audit id: C-NN" and "Severity: <Blocker|Should-fix|Nit>". Attach every file on the Images: line (paths relative to $AUDIT; retry on ECONNRESET).

Rules:
- Before creating a card, search the OPEN W5 Backlog cards (not Merged, not Canceled) for one that already covers the same thing. If one exists, do not create: add the card's text as a comment on it and note it.
- If a create call times out, search for the title before retrying, so no duplicate is made.
- Leave Land after: references as C-NN while creating; when all batches are done, one pass replaces each C-NN with the real key.
- Keep a mapping file $AUDIT/created.json: after EACH card append {"C-NN": "<KEY>"} (keep it valid JSON), so a cut-off loses nothing. If the file already exists (a retry or a continue), skip every card already in it.
- Then post each note from $AUDIT/notes.md as a comment on its card (the user's rule: attach images to comments with the attach feature, never as links).
- If a usage limit or an error stops you, stop and report how far you got.

Start your reply with ONE summary line of at most 150 characters (cards created, merged into existing, notes posted, errors). After it: the C-NN to key table and anything skipped. ${LAST_LINE}`

const CLEANUP = `The W5 design audit has ended; clean up what it created. No repo commits or pushes. What led here (a summary of the audit, or why it stopped):

{{input}}

Facts from the setup step (if it failed before they existed, clean up only what exists):
{{steps.prepare.output}}

1. Keep $AUDIT: the shots and cards are referenced by the cards. There is no session file to delete: the QA session lives in the reviewers' agent browser profile, which you leave alone.
2. Remove any test data the audit created in the QA account, using the log $AUDIT/test-data.md (delete what is logged as created and not yet deleted, confirm each). Only if the log lists something left, do it with ZumiBot's agent browser (browser_navigate to http://localhost:4200, sign in with the Vault login item "E2e Workspace" via vault_items and browser_fill_from_vault, never browser_type for the password, then browser_release); if nothing is left, skip the browser.
3. Stop the audit dev server by PID (the PID and its launcher shell PID), never with pkill -f. Confirm with ss -ltnp 'sport = :4200' that nothing listens.
4. Remove the worktree with git worktree remove (add --force only if it refuses because of untracked build output like .angular/), then git worktree prune. It is detached and unchanged; if it holds changes you did not make, leave it and say so.
5. Make sure nothing from the audit still runs (the dev server was step 3); the agent browser needs no cleanup beyond browser_release.

Reply with ONE first line that says the outcome in at most 150 characters (for example: Audit done: 170 cards filed, cleaned up. or Audit stopped: <why>, cleaned up.), then one line per step: done, or what you saw. ${LAST_LINE}`

const CHECK_OK = 'Look only at the last non-empty line of the material. Is it exactly `RESULT: OK`?'
const base = (id, name, x, y) => ({ id: `s-${id}`, handle: id, name, x, y })
const agent = (id, name, x, y, who, prompt, model) => ({
  ...base(id, name, x, y),
  kind: 'agent',
  agent: who,
  prompt,
  cwd: REPO,
  ...(model ? { model } : {})
})
const edge = (from, to, port = 'out') => ({ id: `e-${from}-${port}-${to}`, from: `s-${from}`, port, to: `s-${to}` })

export const definition = {
  name: NAME,
  enabled: true,
  trigger: { kind: 'manual' },
  steps: [
    { ...base('start', 'Areas to audit', 0, 0), kind: 'trigger' },
    agent('prepare', 'Prepare', 300, 0, 'code-specialist', PREPARE, 'sonnet'),
    { ...base('prepare-ok', 'Prepared?', 600, 0), kind: 'condition', question: CHECK_OK, model: 'haiku' },
    agent('resolve', 'Resolve areas', 900, 0, 'work-assistant', RESOLVE, 'sonnet'),
    {
      ...base('resolve-ok', 'Areas found?', 1200, 0),
      kind: 'condition',
      question:
        'Is the first non-empty line of the material a line that starts with `Parent-`? (An answer that starts with ERROR: is not.)',
      model: 'haiku'
    },
    { ...base('scan', 'Scan each area', 1500, 0), kind: 'foreach', agent: 'ui-ux-specialist', prompt: SCAN, cwd: REPO },
    agent('consolidate', 'Consolidate', 1800, 0, 'ui-ux-specialist', CONSOLIDATE),
    agent('structure', 'Structure part', 2100, 0, 'structure-reviewer', STRUCTURE),
    {
      ...base('review', 'Review the cards', 2400, 0),
      kind: 'approval',
      editable: true,
      question:
        '**The audit scan is done.** Below: the counts and every open question, each with its Recommended option.\n\n- **Approve** as is to take the Recommended option on every question.\n- To decide differently, edit the text (or add a note naming the question and your choice), then **Approve**.\n- **Reject** to stop here; nothing is filed. The audit folder stays for you to read.\n\nNothing has been created in Workiom yet.'
    },
    agent('build', 'Build the card set', 2700, 0, 'ui-ux-specialist', BUILD),
    agent('file', 'File the cards', 3000, 0, 'workiom5-assistance', FILE),
    agent('cleanup', 'Clean up', 3300, 0, 'code-specialist', CLEANUP, 'sonnet'),
    { ...base('done', 'Audit ended', 3600, 0), kind: 'notify', title: 'W5 design audit ended', body: '{{input}}' }
  ],
  edges: [
    edge('start', 'prepare'),
    edge('prepare', 'prepare-ok'),
    edge('prepare-ok', 'resolve', 'yes'),
    edge('prepare-ok', 'cleanup', 'no'),
    edge('resolve', 'resolve-ok'),
    edge('resolve-ok', 'scan', 'yes'),
    edge('resolve-ok', 'cleanup', 'no'),
    edge('scan', 'consolidate'),
    edge('consolidate', 'structure'),
    edge('structure', 'review'),
    edge('review', 'build', 'approved'),
    edge('review', 'cleanup', 'rejected'),
    edge('build', 'file'),
    edge('file', 'cleanup'),
    edge('cleanup', 'done')
  ]
}

/** The saved form: a new id, stamps, and the zone; the trigger and steps as written above. */
export function asWorkflow(zone, now = Date.now(), id = randomUUID()) {
  return { id, ...definition, timeZone: zone, nextRunAt: null, createdAt: now, updatedAt: now }
}

/**
 * The saved workflow with this definition's trigger, steps and edges: its id, switch, zone, creation time and run history
 * (runs hang on the id) stay as they were, so a user's own on/off choice and past runs survive an update.
 */
export function updateWorkflow(existing, now = Date.now()) {
  return {
    ...existing,
    name: definition.name,
    trigger: definition.trigger,
    steps: definition.steps,
    edges: definition.edges,
    updatedAt: now
  }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const zone = opt('--time-zone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (args.includes('--print')) {
    console.log(JSON.stringify(asWorkflow(zone), null, 2))
    return
  }
  const dir = opt('--data-dir') ?? process.env.ZUMIBOT_DATA_DIR ?? join(os.homedir(), '.local', 'share', 'zumibot')
  const file = join(dir, 'workflows.json')
  let list = []
  try {
    list = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(list)) throw new Error('workflows.json is not a list')
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(`Cannot read ${file}: ${err.message}`)
      process.exit(1)
    }
  }
  const at = list.findIndex((w) => w?.name === NAME)
  const update = args.includes('--update')
  if (at >= 0 && !update) {
    console.error(`A workflow named "${NAME}" already exists in ${file}; nothing changed (use --update to replace its steps).`)
    process.exit(1)
  }
  if (at < 0 && update) {
    console.error(`No workflow named "${NAME}" in ${file}; nothing changed (run without --update to add it).`)
    process.exit(1)
  }
  const w = update ? updateWorkflow(list[at]) : asWorkflow(zone)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(update ? list.map((x, i) => (i === at ? w : x)) : [...list, w]), { mode: 0o600 })
  await fs.rename(tmp, file)
  console.log(
    `${update ? 'Updated' : 'Added'} "${NAME}" (${w.id}) in ${file}. Open Workflows in ZumiBot, then check its problems before the first Run.`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
