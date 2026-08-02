import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../libs/cx/cx'
import styles from './Toast.module.scss'

// App-wide toast system — the home for transient, non-blocking feedback (an
// action that failed, a background success), as opposed to a modal that demands
// a decision (Dialog) or a state screen that owns the whole area (StateView).
// Wrap the tree in <ToastProvider> once, then call the imperative helpers from
// anywhere via useToast():
//
//   const toast = useToast()
//   try { await api.move(...) } catch (e) { toast.error((e as Error).message) }
//
// Dependency-free and vanilla-React on purpose, the same philosophy as Dialog:
// no toast library, no new runtime deps. Toasts stack, auto-dismiss (paused
// while hovered so a reader isn't raced), and carry an optional inline action
// (e.g. Retry/Undo).

export type ToastVariant = 'error' | 'success' | 'info' | 'warning'

/** One inline action rendered as a button inside the toast (Retry, Undo, …). */
export type ToastAction = { label: string; onClick: () => void }

export type ToastOptions = {
  /** Auto-dismiss after N ms; 0 keeps it until dismissed. Defaults by tone
   *  (errors linger, successes are brief); an action bumps it longer so the
   *  button is clickable. */
  duration?: number
  action?: ToastAction
}

export type ToastApi = {
  show: (variant: ToastVariant, message: ReactNode, opts?: ToastOptions) => string
  error: (message: ReactNode, opts?: ToastOptions) => string
  success: (message: ReactNode, opts?: ToastOptions) => string
  info: (message: ReactNode, opts?: ToastOptions) => string
  warning: (message: ReactNode, opts?: ToastOptions) => string
  dismiss: (id: string) => void
}

type ToastItem = {
  id: string
  variant: ToastVariant
  message: ReactNode
  duration: number
  action?: ToastAction
}

// At most this many on screen — a burst (e.g. a folder delete that fails per
// note) drops the oldest rather than papering the corner.
const MAX_TOASTS = 4

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  error: 6000,
  warning: 6000,
  success: 4000,
  info: 4000,
}

const ToastContext = createContext<ToastApi | null>(null)

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext)

  if (!ctx) {
    throw new Error('useToast must be used within <ToastProvider>')
  }

  return ctx
}

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  // Auto-dismiss timers by id, held in a ref (a plain side effect, never state).
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Monotonic id source — no Date.now/random needed, and stable under StrictMode.
  const seq = useRef(0)

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id)

    if (t) {
      clearTimeout(t)
      timers.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
    [clearTimer],
  )

  const arm = useCallback(
    (id: string, duration: number) => {
      if (duration <= 0) {
        return
      } // sticky
      clearTimer(id)
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      )
    },
    [clearTimer, dismiss],
  )

  const show = useCallback(
    (variant: ToastVariant, message: ReactNode, opts: ToastOptions = {}): string => {
      const id = `toast-${++seq.current}`
      const duration = opts.duration ?? (opts.action ? 8000 : DEFAULT_DURATION[variant])
      setToasts((prev) => {
        const next = [...prev, { id, variant, message, duration, action: opts.action }]

        // Trim from the front (oldest) past the cap; drop their timers too.
        while (next.length > MAX_TOASTS) {
          const dropped = next.shift()

          if (dropped) {
            clearTimer(dropped.id)
          }
        }

        return next
      })
      arm(id, duration)
      return id
    },
    [arm, clearTimer],
  )

  // Clear every pending timer on unmount.
  useEffect(() => {
    const map = timers.current

    return () => {
      for (const t of map.values()) {
        clearTimeout(t)
      }
      map.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      error: (m, o) => show('error', m, o),
      success: (m, o) => show('success', m, o),
      info: (m, o) => show('info', m, o),
      warning: (m, o) => show('warning', m, o),
      dismiss,
    }),
    [show, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div className={styles.viewport} aria-live="polite">
            {toasts.map((t) => (
              <ToastCard
                key={t.id}
                toast={t}
                onDismiss={() => dismiss(t.id)}
                onPause={() => clearTimer(t.id)}
                onResume={() => arm(t.id, t.duration)}
              />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  )
}

const ToastCard = ({
  toast,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: ToastItem
  onDismiss: () => void
  onPause: () => void
  onResume: () => void
}) => (
  <div
    className={cx(styles.toast, 'glass', styles[toast.variant])}
    role={toast.variant === 'error' ? 'alert' : 'status'}
    data-testid="toast"
    data-variant={toast.variant}
    onMouseEnter={onPause}
    onMouseLeave={onResume}
  >
    <span className={styles.message}>{toast.message}</span>
    {toast.action && (
      <button
        type="button"
        className={styles.action}
        onClick={() => {
          toast.action!.onClick()
          onDismiss()
        }}
      >
        {toast.action.label}
      </button>
    )}
    <button
      type="button"
      className={styles.close}
      aria-label="Dismiss"
      data-testid="toast-dismiss"
      onClick={onDismiss}
    >
      ×
    </button>
  </div>
)
