import { useEffect, useRef, useState } from 'react'

import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { Notice } from '../../core/Notice'
import { SettingsSection } from '../../core/SettingsSection'
import { Switch } from '../../core/Switch'
import { triggerDownload } from '../../libs/download'
import { api } from '../../services/api'
import { useExportJob } from './useExportJob'
import styles from './ExportTab.module.scss'

// Export section (#17, #105): download the whole active space as a ZIP of markdown
// files, the folder structure preserved. Since #105 the export is ASYNC by default
// when the host backs durable jobs: enqueue → a background worker builds the archive
// off the request lifecycle → a progress bar (SSE + poll) → the finished file with
// resume support. A disconnect / closed tab / restart no longer means re-downloading
// from scratch. On a host WITHOUT durable jobs (no meta-DB) the enqueue 404s and we
// fall back to the original synchronous streaming download (a plain anchor GET).

const fmtBytes = (n: number | null): string => {
  if (n == null) {
    return ''
  }
  if (n < 1024) {
    return `${n} B`
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const ExportTab = () => {
  const { space } = useSpace()
  const [keepFrontmatter, setKeepFrontmatter] = useState(true)
  const [includeMemory, setIncludeMemory] = useState(false)
  const { job, error, busy, start, cancel, reset } = useExportJob(space)
  // Auto-download once when the artifact becomes ready (the expected end of the
  // flow); a manual "Download again" stays available afterwards. `sawBusy` gates it to
  // a job we actually watched go busy→ready IN THIS SESSION, so a reconnect that finds
  // an already-finished export shows the Download button without re-downloading on load.
  const downloadedFor = useRef<string | null>(null)
  const sawBusy = useRef(false)

  const opts = {
    frontmatter: keepFrontmatter ? ('keep' as const) : ('strip' as const),
    scope: includeMemory ? ('all' as const) : ('user' as const),
  }

  const onExport = async () => {
    downloadedFor.current = null
    const { fallback } = await start(opts)

    // No durable jobs on this host → the synchronous streaming download (#17).
    if (fallback) {
      triggerDownload(api.exportUrl(space, opts))
    }
  }

  // ExportTab is not remounted on a :space param change (React Router keeps the element),
  // so clear the per-session auto-download gate when the space switches — otherwise a
  // reconnect that finds a finished export in the NEW space would be treated as one this
  // session watched go busy→ready and auto-download it.
  useEffect(() => {
    sawBusy.current = false
    downloadedFor.current = null
  }, [space])

  const ready = job?.status === 'succeeded' && job.artifact
  useEffect(() => {
    if (busy) {
      sawBusy.current = true
      return
    }
    // Only auto-download a job we watched run in this session (not one resumed already
    // finished on mount) — and only once per job id.
    if (ready && job && sawBusy.current && downloadedFor.current !== job.id) {
      downloadedFor.current = job.id
      sawBusy.current = false
      triggerDownload(api.jobDownloadUrl(space, job.id))
    }
  }, [ready, job, busy, space])

  const ratio = job?.progress.ratio
  const pct = ratio != null ? Math.round(ratio * 100) : null

  return (
    <>
      <SettingsSection
        title="Export"
        description="Download every note in this space as a ZIP of markdown files, with the folder structure preserved. Large bases are prepared in the background — you can leave this tab and come back."
        testId="export-section"
      />

      <SettingsSection
        title="Include frontmatter"
        description="Keep each note's YAML metadata block (notarium-id, tags) so the export stays importable. Off strips it for a clean reading copy."
        htmlFor="export-frontmatter"
        action={
          <Switch
            id="export-frontmatter"
            checked={keepFrontmatter}
            onChange={setKeepFrontmatter}
            disabled={busy}
            data-testid="export-frontmatter"
          />
        }
      />

      <SettingsSection
        title="Include agent memory"
        description="Add this space's private agent memory for a full backup. Off exports only your notes."
        htmlFor="export-include-memory"
        action={
          <Switch
            id="export-include-memory"
            checked={includeMemory}
            onChange={setIncludeMemory}
            disabled={busy}
            data-testid="export-include-memory"
          />
        }
      />

      <div className={styles.footer}>
        {busy && (
          <div className={styles.progress} data-testid="export-progress">
            <div className={styles.bar}>
              <div
                className={styles.fill}
                // Indeterminate (no total yet) → a modest sliver; otherwise the %.
                style={{ width: pct != null ? `${pct}%` : '15%' }}
                data-indeterminate={pct == null ? 'true' : undefined}
              />
            </div>
            <div className={styles.status}>
              <span>
                {job?.progress.phase === 'archiving' || job?.status === 'running'
                  ? 'Preparing archive…'
                  : 'Queued…'}
                {job && job.progress.total != null
                  ? ` ${job.progress.done}/${job.progress.total}`
                  : ''}
              </span>
              <Button variant="ghost" onClick={cancel} data-testid="export-cancel">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && !busy && (
          <Notice variant="error" data-testid="export-error">
            {error}
          </Notice>
        )}

        {ready && job && (
          <Notice variant="success" data-testid="export-ready">
            Archive ready{job.artifact?.bytes != null ? ` — ${fmtBytes(job.artifact.bytes)}` : ''}.
            Your download should start automatically.
          </Notice>
        )}

        <div className={styles.actions}>
          {ready && job ? (
            <>
              <Button variant="ghost" onClick={() => reset()} data-testid="export-again">
                Export again
              </Button>
              <Button
                variant="primary"
                onClick={() => triggerDownload(api.jobDownloadUrl(space, job.id))}
                data-testid="export-download"
              >
                Download .zip
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={onExport}
              disabled={busy}
              data-testid="export-download"
            >
              {busy ? 'Preparing…' : 'Download .zip'}
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
