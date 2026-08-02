import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '../Button'
import { Modal, type ModalSize } from '../Modal'
import styles from './Dialog.module.scss'

// App-wide dialog system. Wrap the tree in <DialogProvider> once, then call the
// imperative helpers from anywhere via useDialog():
//
//   const { confirm } = useDialog()
//   if (await confirm({ title: 'Delete note?', message: '…', danger: true })) { … }
//
// The promise resolves true/false (confirm) so call sites read like the native
// confirm() they replace, but render a styled, themeable dialog instead. New
// dialog kinds (prompt, custom content) can be added here without touching the
// call sites of the existing ones.

export type ConfirmOptions = {
  title?: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Panel width preset (Modal's sizing system); default 'sm'. The message
   *  region scrolls inside the panel, so long content needs a wider preset,
   *  never custom widths on the content itself. */
  size?: ModalSize
}

export type AlertOptions = {
  title?: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
  size?: ModalSize
}

/** One action of a choice dialog. The LAST option gets the keyboard focus —
 *  order the list so the safe/productive action sits there. */
export type ChoiceOption = {
  label: string
  value: string
  variant?: 'primary' | 'danger' | 'ghost'
}

export type ChoiceOptions = {
  title?: string
  message?: ReactNode
  options: ChoiceOption[]
  size?: ModalSize
}

export type PromptOptions = {
  title?: string
  message?: ReactNode
  placeholder?: string
  initial?: string
  confirmLabel?: string
  size?: ModalSize
}

export type DialogApi = {
  confirm: (opts?: ConfirmOptions) => Promise<boolean>
  alert: (opts?: AlertOptions) => Promise<undefined>
  /** N-way pick (e.g. the save-conflict dialog, #50): resolves the chosen
   *  option's value, or null on Escape/backdrop. */
  choice: (opts: ChoiceOptions) => Promise<string | null>
  /** One-line text input (e.g. the new-space dialog, #16): resolves the
   *  trimmed value, or null on Escape/backdrop/empty. */
  prompt: (opts?: PromptOptions) => Promise<string | null>
}

type DialogSpec = {
  kind: 'confirm' | 'alert' | 'choice' | 'prompt'
  title: string
  message: ReactNode
  confirmLabel: string
  cancelLabel?: string
  danger: boolean
  size: ModalSize
  options?: ChoiceOption[]
  placeholder?: string
  initial?: string
}

type Pending = { resolve: (result: unknown) => void; cancelValue: unknown }

const DialogContext = createContext<DialogApi | null>(null)

export const useDialog = (): DialogApi => {
  const ctx = useContext(DialogContext)

  if (!ctx) {
    throw new Error('useDialog must be used within <DialogProvider>')
  }

  return ctx
}

export const DialogProvider = ({ children }: { children: ReactNode }) => {
  // A single active dialog at a time. `dialog` is the view spec; the pending
  // promise's resolver is held in a ref (not in state) so settling is a plain
  // side effect, never run inside a setState updater (which StrictMode double-
  // invokes). Each kind carries its `cancelValue` — what Escape/backdrop/cancel
  // and a superseding dialog resolve with.
  const [dialog, setDialog] = useState<DialogSpec | null>(null)
  const pending = useRef<Pending | null>(null)

  const settle = useCallback((result: unknown) => {
    const p = pending.current
    pending.current = null
    setDialog(null)
    p?.resolve(result)
  }, [])

  // Open a dialog and return a promise that settles when the user (or a dismiss)
  // resolves it. If one is already open, resolve it with its cancelValue first so
  // its promise never dangles.
  const present = useCallback(
    <T,>(spec: DialogSpec, cancelValue: T): Promise<T> =>
      new Promise<T>((resolve) => {
        if (pending.current) {
          const prev = pending.current
          pending.current = null
          prev.resolve(prev.cancelValue)
        }
        pending.current = { resolve: resolve as (result: unknown) => void, cancelValue }
        setDialog(spec)
      }),
    [],
  )

  const confirm = useCallback(
    (opts: ConfirmOptions = {}) =>
      present(
        {
          kind: 'confirm',
          title: opts.title || 'Are you sure?',
          message: opts.message || '',
          confirmLabel: opts.confirmLabel || 'Confirm',
          cancelLabel: opts.cancelLabel || 'Cancel',
          danger: !!opts.danger,
          size: opts.size || 'sm',
        },
        false,
      ),
    [present],
  )

  const alert = useCallback(
    (opts: AlertOptions = {}) =>
      present(
        {
          kind: 'alert',
          title: opts.title || 'Notice',
          message: opts.message || '',
          confirmLabel: opts.confirmLabel || 'OK',
          danger: !!opts.danger,
          size: opts.size || 'sm',
        },
        undefined,
      ),
    [present],
  )

  const choice = useCallback(
    (opts: ChoiceOptions) =>
      present<string | null>(
        {
          kind: 'choice',
          title: opts.title || 'Choose',
          message: opts.message || '',
          confirmLabel: '',
          danger: false,
          size: opts.size || 'sm',
          options: opts.options,
        },
        null,
      ),
    [present],
  )

  const prompt = useCallback(
    (opts: PromptOptions = {}) =>
      present<string | null>(
        {
          kind: 'prompt',
          title: opts.title || 'Enter a value',
          message: opts.message || '',
          confirmLabel: opts.confirmLabel || 'OK',
          cancelLabel: 'Cancel',
          danger: false,
          size: opts.size || 'sm',
          placeholder: opts.placeholder,
          initial: opts.initial,
        },
        null,
      ),
    [present],
  )

  // The prompt's input is uncontrolled (defaultValue + ref): the dialog spec
  // never re-renders per keystroke and the commit reads the live value once.
  const promptInputRef = useRef<HTMLInputElement>(null)
  const settlePrompt = useCallback(() => {
    const v = (promptInputRef.current?.value ?? '').trim()
    settle(v || null)
  }, [settle])

  const api = useMemo<DialogApi>(
    () => ({ confirm, alert, choice, prompt }),
    [confirm, alert, choice, prompt],
  )

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog && (
        <Modal
          labelledBy="dialog-title"
          size={dialog.size}
          onClose={() =>
            settle(
              dialog.kind === 'confirm'
                ? false
                : dialog.kind === 'choice' || dialog.kind === 'prompt'
                  ? null
                  : undefined,
            )
          }
        >
          <div className={styles.dialog}>
            <h3 className={styles.dialogTitle} id="dialog-title">
              {dialog.title}
            </h3>
            {dialog.message && <div className={styles.dialogMessage}>{dialog.message}</div>}
            {dialog.kind === 'prompt' && (
              <input
                ref={promptInputRef}
                className={styles.dialogInput}
                data-testid="dialog-prompt-input"
                defaultValue={dialog.initial}
                placeholder={dialog.placeholder}
                spellCheck={false}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    settlePrompt()
                  }
                }}
              />
            )}
            <div className={styles.dialogActions}>
              {dialog.kind === 'prompt' ? (
                <>
                  <Button variant="ghost" onClick={() => settle(null)}>
                    {dialog.cancelLabel}
                  </Button>
                  <Button variant="primary" onClick={settlePrompt}>
                    {dialog.confirmLabel}
                  </Button>
                </>
              ) : dialog.kind === 'choice' ? (
                dialog.options!.map((opt, i) => (
                  <Button
                    key={opt.value}
                    variant={opt.variant || 'ghost'}
                    onClick={() => settle(opt.value)}
                    autoFocus={i === dialog.options!.length - 1}
                  >
                    {opt.label}
                  </Button>
                ))
              ) : (
                <>
                  {dialog.kind === 'confirm' && (
                    <Button variant="ghost" onClick={() => settle(false)}>
                      {dialog.cancelLabel}
                    </Button>
                  )}
                  <Button
                    variant={dialog.danger ? 'danger' : 'primary'}
                    onClick={() => settle(dialog.kind === 'confirm' ? true : undefined)}
                    autoFocus
                  >
                    {dialog.confirmLabel}
                  </Button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </DialogContext.Provider>
  )
}
