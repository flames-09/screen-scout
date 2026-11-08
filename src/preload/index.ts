import { contextBridge, ipcRenderer } from 'electron'
import type { UpdatePhase, UpdateStateSnapshot } from '@shared/types'
import type {
  AppSettings,
  ChatEvent,
  ChatTurn,
  ConnectionTestResult,
  HostedQuota,
  ImageImportResult,
  PublicSettings,
  SelectionResult,
  SelectionStartResult,
  SendMessageResult
} from '@shared/types'

/**
 * The only bridge between renderers and the main process.
 *
 * Design rules:
 *  - A small, typed, allow-listed API — no arbitrary channels.
 *  - The renderer can never obtain the API key or any Node/Electron object.
 *  - Every privileged operation stays in the main process; this file only
 *    forwards typed calls and validated-shaped events.
 */

const scoutApi = {
  // --- Assistant -----------------------------------------------------------
  selection: {
    /** Starts a selection session. The outcome arrives via onSelectionResult. */
    start(): Promise<SelectionStartResult> {
      return ipcRenderer.invoke('selection:start')
    },
    /**
     * Pushed outcome of every selection session — whether it was started
     * from the popup button or the direct-capture global shortcut.
     */
    onSelectionResult(handler: (result: SelectionResult) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, result: SelectionResult): void => handler(result)
      ipcRenderer.on('selection:result', listener)
      return () => ipcRenderer.removeListener('selection:result', listener)
    }
  },
  images: {
    /** Imports image bytes (e.g. a dropped file) as a validated attachment. */
    importBytes(bytes: Uint8Array): Promise<ImageImportResult> {
      return ipcRenderer.invoke('images:import', bytes)
    },
    /** Imports whatever image currently sits on the system clipboard. */
    fromClipboard(): Promise<ImageImportResult> {
      return ipcRenderer.invoke('images:from-clipboard')
    }
  },
  chat: {
    send(input: { requestId: string; text: string; imageDataUrl?: string; history: ChatTurn[] }): Promise<SendMessageResult> {
      return ipcRenderer.invoke('chat:send', input)
    },
    cancel(requestId: string): Promise<void> {
      return ipcRenderer.invoke('chat:cancel', { requestId })
    },
    onEvent(handler: (event: ChatEvent) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, event: ChatEvent): void => handler(event)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },
  settings: {
    get(): Promise<PublicSettings> {
      return ipcRenderer.invoke('settings:get')
    },
    save(patch: Partial<AppSettings>): Promise<PublicSettings> {
      return ipcRenderer.invoke('settings:save', patch)
    },
    /** Pushed by main after ANY settings/key change — keeps the popup's model
     * chip and key state current without waiting for a window-focus refetch. */
    onChanged(handler: (settings: PublicSettings) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, settings: PublicSettings): void => handler(settings)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    },
    saveApiKey(key: string): Promise<{ ok: boolean; secure: boolean; message?: string }> {
      return ipcRenderer.invoke('key:save', key)
    },
    removeApiKey(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('key:remove')
    },
    testConnection(overrides?: { baseUrl?: string; model?: string }): Promise<ConnectionTestResult> {
      return ipcRenderer.invoke('connection:test', overrides ?? {})
    },
    /** Free-tier usage for the hosted mode meter (null when unavailable). */
    getHostedQuota(): Promise<HostedQuota | null> {
      return ipcRenderer.invoke('hosted:quota')
    },
    open(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('settings:open')
    }
  },
  window: {
    hide(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('window:hide')
    },
    resizeBy(deltaWidth: number, deltaHeight: number): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('window:resizeBy', { deltaWidth, deltaHeight })
    },
    onVisibility(handler: (payload: { visible: boolean; resetSession: boolean }) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, payload: { visible: boolean; resetSession: boolean }): void => {
        // resetSession defaults to true for legacy senders that omit it.
        handler({ visible: payload.visible, resetSession: payload.resetSession !== false })
      }
      ipcRenderer.on('window:visibility', listener)
      return () => ipcRenderer.removeListener('window:visibility', listener)
    },
    // Frosted-glass backdrop: the main process sends a screenshot of the
    // desktop region behind the window just before showing it. Validated
    // before forwarding — it flows into a CSS url() in the renderer.
    onBackdrop(handler: (dataUrl: string) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, payload: { dataUrl: string }): void => {
        if (typeof payload?.dataUrl === 'string' && payload.dataUrl.startsWith('data:image/')) {
          handler(payload.dataUrl)
        }
      }
      ipcRenderer.on('window:backdrop', listener)
      return () => ipcRenderer.removeListener('window:backdrop', listener)
    }
  },
  app: {
    quit(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('app:quit')
    },
    openExternal(url: string): Promise<{ ok: boolean; message?: string }> {
      return ipcRenderer.invoke('app:openExternal', url)
    },
    openLogs(): Promise<{ ok: boolean; message?: string }> {
      return ipcRenderer.invoke('app:openLogs')
    },
    copyDiagnostics(): Promise<{ ok: boolean; message?: string }> {
      return ipcRenderer.invoke('app:copyDiagnostics')
    }
  },
  // --- Updates -----------------------------------------------------------------
  updates: {
    state(): Promise<UpdateStateSnapshot> {
      return ipcRenderer.invoke('updates:state')
    },
    check(): Promise<UpdatePhase> {
      return ipcRenderer.invoke('updates:check')
    },
    download(): Promise<UpdatePhase> {
      return ipcRenderer.invoke('updates:download')
    },
    install(): Promise<{ ok: boolean; message?: string }> {
      return ipcRenderer.invoke('updates:install')
    },
    onState(handler: (snapshot: UpdateStateSnapshot) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, payload: UpdateStateSnapshot): void => {
        if (payload && payload.phase && typeof payload.appVersion === 'string') handler(payload)
      }
      ipcRenderer.on('updates:state', listener)
      return () => ipcRenderer.removeListener('updates:state', listener)
    }
  },
  // --- Selection overlay ------------------------------------------------------
  overlay: {
    reportRect(rect: { x: number; y: number; width: number; height: number }): void {
      ipcRenderer.send('selection:rect', rect)
    },
    cancel(): void {
      ipcRenderer.send('selection:cancel')
    },
    onInvalid(handler: (message: string) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, payload: { message: string }): void => handler(payload.message)
      ipcRenderer.on('selection:invalid', listener)
      return () => ipcRenderer.removeListener('selection:invalid', listener)
    }
  }
}

export type ScoutApi = typeof scoutApi

contextBridge.exposeInMainWorld('scout', scoutApi)
