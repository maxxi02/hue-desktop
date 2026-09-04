import { app, shell, BrowserWindow, desktopCapturer, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/letter-h.png?asset'
import { registerIpc } from './ipc'
import { initHotkeys, summon, toggleSession, unregisterAllHotkeys } from './hotkeys'
import { startPhoneMirror, stopPhoneMirror } from './phone-mirror'
import { startRelay, stopRelay } from './relay-client'
import { configureUsageStore, flush as flushUsage } from './usage-store'
import { getSettings } from './settings'
import { isPermissionAllowed } from './permissions'
import { displayCapturePolicy } from './display-capture'
import { applyStealth } from './stealth'
import { applyWindowAnchor, trackWindowPlacement, watchDisplayChanges } from './window-placement'
import { probeGpu } from './system-memory'

// Last-resort net. Node's default for an unhandled rejection is to terminate the
// process, and in Electron that takes the whole app down — from a live interview
// with no warning. Nothing below this line should rely on it: every known throw
// site is guarded locally. This exists so an *unknown* one costs a log line
// instead of the session.
process.on('uncaughtException', (err) => {
  console.error('uncaught exception in main:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection in main:', reason)
})

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

  // Restore stealth from the saved setting before the window is ever shown, so a
  // user who left it on is never briefly capturable at launch.
  applyStealth(win, getSettings().stealthMode)

  // Place the window before it is ever shown, so an anchored card appears where
  // the user parked it instead of flashing at the default position and jumping.
  applyWindowAnchor(win)
  // Dragging is an OS-level move (the header is -webkit-app-region: drag), so the
  // only way to notice it is the 'moved' event. This records the new position and
  // releases the anchor — silently snapping a dragged window back would read as
  // the app fighting the user.
  trackWindowPlacement(win)

  win.on('ready-to-show', () => {
    // Re-applied here rather than only above because the 'activate' handler can
    // build a fresh window long after boot; without this the recreated window
    // would come back unprotected while the setting still says otherwise.
    applyStealth(win, getSettings().stealthMode)
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

  // Grant only the capabilities Hue actually uses (see ./permissions).
  // Everything else — geolocation, notifications, clipboard, etc. — is denied.
  const ses = win.webContents.session
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(isPermissionAllowed(permission))
  )
  ses.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission))

  // System audio for Companion mode: the interviewer's voice, coming out of the
  // speakers. `getDisplayMedia` in the renderer routes here.
  //
  // Which mechanism serves it is a per-platform decision with a real difference
  // behind it, so it lives in `display-capture.ts` as a tested pure function
  // rather than as a `process.platform` check spelled out at this call site. On
  // macOS 15+ the native ScreenCaptureKit picker owns the request and THIS
  // HANDLER IS NEVER INVOKED, so nothing written inside it can affect that path.
  const capture = displayCapturePolicy(process.platform, process.getSystemVersion())
  console.log('system audio capture:', capture.reason)
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // The callback MUST be invoked on every path: getDisplayMedia in the
      // renderer stays pending forever otherwise, so Companion mode would hang
      // rather than fail. An empty source list is possible when screen recording
      // is denied or the session is locked, and `video: undefined` is Chromium's
      // documented "no video track" — audio-only is all Hue actually wants.
      //
      // Where no route exists (macOS 14 and older, Linux) the video source is
      // still granted and the audio simply omitted. The renderer sees a stream
      // with no audio track and raises the platform message; granting nothing at
      // all here would surface as a bare permission error instead.
      const audio = capture.loopbackAudio ? ('loopback' as const) : undefined
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          callback({ video: sources[0], audio })
        })
        .catch((e) => {
          console.error('desktopCapturer.getSources failed:', e)
          callback({ video: undefined, audio })
        })
    },
    { useSystemPicker: capture.useSystemPicker }
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
// Startup steps that are nice-to-have, not load-bearing. The tray, the hotkeys
// and the display watcher can each fail on a given machine (a denied input hook,
// a missing icon, an odd display driver) and none of them is a reason to leave
// the user with no window at all — which is what an uncaught throw in here used
// to do, since it surfaced as an unhandled rejection off `whenReady`.
function safeStep(label: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.error(`startup step "${label}" failed:`, e)
  }
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.hue.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Before `registerIpc`, which can serve a usage query as soon as it is
  // registered. `userData` is only reliable once the app is ready, which is why
  // this is here rather than at module load.
  safeStep('configureUsageStore', () =>
    configureUsageStore(join(app.getPath('userData'), 'usage'))
  )

  // Fire-and-forget: the answer only sharpens the memory policy (integrated GPUs
  // pay for WebGPU out of system RAM), and the renderer reads that policy well
  // after this resolves. Nothing waits on it, and a failure leaves the safe
  // default rather than blocking startup.
  safeStep('probeGpu', () => void probeGpu())

  safeStep('registerIpc', registerIpc)

  safeStep('createWindow', createWindow)
  safeStep('createTray', createTray)

  // Global shortcuts: Ctrl/Cmd+Shift+Space toggles Hue's window (show / hide); the
  // configurable start-session shortcut starts/stops a session — both work from any app.
  safeStep('initHotkeys', () => initHotkeys(() => mainWindow))

  // Re-anchor when the desktop geometry changes. This is the case that actually
  // strands the window: unplugging a dock, or a resolution change mid-call, can
  // leave an anchored card off-screen entirely on a monitor that no longer
  // exists — and a window you cannot see is a window you cannot drag back.
  safeStep('watchDisplayChanges', () => watchDisplayChanges(() => mainWindow))

  // Resume the phone mirror if the user left it enabled (the QR URL changes per
  // launch because the auth token is regenerated — re-scan from Settings).
  safeStep('phoneMirror', () => {
    if (getSettings().phoneMirrorEnabled) {
      startPhoneMirror().catch((err) => console.error('phone mirror failed to start:', err))
    }
  })

  // Resume the relay if the user left it enabled. A fresh room means the phone
  // must re-scan after a desktop restart — same contract as the LAN mirror's URL.
  safeStep('relay', () => {
    if (getSettings().relayEnabled) {
      startRelay(getSettings().relayBaseUrl).catch((err) =>
        console.error('relay failed to start:', err)
      )
    }
  })

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

// Each teardown is isolated: a throw in the first used to abort the handler and
// leave the mirror's HTTP server and the relay socket open, which stranded a
// hue.exe and produced EADDRINUSE on the next launch.
app.on('will-quit', () => {
  safeStep('unregisterAllHotkeys', unregisterAllHotkeys)
  safeStep('stopPhoneMirror', stopPhoneMirror)
  safeStep('stopRelay', stopRelay)
  // Usage is buffered and written on a debounce to keep it off the interview
  // hot path, so whatever happened in the last few seconds is still in memory
  // at this point. Last chance to write it — and `safeStep` because losing
  // usage data must never be the reason a quit hangs.
  safeStep('flushUsage', flushUsage)
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
