const path = require('node:path')
const fs = require('node:fs')
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  session,
  shell
} = require('electron')
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron')
const { autoUpdater } = require('electron-updater')

const APP_NAME = `ReYohoho Desktop ${app.getVersion()}`
const DEFAULT_MAIN_SITE_URL = process.env.REYOHOHO_SITE_URL || 'https://dav2010id.github.io/reyohoho/'
const CONFIG_PATH = path.join(__dirname, '..', 'prebuilts', 'config.json')
const ADBLOCK_PATH = path.join(__dirname, '..', 'prebuilts', 'adblock.txt')
const FORCE_BLOCKED_AD_HOSTS = [
  'alloviewroll.com',
  '21wiz.com',
  'adstag0102.xyz',
  'servetraff.com'
]
const CHROME_MAJOR_VERSION = process.versions.chrome.split('.')[0]
const BROWSER_USER_AGENT =
  process.env.REYOHOHO_USER_AGENT ||
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
const BROWSER_SEC_CH_UA =
  process.env.REYOHOHO_SEC_CH_UA ||
  `"Chromium";v="${CHROME_MAJOR_VERSION}", "Google Chrome";v="${CHROME_MAJOR_VERSION}", "Not/A)Brand";v="99"`

let mainWindow = null
let mirrorSelectionWindow = null
let torrentsWindow = null
let deepLinkUrl = null
let appConfig = null
let appStore = {}
let adBlocker = null
let adBlockLogPath = null
const adBlockGuardSessions = new WeakSet()

app.commandLine.appendSwitch('disable-site-isolation-trials')
app.commandLine.appendSwitch('user-agent', BROWSER_USER_AGENT)

const getStorePath = () => path.join(app.getPath('userData'), 'settings.json')

const readJsonFile = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

const loadAppConfig = () => {
  appConfig = readJsonFile(CONFIG_PATH, {
    main_site_url: DEFAULT_MAIN_SITE_URL,
    jacred_api_url: 'https://api.jacred.su',
    mirrors: [DEFAULT_MAIN_SITE_URL]
  })

  if (!appConfig.main_site_url) {
    appConfig.main_site_url = DEFAULT_MAIN_SITE_URL
  }

  if (!appConfig.jacred_api_url) {
    appConfig.jacred_api_url = 'https://api.jacred.su'
  }
}

const loadStore = () => {
  appStore = readJsonFile(getStorePath(), {})
}

const saveStore = () => {
  try {
    fs.mkdirSync(path.dirname(getStorePath()), { recursive: true })
    fs.writeFileSync(getStorePath(), JSON.stringify(appStore, null, 2))
  } catch (error) {
    console.warn('Failed to save settings:', error)
  }
}

const getSetting = (key, fallback = null) => (Object.hasOwn(appStore, key) ? appStore[key] : fallback)

const setSetting = (key, value) => {
  appStore[key] = value
  saveStore()
}

const getStoredMirror = () => {
  const fallback = appConfig?.main_site_url || DEFAULT_MAIN_SITE_URL
  const storedMirror = getSetting('userMirror', fallback)
  const allowedMirrors = [fallback, ...(Array.isArray(appConfig?.mirrors) ? appConfig.mirrors : [])]

  return allowedMirrors.includes(storedMirror) ? storedMirror : fallback
}

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

const getHeader = (headers, name) => {
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return found?.[1] || ''
}

const getHeaderPatchRules = () => {
  const rules = Array.isArray(appConfig?.header_patches) ? [...appConfig.header_patches] : []

  if (appConfig?.header_patch_host) {
    rules.push({
      host: appConfig.header_patch_host,
      referer: appConfig.header_patch_referer,
      origin: appConfig.header_patch_origin
    })
  }

  return rules.filter((rule) => rule?.host)
}

const matchesHost = (hostname, host) => hostname === host || hostname.endsWith(`.${host}`)

const installRequestHeaderPatches = () => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headerPatch = {}

    try {
      const requestUrl = new URL(details.url)
      const hostname = requestUrl.hostname
      const oldReferer = getHeader(details.requestHeaders, 'Referer')
      const targetRule = getHeaderPatchRules().find((rule) => {
        const targetIsPatchedHost = matchesHost(hostname, rule.host)
        const fromPatchedHost = rule.patch_descendants === true && oldReferer.includes(rule.host)

        return targetIsPatchedHost || fromPatchedHost
      })

      if (targetRule) {
        if (targetRule.referer) {
          headerPatch.Referer = targetRule.referer
        }

        if (targetRule.origin) {
          headerPatch.Origin = targetRule.origin
        }
      }

      headerPatch['User-Agent'] = BROWSER_USER_AGENT
      headerPatch['sec-ch-ua'] = BROWSER_SEC_CH_UA
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
  const siteUrl = new URL(getStoredMirror())
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

const setupAutoUpdater = () => {
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => console.log('Checking for update...'))
  autoUpdater.on('update-not-available', (info) => console.log('Update not available.', info?.version || ''))
  autoUpdater.on('update-available', (info) => console.log('Update available.', info?.version || ''))
  autoUpdater.on('download-progress', (progress) => {
    console.log(`Update download: ${progress.percent?.toFixed?.(1) || 0}%`)
  })
  autoUpdater.on('error', (error) => console.warn('Auto updater error:', error))
  autoUpdater.on('update-downloaded', () => {
    if (!mainWindow) return

    dialog
      .showMessageBox(mainWindow, {
        noLink: true,
        type: 'info',
        title: 'Update downloaded',
        message: 'Install the update now?',
        buttons: ['Later', 'Install']
      })
      .then((result) => {
        if (result.response === 1) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => console.warn('Update check failed:', error))
  }
}

const logAdBlock = (message, details = null) => {
  const line = `[${new Date().toISOString()}] ${message}${details ? ` ${details}` : ''}`
  console.log(line)

  if (!adBlockLogPath) return

  try {
    fs.appendFileSync(adBlockLogPath, `${line}\n`)
  } catch {
    // Logging must never break navigation.
  }
}

const isForceBlockedAdHost = (hostname) =>
  FORCE_BLOCKED_AD_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))

const installAdBlockRequestGuard = (targetSession = session.defaultSession) => {
  if (!targetSession || adBlockGuardSessions.has(targetSession)) return

  adBlockGuardSessions.add(targetSession)
  logAdBlock('AdBlock guard installed')

  targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      const hostname = new URL(details.url).hostname

      if (isForceBlockedAdHost(hostname)) {
        logAdBlock('force-block', details.url)
        callback({ cancel: true })
        return
      }
    } catch {
      // Continue through the adblock engine for non-standard URLs.
    }

    if (adBlocker) {
      adBlocker.onBeforeRequest(details, callback)
      return
    }

    callback({})
  })
}

const installAdBlock = () => {
  try {
    const adblockRaw = fs.readFileSync(ADBLOCK_PATH, 'utf8')
    adBlockLogPath = path.join(app.getPath('userData'), 'adblock-debug.log')
    fs.writeFileSync(adBlockLogPath, '')
    adBlocker = ElectronBlocker.parse(adblockRaw)
    adBlocker.enableBlockingInSession(session.defaultSession)
    installAdBlockRequestGuard()
    adBlocker.on('request-blocked', (request) => {
      logAdBlock('engine-block', request.url)
    })
    logAdBlock(`AdBlock enabled with ${adblockRaw.length} filter bytes`, adBlockLogPath)
  } catch (error) {
    console.warn('Failed to enable adblock:', error)
  }
}

const isAdBlocked = (url, sourceUrl = '', type = 'other') => {
  if (!adBlocker || !url) return false

  try {
    const request = Request.fromRawDetails({
      url,
      sourceUrl,
      type
    })

    if (type === 'other') {
      request.guessTypeOfRequest()
    }

    return adBlocker.match(request).match === true
  } catch {
    return false
  }
}

const installDevToolsShortcuts = (window) => {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const key = input.key?.toUpperCase()
    const toggleRequested =
      key === 'F12' ||
      (key === 'I' && input.control && input.shift) ||
      (key === 'I' && input.meta && input.alt)

    if (toggleRequested) {
      event.preventDefault()
      window.webContents.toggleDevTools()
    }
  })
}

const openMirrorSelection = () => {
  if (mirrorSelectionWindow) {
    mirrorSelectionWindow.focus()
    return
  }

  mirrorSelectionWindow = new BrowserWindow({
    width: 620,
    height: 720,
    resizable: false,
    maximizable: false,
    minimizable: false,
    modal: !!mainWindow,
    parent: mainWindow || undefined,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512x512.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  mirrorSelectionWindow.once('ready-to-show', () => {
    mirrorSelectionWindow?.show()
    mirrorSelectionWindow?.focus()
  })

  mirrorSelectionWindow.on('closed', () => {
    mirrorSelectionWindow = null
  })

  installDevToolsShortcuts(mirrorSelectionWindow)
  mirrorSelectionWindow.loadFile(path.join(__dirname, 'mirror-selection.html'))
}

const openTorrents = async () => {
  if (torrentsWindow) {
    torrentsWindow.focus()
    return
  }

  let initialQuery = ''

  try {
    initialQuery =
      (await mainWindow?.webContents.executeJavaScript(
        `document.querySelector('meta[name="title-and-year"]')?.content ||
         document.querySelector('meta[name="original-title"]')?.content ||
         document.title || ''`
      )) || ''
  } catch {
    initialQuery = ''
  }

  torrentsWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    darkTheme: true,
    backgroundColor: '#111111',
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512x512.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  })

  torrentsWindow.setMenu(null)
  torrentsWindow.once('ready-to-show', () => {
    torrentsWindow?.show()
    torrentsWindow?.focus()
    torrentsWindow?.webContents.send('torrent-init', {
      apiBase: appConfig?.jacred_api_url || 'https://api.jacred.su',
      query: initialQuery
    })
  })

  torrentsWindow.on('closed', () => {
    torrentsWindow = null
  })

  installDevToolsShortcuts(torrentsWindow)
  torrentsWindow.loadFile(path.join(__dirname, 'jacred-torrents.html'))
}

const registerHotkeys = () => {
  globalShortcut.register('F1', openTorrents)
  globalShortcut.register('F5', reload)
  globalShortcut.register('F9', openMirrorSelection)
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
          label: 'Torrents',
          accelerator: 'F1',
          click: openTorrents
        },
        {
          label: 'Select Mirror',
          accelerator: 'F9',
          click: openMirrorSelection
        },
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
  const savedBounds = getSetting('bounds')

  mainWindow = new BrowserWindow({
    width: savedBounds?.width || 1280,
    height: savedBounds?.height || 800,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 960,
    minHeight: 640,
    darkTheme: true,
    backgroundColor: '#000000',
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512x512.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
    }
  })

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(createMenu())
  } else {
    mainWindow.setMenu(null)
    mainWindow.setMenuBarVisibility(false)
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
    const internalPrefix = appConfig?.url_handler_deny || getStoredMirror()
    const sourceUrl = mainWindow.webContents.getURL()

    if (isAdBlocked(url, sourceUrl, 'popup') || isAdBlocked(url, sourceUrl, 'mainFrame')) {
      return { action: 'deny' }
    }

    if (url.startsWith(internalPrefix)) {
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

  mainWindow.on('close', () => {
    setSetting('bounds', mainWindow.getBounds())
  })

  installAdBlockRequestGuard(mainWindow.webContents.session)
  installDevToolsShortcuts(mainWindow)
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
    loadAppConfig()
    loadStore()
    installRequestHeaderPatches()
    installAdBlock()
    registerHotkeys()
    setupAutoUpdater()
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

app.on('web-contents-created', (_event, webContents) => {
  installAdBlockRequestGuard(webContents.session)

  webContents.setWindowOpenHandler(({ url }) => {
    const sourceUrl = webContents.getURL()

    if (isAdBlocked(url, sourceUrl, 'popup') || isAdBlocked(url, sourceUrl, 'mainFrame')) {
      return { action: 'deny' }
    }

    shell.openExternal(url)
    return { action: 'deny' }
  })
})

ipcMain.handle('show-toast', async (_event, message) => {
  mainWindow?.webContents.send('desktop-toast', String(message || ''))
})

ipcMain.handle('get-app-config', () => appConfig)

ipcMain.handle('get-stored-mirror', () => getStoredMirror())

ipcMain.handle('get-mirrors-list', () => {
  const configuredMirrors = [
    appConfig?.main_site_url,
    ...(Array.isArray(appConfig?.mirrors) ? appConfig.mirrors : [])
  ].filter(Boolean)

  return [...new Set(configuredMirrors)].join('\n')
})

ipcMain.handle('get-stored-credentials', () => getSetting('credentials', { login: '', password: '' }))

ipcMain.handle('get-setting', (_event, key, fallback = null) => getSetting(String(key), fallback))

ipcMain.on('set-setting', (_event, key, value) => setSetting(String(key), value))

ipcMain.on('mirror-selected', (_event, selectedMirror) => {
  setSetting('userMirror', String(selectedMirror || appConfig?.main_site_url || DEFAULT_MAIN_SITE_URL))
  mirrorSelectionWindow?.close()
  loadMainSite()
})

ipcMain.on('mirror-cancelled', () => {
  mirrorSelectionWindow?.close()
})

ipcMain.on('open-mirror-selection', () => {
  openMirrorSelection()
})

ipcMain.on('open-torrents', () => {
  openTorrents()
})

ipcMain.on('open-external-url', (_event, url) => {
  shell.openExternal(String(url || ''))
})

ipcMain.on('copy-text', (_event, text) => {
  clipboard.writeText(String(text || ''))
})
