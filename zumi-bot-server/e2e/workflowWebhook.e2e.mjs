// npm run build:server && node zumi-bot-server/e2e/workflowWebhook.e2e.mjs
// Uses the harness's temporary HOME and fake CLI; no real account or agent calls.
import assert from 'node:assert/strict'
import { start, unexpectedErrors, pickOption } from './harness.mjs'

const h = await start({ fake: true })
const page = h.page
page.setDefaultTimeout(15_000)
const field = (id) => page.getByTestId(id)
let rpcPage
const rpc = (method, ...args) =>
  rpcPage.evaluate(
    async ({ method, args }) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = reject
      })
      try {
        return await new Promise((resolve, reject) => {
          ws.onmessage = (event) => {
            const m = JSON.parse(event.data)
            if (m.id === 1) m.ok ? resolve(m.value) : reject(new Error(m.error))
          }
          ws.send(JSON.stringify({ id: 1, method, args }))
        })
      } finally {
        ws.close()
      }
    },
    { method, args }
  )

try {
  await field('mode-tab-workflows').waitFor()
  rpcPage = await h.newPage()
  await rpcPage.goto(`${h.origin}/favicon.png`)
  await page.bringToFront()
  await field('mode-tab-workflows').click()
  await field('new-workflow').click()
  await field('wf-node').click()
  await pickOption(field('wf-trigger-kind'), 'webhook')
  await field('webhook-url').waitFor()
  const url = await field('webhook-url').textContent()
  const id = new URL(url).pathname.split('/').pop()
  assert.equal((await rpc('workflows:list')).workflows.length, 0)
  await field('wf-more').click()
  assert.equal(await field('wf-delete').isDisabled(), true)
  await field('wf-more').click()
  await field('webhook-secret-show').click()
  const oldSecret = await field('webhook-secret').textContent()
  assert.ok(oldSecret.length >= 32)
  await field('webhook-new-secret').click()
  await page.getByRole('dialog').getByRole('button', { name: 'New secret', exact: true }).click()
  await field('webhook-secret-show').click()
  await page.waitForFunction((old) => document.querySelector('[data-testid="webhook-secret"]').textContent !== old, oldSecret)
  const secret = await field('webhook-secret').textContent()
  const send = (key) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ZumiBot-Secret': key },
      body: JSON.stringify({ action: 'opened' })
    })
  assert.equal((await send(oldSecret)).status, 401)
  const captured = await send(secret)
  assert.equal(captured.status, 202)
  assert.deepEqual(await captured.json(), { status: 'test call captured' })
  await field('webhook-check').click()
  await field('webhook-latest').waitFor()
  await page.locator('[data-testid="webhook-field"][data-path="body.action"]').getByRole('button', { name: 'Filter', exact: true }).click()
  assert.equal(await page.getByLabel('Field', { exact: true }).inputValue(), 'body.action')
  await pickOption(field('wf-trigger-kind'), 'manual')
  await pickOption(field('wf-trigger-kind'), 'webhook')
  assert.equal(await field('webhook-url').textContent(), url)
  await field('wf-save').click()
  await page.waitForURL(`${h.origin}/workflows/${id}`)
  const saved = (await rpc('workflows:list')).workflows.find((w) => w.id === id)
  assert.deepEqual(saved.trigger.sample.body, { action: 'opened' })
  assert.deepEqual(saved.trigger.filters, [{ field: 'body.action', equals: 'opened' }])
  assert.equal((await rpc('workflows:webhook', id)).secret, secret)
  console.log('PASS: webhook controls and test calls before save; rotation, filters, and URL preserved on save')

  await field('new-workflow').click()
  await field('wf-node').click()
  await pickOption(field('wf-trigger-kind'), 'webhook')
  await field('webhook-url').waitFor()
  const abandoned = await field('webhook-url').textContent()
  assert.notEqual(abandoned, url)
  await field('mode-tab-agents').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Discard/ })
    .click()
  // A request through the same server follows the editor's asynchronous cleanup.
  await page.waitForFunction(
    async (hookUrl) => (await fetch(hookUrl, { headers: { 'X-ZumiBot-Secret': 'test-secret' } })).status === 404,
    abandoned
  )
  assert.equal((await rpc('workflows:webhook', id)).secret, secret)
  console.log('PASS: leaving an unsaved workflow removes its draft hook and leaves saved hooks intact')

  let heldSave, heldDraft, heldHook, hookToHold
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer()
    const methods = new Map()
    ws.onMessage((message) => {
      const m = JSON.parse(String(message))
      methods.set(m.id, m)
      server.send(message)
    })
    server.onMessage((message) => {
      const m = JSON.parse(String(message))
      const request = methods.get(m.id)
      const method = request?.method
      if (method === 'workflows:save') heldSave = { value: m.value, release: () => ws.send(message) }
      else if (method === 'workflows:draftWebhook') heldDraft = { value: m.value, release: () => ws.send(message) }
      else if (method === 'workflows:webhook' && request.args[0] === hookToHold) heldHook = { release: () => ws.send(message) }
      else ws.send(message)
    })
  })
  const until = async (predicate) => {
    const deadline = Date.now() + 15_000
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the held RPC response')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  await page.reload()
  await field('mode-tab-workflows').click()
  await field('new-workflow').click()
  await field('wf-node').click()
  await field('wf-save').click()
  await until(() => heldSave)
  await pickOption(field('wf-trigger-kind'), 'webhook')
  await until(() => heldDraft)
  heldSave.release()
  // The trigger edit arrived after Save started; keep that unsaved edit in the current editor.
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  heldDraft.release()
  await field('webhook-url').waitFor()
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="webhook-url"]')?.textContent === expected,
    `${h.origin}/hooks/${heldSave.value.id}`
  )
  await page.waitForFunction(
    async (url) => (await fetch(url, { headers: { 'X-ZumiBot-Secret': 'test-secret' } })).status === 404,
    heldDraft.value.url
  )
  console.log('PASS: switching to webhook during the first save uses the saved workflow URL and removes the unused reservation')

  heldSave = heldDraft = undefined
  await field('new-workflow').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Discard/ })
    .click()
  await field('wf-node').click()
  await field('wf-save').click()
  await until(() => heldSave)
  await pickOption(field('wf-trigger-kind'), 'webhook')
  await until(() => heldDraft)
  heldDraft.release()
  await field('webhook-url').waitFor()
  hookToHold = heldDraft.value.id
  await pickOption(field('wf-trigger-kind'), 'manual')
  await pickOption(field('wf-trigger-kind'), 'webhook')
  await until(() => heldHook)
  heldSave.release()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  heldHook.release()
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="webhook-url"]')?.textContent === expected,
    `${h.origin}/hooks/${heldSave.value.id}`
  )
  console.log('PASS: a delayed read of the draft hook also follows the saved workflow identity')
  assert.deepEqual(unexpectedErrors(h.errors, [/Failed to load resource.*(?:401|404)/]), [])
} finally {
  await h.stop()
}
