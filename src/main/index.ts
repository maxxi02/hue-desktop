import { app, shell, BrowserWindow, desktopCapturer, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/letter-h.png?asset'
import { registerIpc } from './ipc'
import { initHotkeys, summon, toggleSession, unregisterAllHotkeys } from './hotkeys'
import { startPhoneMirror, stopPhoneMirror } from './phone-mirror'
import { getSettings } from './settings'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// True once the user really wants to exit (tray "Quit" or app.quit), so the
// window's close handler knows to actually close instead of hiding to the tray.
let isQuitting = false

function createWindow(): void {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    // A chromeless floating box: no native title bar or min/max/close buttons.
    // The card is dragged by its header (-webkit-app-region: drag) and dismissed
    // via the tray or the global summon shortcut.
    frame: false,
    // Let the desktop show through. The visible card paints its own translucent
    // background (configurable via the windowOpacity setting); a fully transparent
    // native window is required for any of that translucency to be seen.
    transparent: true,
    backgroundColor: '#00000000',
    // Hue lives in the system tray, not the taskbar — keep it out of the taskbar
    // (and the alt-tab list) so it behaves like a background extension.
    skipTaskbar: true,
    // Float above other apps so clicking away (e.g. to a browser or call window)
    // never buries Hue — as a companion overlay it must stay consistently visible.
    alwaysOnTop: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload only talks to the typed contextBridge API (no Node access
      // needed), so the renderer runs fully sandboxed.
      sandbox: true
    }
  })

  mainWindow = win

  // 'screen-saver' is a higher stacking level than the default 'floating', so Hue
  // also stays above full-screen video and call windows. visibleOnAllWorkspaces
  // keeps it present when the user switches virtual desktops.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.on('ready-to-show', () => {
    win.show()
  })

  // Closing the window hides Hue to the tray so it keeps running in the
  // background (like an always-available extension). It only truly closes when
  // the user picks Quit from the tray, which sets isQuitting first.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // If the renderer process dies (GPU reset, OOM from the on-device models, …)
  // the window would otherwise sit there blank and dead. Reload so Hue comes
  // back usable; the in-memory session is lost either way. The timestamp guard
  // stops a crash-on-boot from turning into a hot reload loop.
  let lastRendererReload = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    console.error('renderer process gone:', details.reason, `(exit code ${details.exitCode})`)
    const now = Date.now()
    if (now - lastRendererReload > 10_000) {
      lastRendererReload = now
      win.webContents.reload()
    }
  })

  // Grant only the two capabilities Hue actually uses: 'media' for the voice
  // pipeline's microphone (getUserMedia) and 'display-capture' for system
  // loopback audio (getDisplayMedia, handled below). Everything else —
  // geolocation, notifications, clipboard, etc. — is denied.
  const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['media', 'display-capture'])
  const ses = win.webContents.session
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  )
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

  // System/loopback audio capture for Companion mode (the interviewer's voice on
  // a call). getDisplayMedia in the renderer routes here; we grant loopback audio
  // and a dummy screen video source (Chromium requires a video track to be
  // offered — the renderer drops it immediately and keeps only the audio).
  // NOTE: loopback audio is supported on Windows; macOS needs ScreenCaptureKit.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' })
      })
    },
    { useSystemPicker: false }
  )

  // NOTE: cross-origin isolation (COOP/COEP) is deliberately NOT enabled here.
  // It exposes SharedArrayBuffer, which makes onnxruntime-web's threaded WASM
  // build spawn one busy-waiting thread per core for every model (VAD + Whisper
  // + Kokoro). On startup that pegs every core and freezes the window. With
  // isolation off and numThreads=1 everywhere, onnxruntime runs purely
  // single-threaded — fast enough for these small models and never freezes.

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// System tray: keeps Hue reachable while it runs in the background. Clicking the
// icon shows the window; the menu mirrors the global shortcuts and offers Quit.
function createTray(): void {
  const image = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  tray = new Tray(image.isEmpty() ? icon : image)
  tray.setToolTip('Hue')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Hue', click: () => summon() },
      { label: 'Start / stop session', click: () => toggleSession() },
      { type: 'separator' },
      {
        label: 'Quit Hue',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => summon())
}

// Hue lives hidden in the tray, so it's easy to forget it's running and launch
// it again from the Start menu / a pinned shortcut. Without this lock that
// spawned a second instance with a fresh, empty session ("Hue reopened and my
// session was cleared"). Instead, the duplicate launch exits immediately and
// the running instance summons its window — session intact.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => summon())

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.hue.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  createWindow()
  createTray()

  // Global shortcuts: Ctrl/Cmd+Shift+Space toggles Hue's window (show / hide); the
  // configurable start-session shortcut starts/stops a session — both work from any app.
  initHotkeys(() => mainWindow)

  // Resume the phone mirror if the user left it enabled (the QR URL changes per
  // launch because the auth token is regenerated — re-scan from Settings).
  if (getSettings().phoneMirrorEnabled) {
    startPhoneMirror().catch((err) => console.error('phone mirror failed to start:', err))
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Closing the last window normally hides Hue to the tray (see the window's
// 'close' handler), so this only fires during a real quit. Staying alive
// otherwise is what lets Hue keep running in the background.
app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  unregisterAllHotkeys()
  stopPhoneMirror()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
