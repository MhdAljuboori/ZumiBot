const form = document.getElementById('form')
const url = document.getElementById('url')
const port = document.getElementById('port')
const portRow = document.getElementById('port-row')
const error = document.getElementById('error')
const go = document.getElementById('go')
const kind = () => form.elements.kind.value

const sync = () => {
  url.hidden = kind() !== 'vps'
  portRow.hidden = kind() !== 'local'
  error.textContent = ''
}
form.addEventListener('change', sync)

// On Windows the local server runs inside WSL2, which the user sets up first.
window.zumibotPages.localKind().then((k) => {
  if (k !== 'wsl') return
  document.getElementById('local-note').textContent =
    'Run the server in WSL2 on this computer. Needs WSL2 with Node.js 22 and Claude Code installed inside it.'
})

// Start on what the user chose last time.
window.zumibotPages.currentChoice().then((c) => {
  if (!c) return
  form.elements.kind.value = c.kind
  if (c.kind === 'vps') url.value = c.url
  else port.value = String(c.port)
  sync()
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  go.disabled = true
  const res = await window.zumibotPages.pickServer(
    kind() === 'vps' ? { kind: 'vps', url: url.value } : { kind: 'local', port: Number(port.value) }
  )
  if (!res.ok) {
    error.textContent = res.error ?? 'Could not use that server.'
    go.disabled = false
  } else {
    go.textContent = 'Connecting…'
  }
})

// The switch shortcut is Cmd+Shift+S on a Mac (switchTrigger.ts).
if (/Mac/.test(navigator.platform)) for (const k of document.querySelectorAll('.switch-key')) k.textContent = 'Cmd+Shift+S'
