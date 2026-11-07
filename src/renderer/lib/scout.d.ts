import type { ScoutApi } from '../../preload/index'

declare global {
  interface Window {
    scout: ScoutApi
  }
}

export {}
