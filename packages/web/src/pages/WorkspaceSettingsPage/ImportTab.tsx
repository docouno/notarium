import { useRef, useState } from 'react'

import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { SettingsSection } from '../../core/SettingsSection'
import { Switch } from '../../core/Switch'
import { useImportJob } from './useImportJob'
import styles from './ImportTab.module.scss'

type MemoryMode = 'skip' | 'folder' | 'space'

const MEMORY_DESC: Record<MemoryMode, string> = {
  skip: 'Memory entities (memory.json) are not imported.',
  folder: 'Memory entities become visible notes under a memory/ folder.',
  space:
    "Memory entities go to this space's agent memory — hidden from the tree, reachable by agents via recall.",
}

// Import (#11, #191): upload a Claude / ChatGPT / MCP-memory export and convert it
// to notes (the inverse of Export). The user drops the file they downloaded — a .zip
// archive (Claude/ChatGPT ship one) or a bare .json/.jsonl (memory.json); the format
// is auto-detected server-side, streamed and parsed in bounded memory so even a
// multi-hundred-MB export imports. Since #191 the import is a DURABLE JOB by default
// (when the host backs jobs): enqueue → a background worker writes the notes off the
// request lifecycle → a live progress bar (SSE + poll) with phase + a written count →
// a summary. Leave the tab, drop the connection, restart the server — the import lives
// on, and coming back re-adopts it. A none-mode host falls back to the synchronous
// streaming import, driven into the same UI. Each control is its own SettingsSection so
// the tab reads with the same title+description rhythm as the rest of Settings.
export const ImportTab = () => {
  const { space, canWrite } = useSpace()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [skipExisting, setSkipExisting] = useState(false)
  const [memory, setMemory] = useState<MemoryMode>('skip')
  const { job, error, busy, summary, start, cancel, reset } = useImportJob(space)

  const onImport = () => {
    if (!file || busy) {
      return
    }
    void start(file, { skipExisting, memory })
  }

  // Choose a fresh file → clear a prior run's summary/error (never mid-import, the
  // picker is disabled while busy).
  const onChoose = (f: File | null) => {
    reset()
    setFile(f)
    // Clear the native input's value so re-picking the SAME file later still fires
    // onChange (the browser suppresses change when the value is unchanged) — otherwise
    // "Import another" → pick the identical export leaves Import stuck disabled.
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  const importAnother = () => {
    reset()
    setFile(null)
  }

  // Import writes to the space — a reader (#111) can't, and the tab is hidden for
  // them; this guards a direct deep-link to /management/import so they see an honest
  // notice instead of a form whose upload the server would reject.
  if (!canWrite) {
    return (
      <SettingsSection
        title="Import"
        description="Bring an existing knowledge base in."
        testId="import-section"
      >
        <Notice variant="info">
          You have read-only access to this space, so importing isn’t available.
        </Notice>
      </SettingsSection>
    )
  }

  const done = job?.progress.done ?? 0
  // No job yet ⇒ the upload is still streaming; pending ⇒ queued; else writing.
  const phaseLabel = !job ? 'Uploading…' : job.status === 'pending' ? 'Queued…' : 'Importing…'

  return (
    <>
      <SettingsSection
        title="Import"
        description="Bring an existing knowledge base in. Upload a Claude or ChatGPT data export (the .zip you downloaded, or its conversations.json), or an MCP memory.json — each conversation or entity becomes a note. Large imports run in the background — you can leave this tab and come back."
        testId="import-section"
      >
        <div className={styles.picker}>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.json,.jsonl,application/zip,application/json"
            className={styles.fileInput}
            data-testid="import-file"
            onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
          />
          <Button
            className={styles.choose}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            data-testid="import-choose"
          >
            Choose file…
          </Button>
          <span className={styles.filename} title={file?.name}>
            {file ? file.name : 'No file selected'}
          </span>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Skip existing notes"
        description="On re-import, skip notes that already exist instead of overwriting them — useful when topping up an updated history."
        htmlFor="import-skip"
        action={
          <Switch
            id="import-skip"
            checked={skipExisting}
            onChange={setSkipExisting}
            disabled={busy}
            data-testid="import-skip"
          />
        }
      />

      <SettingsSection
        title="Memory entries"
        description={MEMORY_DESC[memory]}
        action={
          <Segmented<MemoryMode>
            value={memory}
            onChange={setMemory}
            disabled={busy}
            ariaLabel="Memory destination"
            options={[
              { value: 'skip', label: "Don't import" },
              { value: 'folder', label: 'Into folder' },
              { value: 'space', label: 'Space memory' },
            ]}
          />
        }
      />

      <div className={styles.footer}>
        {busy && (
          <div className={styles.progress} data-testid="import-progress">
            <div className={styles.bar}>
              {/* A ZIP's note count is unknown upfront, so the bar is always
                  indeterminate — the honest signal is the live written count + phase. */}
              <div className={styles.fill} data-indeterminate="true" />
            </div>
            <div className={styles.status}>
              <span>
                {phaseLabel}
                {done > 0 ? ` ${done} imported` : ''}
              </span>
              <Button variant="ghost" onClick={cancel} data-testid="import-cancel">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && !busy && (
          <Notice variant="error" className={styles.result} data-testid="import-error">
            {error}
          </Notice>
        )}

        {summary && !busy && (
          <Notice variant={summary.failed > 0 ? 'warning' : 'success'} className={styles.result}>
            <div data-testid="import-summary">
              Imported <strong>{summary.imported}</strong> note{summary.imported === 1 ? '' : 's'}
              {summary.skipped > 0 ? `, ${summary.skipped} skipped` : ''}
              {summary.failed > 0 ? `, ${summary.failed} failed` : ''}.
            </div>
            {summary.files.map((f) => (
              <div key={f.file} className={styles.fileLine}>
                {f.file} → {f.format} ({f.imported}
                {f.skipped > 0 ? `, ${f.skipped} skipped` : ''})
                {f.warnings.map((w, i) => (
                  <div key={i} className={styles.warning}>
                    {w}
                  </div>
                ))}
              </div>
            ))}
          </Notice>
        )}

        <div className={styles.actions}>
          {summary && !busy ? (
            <Button variant="primary" onClick={importAnother} data-testid="import-again">
              Import another
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={onImport}
              disabled={!file || busy}
              data-testid="import-run"
            >
              {busy ? phaseLabel : 'Import'}
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
