/** UI state (Zustand): toasts, confirm dialogs, theme. */
import { create } from 'zustand'
import { configureApi } from './api'

export type ToastTone = 'success' | 'error' | 'info'
export interface Toast { id: number; tone: ToastTone; message: string }

interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

interface StepUpRequest {
  action: string
  amount: number
  resolve: (token: string | null) => void
}

type Theme = 'light' | 'dark' | 'system'

interface UiState {
  toasts: Toast[]
  confirmReq: ConfirmRequest | null
  stepUpReq: StepUpRequest | null
  theme: Theme
  sidebarOpen: boolean
  toast: (message: string, tone?: ToastTone) => void
  dismiss: (id: number) => void
  confirm: (opts: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>
  closeConfirm: (ok: boolean) => void
  stepUp: (action: string, amount: number) => Promise<string | null>
  closeStepUp: (token: string | null) => void
  setTheme: (t: Theme) => void
  setSidebar: (open: boolean) => void
}

let nextId = 1

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('cibara_theme')
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', !!dark)
}

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  confirmReq: null,
  stepUpReq: null,
  theme: readTheme(),
  sidebarOpen: false,
  toast(message, tone = 'success') {
    const id = nextId++
    set({ toasts: [...get().toasts.slice(-3), { id, tone, message }] })
    setTimeout(() => get().dismiss(id), tone === 'error' ? 6000 : 3500)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  confirm(opts) {
    return new Promise<boolean>((resolve) => {
      get().confirmReq?.resolve(false)
      set({ confirmReq: { ...opts, resolve } })
    })
  },
  closeConfirm(ok) {
    get().confirmReq?.resolve(ok)
    set({ confirmReq: null })
  },
  stepUp(action, amount) {
    return new Promise<string | null>((resolve) => {
      get().stepUpReq?.resolve(null)
      set({ stepUpReq: { action, amount, resolve } })
    })
  },
  closeStepUp(token) {
    get().stepUpReq?.resolve(token)
    set({ stepUpReq: null })
  },
  setTheme(t) {
    try { localStorage.setItem('cibara_theme', t) } catch { /* private mode */ }
    applyTheme(t)
    set({ theme: t })
  },
  setSidebar: (open) => set({ sidebarOpen: open }),
}))

export const toast = (m: string, tone?: ToastTone) => useUi.getState().toast(m, tone)
export const confirmDialog = (o: Omit<ConfirmRequest, 'resolve'>) => useUi.getState().confirm(o)

configureApi({
  confirmDuplicate: (secondsAgo) =>
    confirmDialog({
      title: 'Record this again?',
      message: `This exact entry was already submitted ${Math.round(secondsAgo)}s ago. Record it a second time?`,
      confirmLabel: 'Record again',
    }),
  stepUp: (action, amount) => useUi.getState().stepUp(action, amount),
})
