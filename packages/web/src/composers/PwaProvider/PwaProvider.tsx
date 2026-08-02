import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useToast } from '../../core/Toast'
import { isIOS, isStandalone } from '../../libs/pwa'

// PWA lifecycle owner (#40): install availability + the service-worker update
// prompt, captured ONCE at the app root and consumed by the Settings install
// section and the update toast.
//
// Why a provider and not a hook in Settings: `beforeinstallprompt` fires once
// and only on the window — if nothing is listening when it fires, the chance to
// offer a native install is gone. The provider is mounted at the app root so the
// listener is attached on the first commit (the event fires after load, well
// after mount), and it stashes the event for Settings to use on demand.
//
// Update flow is deliberately "prompt", not auto-reload: a new SW waits, we raise
// a sticky toast ("new version — reload"), and only a click activates it
// (updateServiceWorker(true) → skipWaiting + reload). Nothing reloads under the
// user mid-edit.

/** The non-standard install-prompt event (Chromium only; not in lib.dom). */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export type PwaContextValue = {
  /** A native install prompt is available right now (Chromium, not yet installed). */
  canInstall: boolean
  /** Fire the browser install prompt; resolves true if the user accepted. A
   *  no-op resolving false when no prompt is pending. */
  promptInstall: () => Promise<boolean>
  /** Running as an installed standalone app. */
  installed: boolean
  /** iOS Safari (no install prompt) and not yet installed — show manual
   *  Add-to-Home-Screen instructions instead of a button. */
  iosHint: boolean
  /** A newer service worker is waiting to take over. */
  updateReady: boolean
  /** Activate the waiting worker and reload into the new version. */
  updateNow: () => void
}

const PwaContext = createContext<PwaContextValue | null>(null)

export const usePwa = (): PwaContextValue => {
  const ctx = useContext(PwaContext)

  if (!ctx) {
    throw new Error('usePwa must be used within <PwaProvider>')
  }

  return ctx
}

export const PwaProvider = ({ children }: { children: ReactNode }) => {
  const toast = useToast()
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => isStandalone())

  // Service-worker registration (vite-plugin-pwa). With registerType 'prompt',
  // needRefresh flips true when a new SW is waiting. When the plugin is disabled
  // (VITE_PWA=off in the test build) this resolves to a stub that never refreshes.
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  // Capture the install prompt app-wide (it fires once, early); clear it once the
  // app is installed so the Settings button disappears without a reload.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setInstallEvent(e as BeforeInstallPromptEvent)
    }

    const markInstalled = () => {
      setInstalled(true)
      setInstallEvent(null)
    }
    // `appinstalled` covers the browser's own install; the display-mode change
    // covers becoming standalone while the tab is open (and isn't fired as
    // appinstalled), so the Settings status flips live either way.
    const standaloneMql = window.matchMedia('(display-mode: standalone)')

    const onDisplayChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        markInstalled()
      }
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', markInstalled)
    standaloneMql.addEventListener('change', onDisplayChange)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', markInstalled)
      standaloneMql.removeEventListener('change', onDisplayChange)
    }
  }, [])

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!installEvent) {
      return false
    }
    await installEvent.prompt()
    const { outcome } = await installEvent.userChoice
    // The prompt event is single-use; drop it whatever the choice.
    setInstallEvent(null)
    return outcome === 'accepted'
  }, [installEvent])

  const updateNow = useCallback(() => {
    void updateServiceWorker(true)
  }, [updateServiceWorker])

  // Surface a waiting update once, as a sticky toast with a Reload action — the
  // issue's "update available — reload" affordance. Sticky (duration 0) so a
  // background update isn't missed; shown once per session (the ref guards the
  // StrictMode double-effect and re-renders).
  const toastShown = useRef(false)
  useEffect(() => {
    if (needRefresh && !toastShown.current) {
      toastShown.current = true
      toast.info('A new version of Notarium is available.', {
        duration: 0,
        action: { label: 'Reload', onClick: updateNow },
      })
    }
  }, [needRefresh, toast, updateNow])

  const value: PwaContextValue = {
    canInstall: !!installEvent && !installed,
    promptInstall,
    installed,
    iosHint: isIOS() && !installed,
    updateReady: needRefresh,
    updateNow,
  }

  return <PwaContext.Provider value={value}>{children}</PwaContext.Provider>
}
