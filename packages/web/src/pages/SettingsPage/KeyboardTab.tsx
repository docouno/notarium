import { useEffect, useMemo, useState } from 'react'
import { useHotkeys } from '../../composers/HotkeysProvider'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { IconPlus, IconRefresh, IconX } from '../../core/Icons'
import { Select } from '../../core/Select'
import { SettingsSection } from '../../core/SettingsSection'
import {
  ACTION_BY_ID,
  ACTIONS,
  type Binding,
  bindingKey,
  chordFromEvent,
  firesInInput,
  formatChord,
  type HotkeyAction,
  IS_MAC,
  isBrowserReserved,
  PRESETS,
  SECTIONS,
} from '../../libs/hotkeys'
import styles from './KeyboardTab.module.scss'

// Settings → Keyboard (#30): pick a preset and rebind any action — an action can hold
// several bindings (Save = Cmd+Enter AND Cmd+S). Reads/writes the HotkeysProvider — the
// same resolved map the dispatcher, the cheat sheet and the editor keymap consume, so a
// change here is live everywhere at once. localStorage is the store for now (server
// user_preferences sync lands with the rest, #28 step 2).

/** One binding as keycaps (sequence steps joined by a quiet "then") + a remove ×. Flags
 *  a chord the browser reserves (Cmd+W/N/T…) — bound here it won't fire in a tab. */
const KeyChip = ({
  binding,
  onRemove,
  label,
}: {
  binding: Binding
  onRemove: () => void
  label: string
}) => {
  const reserved = isBrowserReserved(binding)
  return (
    <span className={styles.chip}>
      <span className={styles.keys}>
        {binding.map((chord, i) => (
          <span key={i} className={styles.step}>
            {i > 0 && <span className={styles.then}>then</span>}
            <kbd className={styles.kbd}>{formatChord(chord, IS_MAC)}</kbd>
          </span>
        ))}
      </span>
      {reserved && (
        <span
          className={styles.reserved}
          title="Your browser reserves this — it may not fire in a tab"
          aria-label="May be intercepted by your browser"
        >
          ⚠
        </span>
      )}
      <button
        type="button"
        className={styles.chipRemove}
        title="Remove"
        aria-label={`Remove this shortcut for ${label}`}
        onClick={onRemove}
      >
        <IconX size={11} />
      </button>
    </span>
  )
}

/** The "add a shortcut" control: click to record the next keystroke (appended). While
 *  recording, the dispatcher stands down (setRecording) so the captured key doesn't also
 *  fire. Single-chord capture; sequences come from presets. Editor/editing actions
 *  REQUIRE a modifier — a bare key there would block typing / fire on every keystroke.
 *  `recording` is CONTROLLED by the parent so only ONE recorder is armed at a time (two
 *  open listeners would capture one press into both rows). */
const AddRecorder = ({
  onCapture,
  label,
  requireModifier,
  recording,
  onToggle,
  onFinish,
}: {
  onCapture: (b: Binding) => void
  label: string
  requireModifier: boolean
  recording: boolean
  onToggle: () => void
  onFinish: () => void
}) => {
  const { setRecording } = useHotkeys()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) {
      return
    }
    setRecording(true)
    setError(null) // fresh arm — never show a stale error from a prior attempt
    const finish = () => {
      setError(null)
      onFinish()
    }

    const onKey = (e: KeyboardEvent) => {
      // Tab cancels (and is allowed to move focus) so a keyboard user is never trapped.
      if (e.key === 'Tab') {
        finish()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        finish()
        return
      }
      const chord = chordFromEvent(e)

      if (!chord) {
        return
      } // bare modifier — keep waiting for the real key
      if (requireModifier && !firesInInput(chord)) {
        setError('Needs a Cmd/Ctrl/Alt modifier here') // stay armed for another try
        return
      }
      onCapture([chord])
      finish()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      setRecording(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, requireModifier])

  return (
    <button
      type="button"
      className={styles.add}
      data-recording={recording || undefined}
      aria-pressed={recording}
      aria-label={
        recording
          ? `Recording a shortcut for ${label} — press a key, Escape to cancel`
          : `Add a shortcut for ${label}`
      }
      onClick={onToggle}
    >
      {recording ? (
        <span className={error ? styles.recordingError : styles.recordingHint} role="status">
          {error ?? 'Press a key… (Esc)'}
        </span>
      ) : (
        <IconPlus size={13} />
      )}
    </button>
  )
}

const ActionRow = ({
  action,
  conflictWith,
  recording,
  onToggleRecord,
  onFinishRecord,
}: {
  action: HotkeyAction
  conflictWith?: string[]
  recording: boolean
  onToggleRecord: () => void
  onFinishRecord: () => void
}) => {
  const { resolved, overrides, setActionBindings, resetBinding } = useHotkeys()
  const bindings = resolved.byAction[action.id] ?? []
  const overridden = Object.prototype.hasOwnProperty.call(overrides, action.id)
  // Editor formatting + while-editing actions must carry a modifier (a bare key would
  // break typing in the editor / fire on every keystroke).
  const requireModifier = action.context === 'editor' || action.context === 'editing'

  const remove = (i: number) =>
    setActionBindings(
      action.id,
      bindings.filter((_, j) => j !== i),
    )

  const add = (b: Binding) => {
    if (bindings.some((x) => bindingKey(x) === bindingKey(b))) {
      return
    } // already bound — no dup
    setActionBindings(action.id, [...bindings, b])
  }

  return (
    <div className={styles.row} data-testid={`hotkey-row-${action.id}`}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{action.label}</span>
        {action.hint && <span className={styles.rowHint}>{action.hint}</span>}
        {conflictWith && conflictWith.length > 0 && (
          <span className={styles.conflict}>Conflicts with {conflictWith.join(', ')}</span>
        )}
      </div>
      <div className={styles.rowControls}>
        {/* Chips + the "+" wrap as ONE group right-aligned to the "+" column, so extra
            bindings climb upward without ever sitting right of the "+". The reset sits
            OUTSIDE this group (it's a per-row meta action, not a binding). */}
        <div className={styles.bindings}>
          {bindings.length === 0 && <span className={styles.unbound}>Not set</span>}
          {bindings.map((b, i) => (
            <KeyChip key={i} binding={b} label={action.label} onRemove={() => remove(i)} />
          ))}
          <AddRecorder
            onCapture={add}
            label={action.label}
            requireModifier={requireModifier}
            recording={recording}
            onToggle={onToggleRecord}
            onFinish={onFinishRecord}
          />
        </div>
        {/* Reset to the preset default — only when this action has an override. */}
        <button
          type="button"
          className={styles.iconBtn}
          title="Reset to default"
          aria-label={`Reset ${action.label}`}
          disabled={!overridden}
          onClick={() => resetBinding(action.id)}
        >
          <IconRefresh size={13} />
        </button>
      </div>
    </div>
  )
}

export const KeyboardTab = () => {
  const { presetId, setPreset, overrides, resetAll, resolved } = useHotkeys()
  const { confirm } = useDialog()
  // The single armed recorder (one at a time — two open keydown listeners would capture
  // one press into both rows). Holds the action id whose "+" is recording, or null.
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const presetOptions = useMemo(() => PRESETS.map((p) => ({ value: p.id, label: p.label })), [])
  const activePreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]
  const overrideCount = Object.keys(overrides).length

  // actionId → labels of the OTHER actions it clashes with (same-context), so the row
  // can name the conflict ("Conflicts with Edit note") instead of a vague warning. Deduped
  // (two shared bindings between the same pair yield two conflict entries).
  const conflictWith = useMemo(() => {
    const m = new Map<string, string[]>()

    for (const c of resolved.conflicts) {
      for (const id of c.actionIds) {
        const others = c.actionIds
          .filter((x) => x !== id)
          .map((x) => ACTION_BY_ID[x]?.label)
          .filter(Boolean) as string[]

        if (!others.length) {
          continue
        }
        m.set(id, [...new Set([...(m.get(id) ?? []), ...others])])
      }
    }

    return m
  }, [resolved.conflicts])

  const onResetAll = async () => {
    if (overrideCount === 0) {
      return
    }
    const ok = await confirm({
      title: 'Reset all shortcuts?',
      message: `This clears your ${overrideCount} custom binding${overrideCount === 1 ? '' : 's'} and returns to the “${activePreset.label}” preset defaults.`,
      confirmLabel: 'Reset',
      danger: true,
    })

    if (ok) {
      resetAll()
    }
  }

  return (
    <>
      <SettingsSection
        title="Keyboard layout"
        description={activePreset.blurb}
        action={
          <Select
            aria-label="Keyboard preset"
            data-testid="hotkey-preset-select"
            value={presetId}
            onChange={setPreset}
            options={presetOptions}
          />
        }
      >
        <div className={styles.presetFoot}>
          <span className={styles.overrideNote}>
            {overrideCount === 0
              ? 'Using preset defaults.'
              : `${overrideCount} custom binding${overrideCount === 1 ? '' : 's'} on top of the preset.`}
          </span>
          <Button variant="ghost" onClick={() => void onResetAll()} disabled={overrideCount === 0}>
            Reset all
          </Button>
        </div>
      </SettingsSection>

      {SECTIONS.map((section) => {
        const rows = ACTIONS.filter((a) => a.section === section.id)

        if (!rows.length) {
          return null
        }

        return (
          <SettingsSection
            key={section.id}
            title={section.label}
            testId={`hotkey-section-${section.id}`}
          >
            <div className={styles.list}>
              {rows.map((a) => (
                <ActionRow
                  key={a.id}
                  action={a}
                  conflictWith={conflictWith.get(a.id)}
                  recording={recordingId === a.id}
                  onToggleRecord={() => setRecordingId((r) => (r === a.id ? null : a.id))}
                  onFinishRecord={() => setRecordingId(null)}
                />
              ))}
            </div>
          </SettingsSection>
        )
      })}
    </>
  )
}
