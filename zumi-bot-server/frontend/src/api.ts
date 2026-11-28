import { createApi } from './net/api'
import { islandBridge } from './net/island'
import { popoutBridge, popoutChatId } from './net/popout'
import { pickerHost } from './net/folderPickerHost'
import { createRpcClient } from './net/rpc'
import { redirectToLogin } from './net/signedOut'

const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`

export const rpc = createRpcClient({ url, onSignedOut: () => redirectToLogin() })

// A half-open socket fires no close: after sleep or a network change the page would show connected while every call hangs.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') rpc.checkAlive()
})
window.addEventListener('online', () => rpc.checkAlive())

export const api = createApi(rpc, {
  fetch: (...a) => fetch(...a),
  // The island and popout windows get only their own bridge: their pages never have the main window's.
  desktop:
    islandBridge || popoutChatId !== null
      ? null
      : ((window as unknown as { zumibotDesktop?: import('@zumibot/shared/desktop').DesktopBridge }).zumibotDesktop ?? null),
  fileOpener: islandBridge ?? popoutBridge,
  openWindow: (u) => void window.open(u, '_blank', 'noopener'),
  folderPicker: (start) => pickerHost.open(start),
  setBeforeUnload: (handler) => {
    window.onbeforeunload = handler
  }
})
