const { contextBridge, ipcRenderer } = require('electron')

const DESKTOP_CHROME_STYLE_ID = 'reyohoho-desktop-chrome-style'

const installDesktopChrome = () => {
  if (!document.getElementById(DESKTOP_CHROME_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = DESKTOP_CHROME_STYLE_ID
    style.textContent = `
      :root {
        scrollbar-color: #3a3a3f #070707;
        scrollbar-width: thin;
      }

      *::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }

      *::-webkit-scrollbar-track {
        background: #070707;
      }

      *::-webkit-scrollbar-thumb {
        min-height: 48px;
        background: #3a3a3f;
        border: 2px solid #070707;
        border-radius: 999px;
      }

      *::-webkit-scrollbar-thumb:hover {
        background: #55555d;
      }

      *::-webkit-scrollbar-corner {
        background: #070707;
      }
    `
    document.head.appendChild(style)
  }
}

const installDesktopChromeWhenReady = () => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDesktopChrome, { once: true })
  } else {
    installDesktopChrome()
  }
}

const showToast = (message) => {
  const text = String(message || '').trim()
  if (!text) return

  const render = () => {
    const existingToast = document.querySelector('[data-electron-toast]')
    existingToast?.remove()

    const toast = document.createElement('div')
    toast.dataset.electronToast = 'true'
    toast.textContent = text
    toast.style.position = 'fixed'
    toast.style.left = '50%'
    toast.style.bottom = '32px'
    toast.style.transform = 'translateX(-50%)'
    toast.style.maxWidth = 'min(560px, calc(100vw - 32px))'
    toast.style.padding = '12px 16px'
    toast.style.borderRadius = '8px'
    toast.style.background = 'rgba(18, 18, 18, 0.94)'
    toast.style.color = '#fff'
    toast.style.font = '14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    toast.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.35)'
    toast.style.zIndex = '2147483647'
    toast.style.pointerEvents = 'none'

    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 2400)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true })
  } else {
    render()
  }
}

installDesktopChromeWhenReady()

ipcRenderer.on('desktop-toast', (_event, message) => showToast(message))

contextBridge.exposeInMainWorld('electronAPI', {
  showToast(message) {
    showToast(message)
    ipcRenderer.invoke('show-toast', message)
  },
  onToast(callback) {
    const listener = (_event, message) => callback(message)
    ipcRenderer.on('desktop-toast', listener)

    return () => ipcRenderer.removeListener('desktop-toast', listener)
  },
  onDeepLink(callback) {
    const listener = (_event, hash) => callback(hash)
    ipcRenderer.on('desktop-deep-link', listener)

    return () => ipcRenderer.removeListener('desktop-deep-link', listener)
  }
})
