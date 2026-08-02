import { useEffect, useRef } from 'react'
import styles from './Sidebar.module.scss'

// Inline rename field (VS Code-style): autofocuses and selects, commits on Enter
// or blur, cancels on Escape. A `done` latch prevents the Enter→blur sequence
// from firing the commit twice. Stops click/drag so editing doesn't open or drag
// the row underneath it.
export const RenameInput = ({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) => {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current

    if (el) {
      el.focus()
      el.select()
    }
  }, [])
  const commit = () => {
    if (done.current) {
      return
    }
    done.current = true
    onCommit(ref.current?.value ?? '')
  }

  const cancel = () => {
    if (done.current) {
      return
    }
    done.current = true
    onCancel()
  }

  return (
    <input
      ref={ref}
      className={styles.renameInput}
      data-testid="rename-input"
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
    />
  )
}
