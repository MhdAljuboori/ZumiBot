# Workflow: W5 design audit

The 5-6 Nov 2026 W5 design audit (one ui-ux-specialist chat that scanned the 36 parents of the Workiom W5 Backlog against
https://workiom.github.io/v5/ and filed 170 cards) as a ZumiBot workflow. It runs on the **For each** step
(`2026-11-08-workflow-for-each-design.md`), so it needs a build that has it.

## Run input

One text box (the manual trigger's text): an area name ("Gallery View"), a parent key ("Parent-226" or "226"), several of
them separated by commas or new lines, or nothing / "All" for all 36 parents.

## Steps

| # | Step | Kind and agent | Does |
|---|---|---|---|
| 1 | Prepare | Agent, code-specialist (sonnet) | A dated audit folder `~/w5audit-<date>`, a detached worktree of the latest `origin/workiom-v5`, the dev server on :4200 (fails if the port is busy; never kills, never starts a second), a copy of the design page, and a README of rules for the reviewers (no browser and no sign-in here). Reply lines: AUDIT, WORKTREE, BASE, PORT, PID, LOG; last line `RESULT: OK` or `RESULT: FAIL <why>`. |
| 2 | Prepared? | Condition (haiku) | Last line is `RESULT: OK`. No goes to Clean up. |
| 3 | Resolve areas | Agent, work-assistant (sonnet) | Reads the W5 Backlog parents with the Workiom CLI and turns the run input into one line per parent, `Parent-226 Gallery View`. Empty or All gives all; names match without case, exact first, else one unambiguous partial match; ambiguity or no match gives a single `ERROR: ...` line, never a partial list. |
| 4 | Areas found? | Condition (haiku) | First line starts with `Parent-`. No goes to Clean up. The list passes on unchanged. |
| 5 | Scan each area | **For each**, ui-ux-specialist | One fresh reviewer per parent. It pulls the parent's cards, writes `findings.md` first and appends as it goes, signs in to the product with the Vault login "E2e Workspace" through the agent browser, shoots and measures design vs product with `browser_save_screenshot`, `browser_computed_style`, `browser_hover` and `browser_set_viewport` (1440x900), copies each saved file into the audit folder, judges every Merged card (still valid, superseded, regressed, incomplete). The rules are the audit's own BRIEF (what counts, standing rulings, skipped features, output format). A failed parent does not stop the others; Retry reruns only the failed ones. |
| 6 | Consolidate | Agent, ui-ux-specialist | One card per cause, gaps in open or merged cards, old-card verdicts, one deduped question list. Files only, no new shots. |
| 7 | Structure part | Agent, structure-reviewer | Batches of about 40 cards, one subagent each: re-check against the code, files, kit verdict, order and collisions. Then it merges the UI and structure questions. Its reply (counts and every question with its Recommended option) is what step 8 shows. |
| 8 | Review the cards | **Approval**, editable | The only point where the user is needed. Approve takes the Recommended option on every question; editing the text or adding a note overrides named ones. Reject stops and files nothing. |
| 9 | Build the card set | Agent, ui-ux-specialist | Applies the answers, drops cards the structure part found fixed, writes `cards-batch-N.md` (at most 40 cards each) and `notes.md` (comments for open cards). |
| 10 | File the cards | Agent, workiom5-assistance | Creates the cards batch by batch with images attached, duplicate check against open cards (comment instead of creating), `created.json` mapping written after every card so a cut-off loses nothing, then the notes. |
| 11 | Clean up | Agent, code-specialist (sonnet) | Removes logged test data (with the agent browser, only if some is left), stops the server by PID, removes the worktree, checks no browser is left. Reached on every way out: failed setup, unresolved areas, rejection, and the finished path. |
| 12 | Audit ended | Notify | A push and an Inbox message with the outcome line. |

## Decisions (mine, to check)

- The QA password is never in the workflow text, and no agent ever sees it: the reviewers sign in through the agent browser,
  where ZumiBot types the Vault login "E2e Workspace" itself (`browser_fill_from_vault`). The user grants that login to
  ui-ux-specialist and code-specialist (**Settings > Vault**) and its sites must include `localhost`. The tenant `e2e` is typed
  by the reviewer. The agent browser keeps the session between areas.
- This replaced the first design, which used Playwright scripts and a Vault API key: Bash cannot read a Vault login, and the
  agent browser could not save images or measure styles until the browser audit tools
  (`2026-11-08-browser-audit-tools-design.md`) were added.
- Nothing from the old audit folder is reused (it lived on the other machine). Evidence is a design and a product PNG per
  state, not one side-by-side image.
- Setup comes before area resolution so the area list can reach For each as its only input (a step with two inputs would
  join them and break the one-item-per-line list). The cost: a bad area name fails after setup, and Clean up undoes it.
- The reviewers' final replies are short (at most 150 words); the evidence lives in files under the audit folder, because
  For each keeps up to 20 000 characters per item and 100 000 in all.
- The structure step lets the agent split into batches itself instead of the workflow looping over card batches: the
  number of cards is unknown until the consolidate step ends.
- No model is set on the reviewers, the consolidator, the structure reviewer or the card builder: they use their agent's
  own (opus). Prepare, Resolve, Clean up and the card filer use sonnet.

## Not done / unverified

- The workflow has never run. Its structure is checked (no editor problems, saved form survives the save parser, every
  way out reaches Clean up, the area list is the For each step's only input), its prompts are not.
- Prompts say what the original chat did, from its transcript; the original BRIEF.md and tools were not available here.

## Where it lives

`zumi-bot-server/deploy/workflows/w5-design-audit.mjs` holds the definition and an importer:
`node zumi-bot-server/deploy/workflows/w5-design-audit.mjs` adds it to the data dir's `workflows.json` (refuses a second
copy; `--update` replaces the steps of the one already there and keeps its id, switch and runs; `--print` shows it; `--data-dir` and `--time-zone` override). Test: `zumi-bot-server/backend/tests/core/w5AuditWorkflow.test.ts`.
