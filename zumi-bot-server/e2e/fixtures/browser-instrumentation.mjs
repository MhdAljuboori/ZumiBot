// Loaded only by the acceptance harness via NODE_OPTIONS. No product endpoints/hooks.
import { appendFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { Server } from 'node:net'

if (process.env.BROWSER_E2E_METRICS) {
  const emit = Server.prototype.emit
  Server.prototype.emit = function (event, ...args) {
    const result = emit.call(this, event, ...args)
    // Observe only the private browser IPC server, after its production connection
    // listener installed the data handler. The receipt listener runs after that
    // handler, so the test cannot confuse a CLI launch/write with service receipt.
    if (event !== 'connection' || !/^\/tmp\/cb-b-[^/]+\/s$/.test(String(this.address()))) return result
    const socket = args[0]
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 65536) {
        buffer = Buffer.alloc(0)
        return
      }
      for (let end; (end = buffer.indexOf(10)) >= 0;) {
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        try {
          const message = JSON.parse(line.toString('utf8'))
          if (message.type === 'run' && ['observe', 'click'].includes(message.command?.op)) {
            // Never log auth, request arguments, capabilities, input or page data.
            appendFileSync(
              process.env.BROWSER_E2E_METRICS,
              JSON.stringify({ pid: process.pid, time: Date.now(), type: 'ipcRequestReceived', command: message.command.op }) + '\n'
            )
          }
        } catch {
          /* Production framing owns rejection; instrumentation records nothing. */
        }
      }
    })
    socket.once('close', () => {
      buffer = Buffer.alloc(0)
    })
    return result
  }
}

if (process.argv[1]?.endsWith('/browserWorker.mjs') && process.env.BROWSER_E2E_METRICS) {
  const log = (event) =>
    appendFileSync(process.env.BROWSER_E2E_METRICS, JSON.stringify({ pid: process.pid, time: Date.now(), ...event }) + '\n')
  process.on('message', (message) => log({ type: 'workerRequest', op: message.op, command: message.command?.op }))
  const { chromium } = await import(pathToFileURL(join(dirname(process.argv[1]), 'node_modules/playwright-core/index.mjs')))
  const launch = chromium.launchPersistentContext.bind(chromium),
    inspected = new Set()
  chromium.launchPersistentContext = async (...args) => {
    if (args[1]?.chromiumSandbox !== true) throw Error('Acceptance requires Chromium sandbox')
    const context = await launch(...args)
    log({ type: 'launch', sandbox: true })
    const session = context.newCDPSession.bind(context)
    context.newCDPSession = async (...input) => {
      const cdp = await session(...input),
        send = cdp.send.bind(cdp)
      cdp.send = async (method, params) => {
        const result = await send(method, params)
        if (method === 'Page.startScreencast' || method === 'Page.stopScreencast') log({ type: method })
        return result
      }
      return cdp
    }
    context.once('close', () => log({ type: 'close' }))
    if (process.env.BROWSER_E2E_INSPECT) inspected.add(context)
    return context
  }
  // The suite's own look into the agent browser (vault fills): on SIGUSR2, every form field of every frame, written
  // as a hash and length of its value plus its computed mask, so no field value reaches the file. Each worker counts from
  // 1, so its pid goes along: a worker that replaced another is told apart by it.
  let seq = 0
  if (process.env.BROWSER_E2E_INSPECT)
    process.on(
      'SIGUSR2',
      () =>
        void (async () => {
          const n = ++seq,
            pages = []
          for (const context of inspected)
            for (const page of context.pages()) {
              const frames = []
              for (const frame of page.frames()) {
                const fields = await frame
                  .evaluate(() =>
                    [...document.querySelectorAll('input,select,textarea')].map((el) => ({
                      label: el.getAttribute('aria-label') ?? '',
                      type: el.type,
                      value: el.value ?? '',
                      mask: getComputedStyle(el).getPropertyValue('-webkit-text-security')
                    }))
                  )
                  .catch(() => null)
                frames.push({
                  url: frame.url(),
                  fields:
                    fields?.map(({ value, ...f }) => ({
                      ...f,
                      length: value.length,
                      sha256: createHash('sha256').update(value).digest('hex')
                    })) ?? null
                })
              }
              pages.push({ url: page.url(), frames })
            }
          writeFileSync(process.env.BROWSER_E2E_INSPECT + '.tmp', JSON.stringify({ pid: process.pid, seq: n, pages }))
          renameSync(process.env.BROWSER_E2E_INSPECT + '.tmp', process.env.BROWSER_E2E_INSPECT)
        })().catch(() => {})
    ) // the worker shuts down on an unhandled rejection
}
