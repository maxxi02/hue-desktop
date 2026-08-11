// Rasterises resources/hue-mark.svg into every icon asset the app and the
// installer need. Run with `npm run generate-icons` (which invokes Electron, not
// node — this file uses Electron main-process APIs).
//
// Why Electron and not a normal SVG library: this machine has no SVG rasteriser
// (no ImageMagick, Inkscape or rsvg-convert) and adding sharp/svg2png as an npm
// dependency to produce four files that change maybe once a year is a bad trade.
// Electron is already a devDependency and ships a full Chromium, which is a
// better SVG renderer than any of them. So we open a hidden, transparent
// BrowserWindow, let Chromium paint the SVG, and capture the result.
//
// Deliberately NOT wired into predev/prebuild/postinstall: icons change rarely
// and a build must never depend on being able to spawn an Electron window.
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const svgPath = join(root, 'resources', 'hue-mark.svg')

// Standalone PNGs. letter-h.png is the system-tray icon: src/main/index.ts loads
// it and resizes to 16x16, so 32 gives it a 2x source for HiDPI trays.
const pngTargets = [
  { size: 512, out: join(root, 'build', 'icon.png') },
  { size: 256, out: join(root, 'resources', 'icon.png') },
  { size: 32, out: join(root, 'resources', 'letter-h.png') }
]

// Sizes packed into build/icon.ico. Windows picks whichever fits the context
// (16 = title bar, 32 = taskbar/desktop, 256 = large tiles).
const icoSizes = [16, 32, 48, 64, 128, 256]

// build/icon.icns is intentionally left alone: the icns container cannot be
// produced on Windows, so regenerating icons here must not clobber it.

// Largest size we ever need to paint. The window is created once at this size
// and every capture crops out of its top-left corner: creating and destroying a
// transparent BrowserWindow per size made the second and later navigations fail
// with ERR_FAILED, and one long-lived window is faster anyway.
const CANVAS = Math.max(...pngTargets.map((t) => t.size), ...icoSizes)

/**
 * Open the hidden render surface. Returns a `rasterise(size) => Buffer` closure
 * plus a `dispose()`.
 */
async function createRenderer() {
  const svg = readFileSync(svgPath, 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block}
  </style>${svg}`

  // Staged as a real file rather than a data: URL — Chromium truncates/rejects
  // very long data: URLs, and this SVG carries a lot of explanatory comment.
  const htmlPath = join(app.getPath('temp'), 'hue-icon-render.html')
  writeFileSync(htmlPath, html, 'utf8')

  const win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Hidden windows are normally not painted; this forces a first paint so
    // capturePage() has something to read instead of an empty image.
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadFile(htmlPath)

  /**
   * Paint the mark at `size` px and return the PNG bytes.
   *
   * Chromium renders at `renderSize` — the smallest integer multiple of `size`
   * that is at least 256 — and the capture is downscaled afterwards. That
   * supersampling is what keeps the Bodoni hairlines visible at 16 and 32px:
   * rasterised natively at 16px the sub-pixel hairlines would simply be dropped,
   * leaving a broken "H", whereas averaging down a 256px render turns them into
   * grey pixels that still read as strokes. It also avoids asking Windows for a
   * window smaller than its ~100px minimum.
   */
  async function rasterise(size) {
    const renderSize = size >= 256 ? size : size * Math.ceil(256 / size)
    await win.webContents.executeJavaScript(
      `(() => { const s = document.querySelector('svg');
                s.style.width = s.style.height = '${renderSize}px'; })()`
    )
    // One extra beat: executeJavaScript resolves as soon as the style is set,
    // which is marginally ahead of the compositor having drawn the new size.
    await new Promise((r) => setTimeout(r, 120))

    const shot = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: renderSize,
      height: renderSize
    })
    if (shot.isEmpty()) throw new Error(`capturePage returned an empty image at ${renderSize}px`)
    // Always resize, even when renderSize === size: capturePage works in DIPs,
    // so on a scaled Windows display the raw capture would not be `size` px.
    return shot.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }

  return {
    rasterise,
    dispose() {
      win.destroy()
      rmSync(htmlPath, { force: true })
    }
  }
}

/**
 * Pack PNG buffers into a .ico. Format: a 6-byte ICONDIR, then one 16-byte
 * ICONDIRENTRY per image, then the image payloads. Entries embed the PNG bytes
 * verbatim rather than BMP/DIB data — PNG-compressed ICO entries are understood
 * by Windows Vista and later, which is well below anything Electron supports,
 * and it keeps this encoder to a few dozen lines with no dependency.
 */
function encodeIco(images) {
  const dir = Buffer.alloc(6 + 16 * images.length)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type: 1 = icon
  dir.writeUInt16LE(images.length, 4)

  let offset = dir.length
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i
    // A 256px image is stored as 0 in the single-byte width/height fields.
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2) // colours in palette (0 = truecolour)
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel (RGBA)
    dir.writeUInt32LE(png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += png.length
  })

  return Buffer.concat([dir, ...images.map((i) => i.png)])
}

async function main() {
  const renderer = await createRenderer()
  try {
    for (const { size, out } of pngTargets) {
      const png = await renderer.rasterise(size)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, png)
      console.log(`[generate-icons] wrote ${out} (${size}x${size}, ${png.length} bytes)`)
    }

    const icoImages = []
    for (const size of icoSizes) icoImages.push({ size, png: await renderer.rasterise(size) })
    const ico = encodeIco(icoImages)
    const icoOut = join(root, 'build', 'icon.ico')
    writeFileSync(icoOut, ico)
    console.log(`[generate-icons] wrote ${icoOut} (${icoSizes.join(', ')}; ${ico.length} bytes)`)
  } finally {
    renderer.dispose()
  }
}

app.disableHardwareAcceleration()
app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(`[generate-icons] failed: ${err.stack ?? err}`)
    app.exit(1)
  })
