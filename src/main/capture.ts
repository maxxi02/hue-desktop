import { desktopCapturer, screen } from 'electron'
import type { ScreenCapture } from '../shared/types'

// Claude's vision sweet spot: images are downscaled server-side past ~1568px on
// the long edge anyway, and a smaller image costs far fewer tokens while keeping
// on-screen text legible. We downscale to this before sending.
const MAX_EDGE = 1568

/**
 * Grab the primary display as a PNG, downscaled so its long edge is <= MAX_EDGE.
 * Used by the screen-capture feature so the assistant can read a screen-shared
 * coding prompt / question. Returns base64 ready to attach to an LLM message.
 *
 * The caller is responsible for hiding Hue's own window first if it would
 * otherwise occlude the content (see the IPC handler).
 */
export async function captureScreen(): Promise<ScreenCapture> {
  const primary = screen.getPrimaryDisplay()
  // Request the thumbnail at the display's physical pixel size so text stays
  // sharp; we downscale afterwards. scaleFactor accounts for HiDPI displays.
  const scale = primary.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(primary.size.width * scale),
      height: Math.round(primary.size.height * scale)
    }
  })

  // Match the primary display by id when the platform reports it; otherwise the
  // first screen source is the primary one.
  const primaryId = String(primary.id)
  const source = sources.find((s) => s.display_id === primaryId) ?? sources[0]
  if (!source) throw new Error('No screen source available to capture.')

  let image = source.thumbnail
  if (image.isEmpty()) {
    throw new Error('Screen capture returned an empty image. Check screen-recording permission.')
  }

  const size = image.getSize()
  const longEdge = Math.max(size.width, size.height)
  if (longEdge > MAX_EDGE) {
    const ratio = MAX_EDGE / longEdge
    image = image.resize({
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
      quality: 'good'
    })
  }

  const finalSize = image.getSize()
  return {
    dataBase64: image.toPNG().toString('base64'),
    mediaType: 'image/png',
    width: finalSize.width,
    height: finalSize.height
  }
}
