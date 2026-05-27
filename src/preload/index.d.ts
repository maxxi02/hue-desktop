import { ElectronAPI } from '@electron-toolkit/preload'
import type { HueApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    hue: HueApi
  }
}
