// No inline script is allowed by the CSP, so the page logic lives here.
const form = document.getElementById('form')
const password = document.getElementById('password')
const code = document.getElementById('code')
const recovery = document.getElementById('recovery')
const totpField = document.getElementById('totp-field')
const recoveryField = document.getElementById('recovery-field')
const toggle = document.getElementById('toggle')
const submit = document.getElementById('submit')
const errorBox = document.getElementById('error')

let useRecovery = false

function showError(message) {
  errorBox.textContent = message
  errorBox.hidden = !message
}

toggle.addEventListener('click', () => {
  useRecovery = !useRecovery
  totpField.hidden = useRecovery
  recoveryField.hidden = !useRecovery
  // A hidden required field would block submit, so only the visible one is required.
  code.required = !useRecovery
  recovery.required = useRecovery
  toggle.textContent = useRecovery ? 'Use an authenticator code' : 'Use a recovery code'
  showError('')
  ;(useRecovery ? recovery : code).focus()
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError('')
  submit.disabled = true
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value, code: (useRecovery ? recovery : code).value })
    })
    if (res.status === 204) {
      window.location.replace('/')
      return
    }
    let message = 'Something went wrong. Try again.'
    try {
      const data = await res.json()
      if (data && typeof data.error === 'string') message = data.error
    } catch {
      // keep the generic message
    }
    showError(message)
    ;(useRecovery ? recovery : code).value = ''
    password.focus()
  } catch {
    showError('Could not reach the server. Try again.')
  } finally {
    submit.disabled = false
  }
})

// Only the desktop app has the bridge: there the link is the way back to the server picker.
const switchServer = document.getElementById('switch-server')
if (window.zumibotDesktop && switchServer) {
  switchServer.hidden = false
  switchServer.addEventListener('click', () => window.zumibotDesktop.switchServer())
}
