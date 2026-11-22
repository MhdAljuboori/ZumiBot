const bridge = window.zumibotPages
const retry = document.getElementById('retry')
const switchServer = document.getElementById('switch')
bridge.getError().then((m) => {
  document.getElementById('message').textContent = m
})
// The page is replaced when the attempt ends, so the buttons stay off until then.
retry.addEventListener('click', () => {
  retry.disabled = true
  retry.textContent = 'Retrying…'
  bridge.retry()
})
switchServer.addEventListener('click', () => bridge.switchServer())

// The switch shortcut is Cmd+Shift+S on a Mac (switchTrigger.ts).
if (/Mac/.test(navigator.platform)) for (const k of document.querySelectorAll('.switch-key')) k.textContent = 'Cmd+Shift+S'
