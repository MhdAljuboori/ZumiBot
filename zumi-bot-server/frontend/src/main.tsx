import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppBoundary } from './components/ErrorBoundary'
import { TooltipLayer } from './components/TooltipLayer'
import { followKeyboardCover } from './keyboardCover'
import { openChatBus, openChatMessage } from './net/openChatBus'
import { applyAccent, applyTheme, cachedAccent, cachedTheme } from './theme'
import { holdTypingLayout } from './typingHold'
import './styles/index.css'

// The last chosen theme and color theme, before the first paint, so a dark or non-blue choice does not flash the
// default while the server answers.
applyTheme(cachedTheme() ?? 'system')
applyAccent(cachedAccent() ?? 'blue')
followKeyboardCover()
holdTypingLayout()

// The worker's "open this chat" message is dropped by a page that is not listening yet, and a notification click can
// load the page, so this listens before React renders and the app picks the chat up once it subscribes.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = openChatMessage(e.data)
    if (m?.chatId) openChatBus.emit(m.chatId)
  })
  navigator.serviceWorker.startMessages?.()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
    <TooltipLayer />
  </StrictMode>
)
