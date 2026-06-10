import type { HueApi } from './index'

declare global {
  interface Window {
    hue: HueApi
  }
}
