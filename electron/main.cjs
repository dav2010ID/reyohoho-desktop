const path = require('node:path')
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, session, shell } = require('electron')

const APP_NAME = `ReYohoho Desktop ${app.getVersion()}`
const MAIN_SITE_URL = process.env.REYOHOHO_SITE_URL || 'https://dav2010id.github.io/reyohoho/'
const KINOHUB_REFERER = 'https://on.kinohub.vip/'
const SANSA_ORIGIN = 'https://sansa.stravers.live'

let mainWindow = null
let deepLinkUrl = null

app.commandLine.appendSwitch('disable-site-isolation-trials')

const mergeHeaders = (headers, patch) => {
  const result = {}
  const patchNames = new Set(Object.keys(patch).map((key) => key.toLowerCase()))

  for (const [key, value] of Object.entries(headers || {})) {
    if (!patchNames.has(key.toLowerCase())) {
      result[key] = value
    }
  }

  return {
    ...result,
    ...patch
  }
}

const installRequestHeaderPatches = () => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headerPatch = {}

    try {
      const requestUrl = new URL(details.url)
      const hostname = requestUrl.hostname

      if (hostname === 'sansa.stravers.live' || hostname.endsWith('.sansa.stravers.live')) {
        headerPatch.Referer = KINOHUB_REFERER

        if (details.resourceType !== 'subFrame') {
          headerPatch.Origin = requestUrl.origin
        }
      }

      if (hostname === 'rtbcdn.cloud' || hostname.endsWith('.rtbcdn.cloud')) {
        headerPatch.Referer = KINOHUB_REFERER
        headerPatch.Origin = SANSA_ORIGIN
      }
    } catch {
      // Ignore non-standard URLs.
    }

    callback({
      requestHeaders: mergeHeaders(details.requestHeaders, headerPatch)
    })
  })
}

const getDeepLinkPath = (url) => {
  if (!url) return ''

  try {
    const parsedUrl = new URL(url)
    return parsedUrl.hash || parsedUrl.pathname.replace(/^\/+/, '')
  } catch {
    return ''
  }
}

const getMainSiteUrl = (deepLink = deepLinkUrl) => {
  const siteUrl = new URL(MAIN_SITE_URL)
  const deepLinkPath = getDeepLinkPath(deepLink)

  if (deepLinkPath) {
    siteUrl.hash = deepLinkPath.startsWith('#') ? deepLinkPath : `#/${deepLinkPath}`
  }

  return siteUrl.toString()
}

const loadMainSite = async (deepLink = deepLinkUrl) => {
  if (!mainWindow) return

  mainWindow.setTitle(`${APP_NAME} Loading ....`)
  await mainWindow.loadURL(getMainSiteUrl(deepLink))
}

const reload = () => {
  if (!mainWindow) return

  if (mainWindow.webContents.getURL().includes('loader.html')) {
    loadMainSite()
  } else {
    mainWindow.reload()
  }
}

const reloadIgnoringCache = () => {
  if (!mainWindow) return

  if (mainWindow.webContents.getURL().includes('loader.html')) {
    loadMainSite()
  } else {
    mainWindow.webContents.reloadIgnoringCache()
  }
}

const toggleDevTools = () => {
  const focusedWindow = BrowserWindow.getFocusedWindow() || mainWindow
  if (!focusedWindow) return

  focusedWindow.webContents.toggleDevTools()
}

const registerHotkeys = () => {
  globalShortcut.register('F5', reload)
  globalShortcut.register('CommandOrControl+F5', reloadIgnoringCache)
  globalShortcut.register('F12', toggleDevTools)
  globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools)
}

const createMenu = () =>
  Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle DevTools',
          accelerator: 'F12',
          click: toggleDevTools
        },
        {
          label: 'Reload',
          accelerator: 'F5',
          click: reload
        },
        {
          label: 'Reload Ignoring Cache',
          accelerator: 'CommandOrControl+F5',
          click: reloadIgnoringCache
        }
      ]
    }
  ])

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    darkTheme: true,
    backgroundColor: '#000000',
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512x512.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      devTools: true
    }
  })

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(createMenu())
  } else {
    mainWindow.setMenu(createMenu())
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
    mainWindow.focus()

    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(MAIN_SITE_URL)) {
      mainWindow.loadURL(url)
    } else {
      shell.openExternal(url)
    }

    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow?.setTitle(`${APP_NAME} Loading ....`)
  })

  mainWindow.webContents.on('did-stop-loading', () => {
    mainWindow?.setTitle(APP_NAME)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow?.webContents.getURL() || ''

    if (currentUrl.includes('loader.html')) {
      setTimeout(() => loadMainSite(), 100)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  await mainWindow.loadFile(path.join(__dirname, 'loader.html'))
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('reyohoho', process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('reyohoho')
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    deepLinkUrl = argv.find((arg) => arg.startsWith('reyohoho://')) || null

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      loadMainSite(deepLinkUrl)
    }
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    deepLinkUrl = url
    loadMainSite(deepLinkUrl)
  })

  app.whenReady().then(() => {
    installRequestHeaderPatches()
    registerHotkeys()
    return createWindow()
  })
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

ipcMain.handle('show-toast', async (_event, message) => {
  mainWindow?.webContents.send('desktop-toast', String(message || ''))
})
