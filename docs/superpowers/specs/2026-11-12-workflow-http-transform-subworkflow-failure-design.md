# Workflow steps: HTTP request, Transform, Sub-workflow, and the On failure path

Date: 2026-11-12. Status: the user asked for these four and skipped the design questions, so every choice below is the
builder's call, made to fit what workflows already do.

## Why

Workflows had only model-backed ways to reach the outside world (an Agent step, which pays for a whole turn), no way to
reshape a step's output short of an LLM call, no way to reuse one workflow inside another, and a failed step always
halted the run until the user pressed Retry.

## Goals

- **HTTP request** step: one plain request, no model, no cost. Its output is the response body.
- **Transform** step: pick fields out of JSON input by path, into a smaller JSON object or one value per line (the shape
  a For each step reads).
- **Sub-workflow** step: runs another workflow as a child run, waits for it (approvals in it included) and hands on its
  result.
- **On failure** path: a step can say "on failure, go here" instead of halting the run.

## Non-goals

- No expression language (JSONata, jq, JavaScript). Paths only.
- No `{{steps.x.output.<path>}}` in templates: Transform is the one place that reads into JSON.
- No OAuth, cookies, multipart uploads, binary bodies or response headers in the output.
- No secret typed into a header in plain text as a feature: secrets come from the Vault (below).
- No retries with backoff inside a step; the failure path or Retry covers that.

## Anti-goals

- A webhook caller must never be able to steer an HTTP step at another host (SSRF, or a vault key sent elsewhere).
- An API key must never land in `workflows.json`, a run, a log, a notification, Zumi Bot's tools or a model prompt.
- The failure path must not turn a Stop, a restart or the user's own action into a silent "handled" run.

## HTTP request (`kind: 'http'`)

Fields: `method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), `url` (template), `headers` (`{name, value}[]`, values
templates, at most 20), `body` (template, optional), `bodyType` (`json` default, or `text`), `key` (optional vault item
id). Every template is filled **raw** (no `<input>` blocks: no model reads it).

- **URL.** The scheme and host are literal: a `{{` may only come after the first `/`, `?` or `#` past the host
  (`problemsOf`: "Start the address with http:// or https:// and a host, with no {{…}} before the path"). Each value
  filled into the URL is percent-encoded (`encodeURIComponent`), so it can't add a path, query or host. At run time the
  filled URL's origin must equal the literal prefix's origin, as a belt.
- **Headers.** Names are HTTP tokens; `Host`, `Content-Length`, `Connection`, `Transfer-Encoding` and `Cookie` are
  refused as problems. A filled value with a line break fails the visit.
- **Body.** Refused on `GET` (a problem). `json`: a placeholder inside a JSON string literal is filled JSON-escaped, one
  outside a string is filled as is (so `"items": {{steps.list.output}}` can hand on JSON); the filled body must parse,
  else the visit fails "The body is not valid JSON". `Content-Type` defaults to `application/json` (`json`) or
  `text/plain; charset=utf-8` (`text`) unless a header sets it. At most 1 MiB once filled.
- **Vault key.** `key` names a vault **API key** whose new **Workflow HTTP steps can use this** switch is on
  (`ApiKeyBody.workflows: true`; Settings › Vault). The step writes `{{key}}` where the value goes (a header such as
  `Authorization: Bearer {{key}}`, the URL's query, or the body). `{{key}}` without a key, or a key never used, is a
  problem. The server checks at Run and at turning on that the item exists, is an API key and allows workflows ("API key
  not found or not allowed for workflows"). The value is read from the vault per request, never stored, and replaced
  by `[vault: <name>]` (raw and percent-encoded forms) in the output, the error and the stored URL. Zumi Bot's tools
  never show or set `key` (an edit keeps the stored one), and the editor shows the item's name only.
- **Request.** `fetch` with `redirect: 'manual'`: up to 5 same-origin redirects are followed; a cross-origin one ends
  the request as its 3xx answer, so a header (a key) never goes to another host. Timeout 60 s (`HTTP_TIMEOUT_MS`).
  Stop aborts it.
- **Response.** 2xx and 3xx are done; anything else fails with `HTTP <status>`. The body (at most 1 MiB read, decoded as
  UTF-8) is the output; a JSON body (by content type) is pretty-printed with two spaces, as the trigger's body is. A
  body over `OUTPUT_MAX` (50 000) fails "The response is over 50 000 characters" and one holding a NUL fails "The
  response is not text". A failed visit keeps the body as its `output`, so the run view, the Audit log and the failure
  path can show it. The visit stores `http: {method, url, status?}` (URL scrubbed).
- **Restart.** A running HTTP visit fails "Interrupted by a restart" (the request may or may not have landed), halting
  the run with Retry, as an Agent step's interrupted turn does.
- **Run step** tests it for real against the unsaved draft, as Agent steps do.

## Transform (`kind: 'transform'`)

Fields: `fields` (`{name, path}[]`, 1 to 20, name 1 to 64 characters, unique) and `format` (`json` default, or `lines`).

- The step's input (one delivery, as is) must parse as JSON, else it fails "The input is not JSON".
- A path is dot segments (`pull_request.head.ref`); a number indexes an array; `*` maps over every element of an array
  (or value of an object); `a[0]` and `a[]`/`a[*]` are read as `a.0` and `a.*`; an empty path is the whole input.
- `json`: an object of each field's value (a missing one is `null`), pretty-printed.
- `lines`: every field's value in field order, an array giving one line per element; a string as is, a number or boolean
  as text, an object or array as compact JSON, `null` and missing values left out, line breaks inside a value turned
  into spaces. One field pointing at a value gives that value alone, so `{{steps.<handle>.output}}` reads it.
- Missing paths are listed on the visit (`missing`, the Audit log's "Missing fields") and never fail it.
- An output over `OUTPUT_MAX` fails "The output is over 50 000 characters". Pure and instant: recover() runs it again.
  Run step tests it.

## Sub-workflow (`kind: 'workflow'`)

Fields: `workflow` (the child workflow's id) and `input` (template, default `{{input}}`, filled raw).

- The child is a normal run of the child workflow (`via: 'workflow'`) with the filled text as its trigger input and
  `parent: {workflowId, runId, visitId, name, depth}`. Its id is made when the parent's visit opens and stored on the
  visit (`childRunId`) in that same write, so a restart either finds the child or starts it with that id, never twice.
- The child runs whether or not it is switched on, follows its own caps (5 unfinished runs, problems) and shows in its
  own workflow's run list with "Started by <parent> › <step>" linking to the parent run; the parent's visit links to
  the child run (**Open run →**).
- A child's `{{trigger.text}}` is material, not the user's typing: in a model prompt it is wrapped as
  `<input from="trigger">`.
- While the child waits (an Approval, a card in one of its Agent steps' chats) the parent's visit waits too, so the
  parent run reads `waiting`. The approval itself is answered in the child run or the Inbox.
- **Result.** The output of the child's end visits: done visits whose port has no edge leaving it, the latest per
  step, by end time; one is its output as is, several are joined like a multi-input step (`From <name>:`). Cut to
  `OUTPUT_MAX`. The parent's visit cost is the child run's cost.
- **Ending.** Child done: the parent visit is done on `out`. Child failed: the parent visit fails "Sub-workflow failed:
  <child error>". Child stopped (by the user, or because the child workflow was deleted): the parent visit fails
  "Sub-workflow was stopped", as the user's own doing (no failure path, no notification). A child that could not start
  (problems, too many runs, missing workflow) fails the parent visit with that reason.
- Stop on the parent stops every open child. Retry on the parent's failed visit starts a new child run.
- A child's own failure sends no "Workflow failed" push; the parent's does.
- **Depth.** A run started by a sub-workflow step is one deeper than its parent; past 3 (`SUBWORKFLOW_DEPTH_MAX`) the
  visit fails "Sub-workflows nest more than 3 deep", which also ends a workflow that calls itself. A step naming its own
  workflow is a problem ("A workflow can't run itself"); a missing workflow is the server's problem ("Workflow not
  found").

## The On failure path

- A step that can fail on its own (Agent, For each, LLM, Condition, HTTP request, Transform, Sub-workflow) has an
  **On failure** setting: **Stop the run** (absent, as today) or **Go on along the failure path** (`onFailure: 'branch'`).
  The second adds an `error` port, drawn as "Failed" in red. Turning it off removes that port's connections.
- `portsOf(kind)` stays the kind's normal ports; `stepPorts(step)` adds `error` for such a step, and edges are checked
  against `stepPorts`.
- When such a step's visit fails **by itself** and an edge leaves its `error` port, the visit ends `failed` with
  `port: 'error'` (handled): its failure text goes along those edges, the run is not halted, it does not count as a
  failed step for the run's end status, the failed list or the "Workflow failed" push, and it can't be Retried (the run
  already went on).
- The failure text is the error, then a blank line and the visit's output when it has one (an HTTP error's body).
- **Not caught:** a Stop, a restart, the user's own action ("Continued by hand", "Replaced by an edit or resend",
  "Sub-workflow was stopped"), "Ran too many times" and a missing step. Those halt the run as today, with Retry.
- With the setting on and no connection the step has a problem ("Connect the failure path, or set On failure to Stop
  the run").
- The run view and Audit log mark a handled failure ("Failed · went on along the failure path"); the canvas edge out of
  `error` turns green as it carries output, like any other.

## Zumi Bot

The authoring format gains the three kinds with the same fields (`workflow` by id; `key` never), and `error` as a port
of the steps above. `onFailure` is not in the format: a save sets it on every step with an `error` edge and clears it on
the others, and `workflow_get` leaves it out. Its prompt section describes the steps and the failure path.

## Left to the builder

Icons, exact copy of hints, the inspector's layout, the Audit log's boxes for the new kinds, and test placement.
