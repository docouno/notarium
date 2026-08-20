import { type FormEvent, type ReactNode, useCallback, useId, useRef } from 'react'
import { Button } from '../Button'
import { useDialog } from '../Dialog'
import { IconX } from '../Icons'
import { Modal, type ModalSize } from '../Modal'
import styles from './FormDialog.module.scss'

type FormDialogProps = {
  title: string
  description?: ReactNode
  children: ReactNode
  dirty: boolean
  busy: boolean
  error?: ReactNode
  submitLabel: string
  busyLabel?: string
  submitDisabled?: boolean
  onSubmit: () => void | Promise<void>
  onClose: () => void
  size?: ModalSize
  testId?: string
  discardTitle?: string
  discardMessage?: ReactNode
}

/** Shared lifecycle shell for substantial forms. Domain fields stay in the
 *  caller; this primitive owns modal layout and every close path. */
export const FormDialog = ({
  title,
  description,
  children,
  dirty,
  busy,
  error,
  submitLabel,
  busyLabel = 'Saving…',
  submitDisabled = false,
  onSubmit,
  onClose,
  size = 'lg',
  testId = 'form-dialog',
  discardTitle = 'Discard changes?',
  discardMessage = 'Your unsaved changes will be lost.',
}: FormDialogProps) => {
  const titleId = useId()
  const { confirm } = useDialog()
  const asking = useRef(false)

  const requestClose = useCallback(async () => {
    if (busy || asking.current) {
      return
    }
    if (dirty) {
      asking.current = true
      const discard = await confirm({
        title: discardTitle,
        message: discardMessage,
        confirmLabel: 'Discard',
        cancelLabel: 'Continue editing',
        danger: true,
      })
      asking.current = false

      if (!discard) {
        return
      }
    }
    onClose()
  }, [busy, confirm, dirty, discardMessage, discardTitle, onClose])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && !submitDisabled) {
      void onSubmit()
    }
  }

  return (
    <Modal
      labelledBy={titleId}
      size={size}
      onClose={busy ? undefined : () => void requestClose()}
      testId={testId}
      overlayTestId={`${testId}-backdrop`}
    >
      <form className={styles.dialog} onSubmit={submit}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <Button
            type="button"
            icon
            variant="ghost"
            aria-label={`Close ${title}`}
            onClick={() => void requestClose()}
            disabled={busy}
          >
            <IconX size={17} />
          </Button>
        </header>
        <div className={styles.body}>
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          {children}
        </div>
        <footer className={styles.actions}>
          <Button type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || submitDisabled}
            data-testid={`${testId}-submit`}
          >
            {busy ? busyLabel : submitLabel}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
