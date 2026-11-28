const api = window.zumibotSync
const start = document.getElementById('start')
const configure = document.getElementById('configure')
const close = document.getElementById('close')
// Unticked on every open: the page loads fresh each time and nothing remembers it.
const chats = document.getElementById('chats')
const status = document.getElementById('status')
const target = document.getElementById('target')
const log = document.getElementById('log')
let pending = false
let lastText = ''
let startedAt = 0

// The status is a live region: rewriting the same text would make screen readers repeat it on every poll.
const show = (el, text) => {
  if (el.textContent !== text) el.textContent = text
}
// Long rsync steps log nothing for minutes, so the button shows that time is still passing.
function elapsed() {
  const s = Math.floor((Date.now() - startedAt) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function refresh() {
  const state = await api.status()
  if (!state) return
  const busy = state.active || pending
  if (!state.active) startedAt = 0
  else if (!startedAt) startedAt = Date.now()
  start.disabled = configure.disabled = close.disabled = chats.disabled = busy
  show(start, state.active ? `Syncing… ${elapsed()}` : busy ? 'Syncing…' : 'Sync now')
  show(target, state.target)
  show(status, busy ? 'Keep ZumiBot open until sync finishes.' : state.lines.at(-1) || 'Ready to sync.')
  const text = state.lines.join('\n')
  if (text !== lastText) {
    lastText = log.textContent = text
    log.scrollTop = log.scrollHeight
  }
}
async function act(fn) {
  if (pending) return
  pending = true
  try {
    await refresh()
    await fn()
  } catch {
    status.textContent = 'Could not contact the desktop app. Close this window and try again.'
  } finally {
    pending = false
    await refresh()
  }
}
start.addEventListener('click', () => void act(() => api.start({ chats: chats.checked })))
configure.addEventListener('click', () => void act(() => api.configure()))
close.addEventListener('click', () => window.close())
void refresh()
setInterval(() => void refresh().catch(() => {}), 300)
