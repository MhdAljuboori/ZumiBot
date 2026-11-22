// No inline script is allowed by the CSP, so the wizard's logic lives here.
// The one-time code stays in this variable: it is never stored, so a reload asks for it again.
let code = ''

const el = (id) => document.getElementById(id)
const PANELS = ['code', 'password', 'totp', 'recovery', 'check', 'done']
const STEP_OF = { code: 1, password: 2, totp: 3, recovery: 4, check: 5, done: 5 }
const errorBox = el('error')

function showError(message) {
  errorBox.textContent = message || ''
  errorBox.hidden = !message
}

let current = 'code'

function show(name) {
  current = name
  for (const p of PANELS) el(`panel-${p}`).hidden = p !== name
  el('progress').textContent = name === 'done' ? 'Done' : `Step ${STEP_OF[name]} of 5`
  showError('')
  const focus = { code: 'code', password: 'password', totp: 'totp' }[name]
  if (focus) el(focus).focus()
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, ...body })
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // 204 and anything unparseable: the status is what matters
  }
  return { status: res.status, data }
}

/** Shared failure handling: a refused code means the server restarted and printed a new one. */
function handleFailure(out) {
  if (out.status === 401) {
    code = ''
    el('code').value = ''
    show('code')
    showError('That setup code is not right. If the server restarted, it printed a new one.')
    return
  }
  showError((out.data && out.data.error) || 'Something went wrong. Try again.')
}

async function state() {
  const res = await fetch('/api/setup/state', { credentials: 'same-origin' })
  const data = await res.json()
  return data.step
}

function renderClaude(status) {
  const message = el('claude-message')
  message.textContent = status.message
  message.className = `status ${status.ready ? 'ok' : 'bad'}`
  const hasFix = status.fix.length > 0
  el('claude-fix').hidden = !hasFix
  el('claude-user').textContent = status.user
  el('claude-commands').textContent = status.fix.join('\n')
}

/** Where to go once the code is accepted: the first step this server has not finished. */
async function routeTo(step) {
  if (step === 'password') return show('password')
  if (step === 'totp') {
    show('totp')
    return startTotp()
  }
  // Both are already set: only the check and the handover are left. Recovery codes are gone for good.
  el('codes-note').hidden = false
  show('check')
}

async function startTotp() {
  const out = await post('/api/setup/totp/start', {})
  if (out.status !== 200) return handleFailure(out)
  el('qr').src = out.data.qr
  el('secret').textContent = out.data.secret
}

function submitting(button, on) {
  button.disabled = on
}

el('panel-code').addEventListener('submit', async (event) => {
  event.preventDefault()
  submitting(el('submit-code'), true)
  try {
    code = el('code').value.trim()
    // `check` is read-only and allowed at every step, so it doubles as "is this code right?".
    const out = await post('/api/setup/check', {})
    if (out.status !== 200) return handleFailure(out)
    renderClaude(out.data.claude)
    await routeTo(await state())
  } catch {
    showError('Could not reach the server. Try again.')
  } finally {
    submitting(el('submit-code'), false)
  }
})

el('panel-password').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (el('password').value !== el('password2').value) return showError('The two passwords do not match.')
  submitting(el('submit-password'), true)
  try {
    const out = await post('/api/setup/password', { password: el('password').value })
    if (out.status !== 200) return handleFailure(out)
    el('password').value = ''
    el('password2').value = ''
    show('totp')
    await startTotp()
  } catch {
    showError('Could not reach the server. Try again.')
  } finally {
    submitting(el('submit-password'), false)
  }
})

el('panel-totp').addEventListener('submit', async (event) => {
  event.preventDefault()
  submitting(el('submit-totp'), true)
  try {
    const out = await post('/api/setup/totp/confirm', { totp: el('totp').value })
    if (out.status !== 200) {
      el('totp').value = ''
      return handleFailure(out)
    }
    const list = el('recovery-codes')
    list.textContent = ''
    for (const c of out.data.recoveryCodes) {
      const li = document.createElement('li')
      li.textContent = c
      list.appendChild(li)
    }
    show('recovery')
  } catch {
    showError('Could not reach the server. Try again.')
  } finally {
    submitting(el('submit-totp'), false)
  }
})

el('copy-codes').addEventListener('click', async () => {
  const text = [...el('recovery-codes').children].map((li) => li.textContent).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    el('copy-codes').textContent = 'Copied'
  } catch {
    // No clipboard permission: select them so the user can copy by hand.
    const range = document.createRange()
    range.selectNodeContents(el('recovery-codes'))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    el('copy-codes').textContent = 'Copy them by hand'
  }
})

el('saved-codes').addEventListener('change', () => {
  el('submit-recovery').disabled = !el('saved-codes').checked
})

el('submit-recovery').addEventListener('click', async () => {
  show('check')
  await recheck()
})

async function recheck() {
  el('recheck').textContent = 'Checking…'
  try {
    const out = await post('/api/setup/check', {})
    if (out.status !== 200) return handleFailure(out)
    renderClaude(out.data.claude)
  } catch {
    showError('Could not reach the server. Try again.')
  } finally {
    el('recheck').textContent = 'Check again'
  }
}

el('recheck').addEventListener('click', recheck)

/** The app takes the same port a moment later, so wait for the real sign-in page before going there. */
async function waitForApp(deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs
  for (;;) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const res = await fetch('/login', { method: 'HEAD', cache: 'no-store' })
      if (res.ok) return true
    } catch {
      // The setup server is closing and the app has not bound the port yet.
    }
    if (Date.now() > until) return false
  }
}

el('submit-finish').addEventListener('click', async () => {
  submitting(el('submit-finish'), true)
  try {
    const out = await post('/api/setup/finish', {})
    if (out.status !== 204) return handleFailure(out)
    show('done')
    if (await waitForApp()) window.location.replace('/login')
    else {
      el('done-message').textContent = 'Setup is done, but ZumiBot has not come back up. Check the server log.'
      el('sign-in').hidden = false
    }
  } catch {
    showError('Could not reach the server. Try again.')
  } finally {
    submitting(el('submit-finish'), false)
  }
})

show('code')
