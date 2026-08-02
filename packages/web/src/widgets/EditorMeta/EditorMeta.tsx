import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { slugify } from '@notarium/core/slug'
import { RemovableTagChip } from '../../core/Chips'
import { DatePicker } from '../../core/DatePicker'
import { IconCheck, IconChevron, IconFolder } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import styles from './EditorMeta.module.scss'

// Folder picker: a combobox over the existing folders. Clicking opens a menu of
// every folder (plus the root); typing filters it and also doubles as free entry
// — an unmatched value becomes a brand-new folder on save. The input *is* the
// value (empty string = root), so the parent always has the canonical path.
type FolderComboboxProps = {
  value: string
  folders: string[]
  onChange: (value: string) => void
  disabled?: boolean
}

const FolderCombobox = ({ value, folders, onChange, disabled }: FolderComboboxProps) => {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const q = value.trim().toLowerCase()
  const matches = folders.filter((f) => f.toLowerCase().includes(q))
  const isNew = value.trim() !== '' && !folders.some((f) => f === value.trim())

  const pick = (path: string) => {
    onChange(path)
    setOpen(false)
  }

  return (
    <div className={cx(styles.folderCombo, disabled && styles.isDisabled)} ref={wrap}>
      <span className={styles.folderComboIcon}>
        <IconFolder size={14} />
      </span>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder="Root (no folder)"
        spellCheck={false}
        disabled={disabled}
      />
      {!disabled && (
        <button
          type="button"
          className={styles.folderComboToggle}
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault()
            setOpen((o) => !o)
          }}
          aria-label="Choose folder"
        >
          <IconChevron size={14} />
        </button>
      )}
      {open && !disabled && (
        <div className={styles.comboMenu} role="listbox">
          <button
            type="button"
            className={cx(styles.comboItem, value.trim() === '' && styles.active)}
            onClick={() => pick('')}
          >
            <span className={cx(styles.comboItemLabel, styles.muted)}>Root (no folder)</span>
            {value.trim() === '' && <IconCheck size={13} />}
          </button>
          {matches.map((f) => (
            <button
              type="button"
              key={f}
              className={cx(styles.comboItem, f === value.trim() && styles.active)}
              onClick={() => pick(f)}
            >
              <span className={styles.comboItemLabel}>{f}</span>
              {f === value.trim() && <IconCheck size={13} />}
            </button>
          ))}
          {isNew && (
            <button
              type="button"
              className={cx(styles.comboItem, styles.comboCreate)}
              onClick={() => setOpen(false)}
            >
              <span className={styles.comboItemLabel}>Create folder “{value.trim()}”</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Tag input: chips with a trailing free-text field. Enter or comma commits the
// current text as a chip; Backspace on an empty field removes the last chip;
// each chip's × removes it. Duplicates and blanks are dropped.
type TagInputProps = {
  tags: string[]
  onChange: (tags: string[]) => void
  inputId?: string
}

const TagInput = ({ tags, onChange, inputId }: TagInputProps) => {
  const [text, setText] = useState('')

  const add = (raw: string) => {
    const t = raw.trim().replace(/,$/, '').trim()

    if (!t || tags.includes(t)) {
      setText('')
      return
    }
    onChange([...tags, t])
    setText('')
  }
  const removeAt = (i: number) => onChange(tags.filter((_, idx) => idx !== i))

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && text === '' && tags.length) {
      removeAt(tags.length - 1)
    }
  }

  return (
    <div
      className={styles.tagInput}
      onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
    >
      {tags.map((tg, i) => (
        <RemovableTagChip key={tg} tag={tg} onRemove={() => removeAt(i)} />
      ))}
      <input
        id={inputId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(text)}
        placeholder={tags.length ? 'Add tag…' : 'Add tags…'}
        spellCheck={false}
      />
    </div>
  )
}

// The note's metadata, shown inside the right aside while editing: folder, slug,
// type and tags. Bound to the shared useNoteDraft state so it stays in sync with
// the body (main column) and the Save action (topbar). Declared structurally so
// the widget stays decoupled from the EditingProvider composer above it.
type EditorMetaBinding = {
  title: string
  lockDirectory?: boolean
  slug: string
  setSlug: (value: string) => void
  directory: string
  setDirectory: (value: string) => void
  noteType: string
  setNoteType: (value: string) => void
  tags: string[]
  setTags: (tags: string[]) => void
  /** The editable creation date (#186) as a local `YYYY-MM-DD`; '' when unset. */
  createdDate: string
  setCreatedDate: (value: string) => void
}

export const EditorMeta = ({
  editor,
  folders = [],
}: {
  editor: EditorMetaBinding
  folders?: string[]
}) => {
  // Explicit id so the Tags label associates with the *input*, not the first
  // chip's × button (which a wrapping <label> would target — see below).
  const tagsId = useId()
  return (
    <div className={styles.editorMeta}>
      <label className={styles.metaField}>
        <span className={styles.metaLabel}>Folder</span>
        <FolderCombobox
          value={editor.directory}
          folders={folders}
          onChange={editor.setDirectory}
          disabled={editor.lockDirectory}
        />
      </label>
      <label className={styles.metaField}>
        <span className={styles.metaLabel}>Slug</span>
        <input
          className={styles.metaType}
          value={editor.slug}
          onChange={(e) => editor.setSlug(e.target.value)}
          // The placeholder shows the implicit title-derived slug (#100 phase 1): leave
          // it empty and the note's URL is `/n/<id>/<that>`; type to override.
          placeholder={slugify(editor.title) || 'note-url-slug'}
          spellCheck={false}
        />
      </label>
      <label className={styles.metaField}>
        <span className={styles.metaLabel}>Type</span>
        <input
          className={styles.metaType}
          value={editor.noteType}
          onChange={(e) => editor.setNoteType(e.target.value)}
          spellCheck={false}
        />
      </label>
      {/* Created date (#186): the authored date-as-data axis — correct an imported
          note's historicity so the Feed (Created) files it on the right day. A themed
          calendar-day picker (core/DatePicker); the note stores a full instant (the
          time-of-day stays a backend capability for now). `modified` is not editable. */}
      <div className={styles.metaField}>
        <span className={styles.metaLabel}>Created</span>
        <DatePicker
          value={editor.createdDate}
          onChange={editor.setCreatedDate}
          placeholder="Set creation date"
          aria-label="Creation date"
        />
      </div>
      {/* A wrapping <label> would associate with the first chip's × button, so
          hovering/clicking the label area would highlight/remove the first tag.
          Instead, a plain <div> wrapper + a label tied by htmlFor to the input —
          clicking "Tags" focuses the input (like the other fields), nothing else. */}
      <div className={styles.metaField}>
        <label className={styles.metaLabel} htmlFor={tagsId}>
          Tags
        </label>
        <TagInput tags={editor.tags} onChange={editor.setTags} inputId={tagsId} />
      </div>
    </div>
  )
}
