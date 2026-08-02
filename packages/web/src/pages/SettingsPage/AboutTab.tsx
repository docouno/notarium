import { type ReactNode, useEffect, useState } from 'react'
import type { HostAboutResponse } from '@notarium/contract'
import { usePwa } from '../../composers/PwaProvider'
import { Button } from '../../core/Button'
import { IconCheck } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { SettingsSection } from '../../core/SettingsSection'
import { SkeletonText } from '../../core/Skeleton'
import { buildInfo } from '../../libs/buildInfo'
import { exactDateTime } from '../../libs/datetime'
import { errorText } from '../../libs/errors'
import { api } from '../../services/api'
import styles from './AboutTab.module.scss'

// About / Version: what this install IS — product version, how search is
// configured, and (for admins) the deployment shape. The SPA's own build is a
// bundle constant shown immediately; the server's view is fetched. Comparing the
// two surfaces a stale cached bundle against a newer server. Runtime + embedder
// model + deployment ride the admin block server-side (leak cut), so a
// non-admin simply never receives them. General info lives in the first tab group
// so it's visible to everyone, including a mode-'none' single-principal host.

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className={styles.term}>{label}</dt>
    <dd className={styles.val}>{children}</dd>
  </>
)

/** `version (sha)`, sha dimmed; sha omitted when unknown (a dev build). */
const buildLabel = (b: { version: string; commit: string | null }): ReactNode => (
  <>
    {b.version}
    {b.commit && <span className={styles.dim}> ({b.commit})</span>}
  </>
)

/** The source link reads as coordinates, not as a 70-character URL: the scheme is
 *  noise and the full revision wraps onto a second line. The href stays exact —
 *  this only shortens what is printed. */
const sourceLabel = (source: string): string => {
  try {
    const url = new URL(source)
    return `${url.host}${url.pathname.replace(/([0-9a-f]{7})[0-9a-f]+$/i, '$1')}`
  } catch {
    return source
  }
}

const fmtUptime = (s: number): string => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts: string[] = []

  if (d) {
    parts.push(`${d}d`)
  }
  if (h) {
    parts.push(`${h}h`)
  }
  if (m || !parts.length) {
    parts.push(`${m}m`)
  }

  return parts.join(' ')
}

// Install / app shell: the single home for "Install app", the installed
// indicator and the update affordance. Lives on the About tab — it's about what
// this install IS. The whole block is driven by PwaProvider; the section always
// renders (discoverable) with an honest state for browsers that can't install.
const InstallSection = () => {
  const { canInstall, promptInstall, installed, iosHint, updateReady, updateNow } = usePwa()
  return (
    <SettingsSection
      title="Install"
      description="Install Notarium as an app for a dedicated window and quick launch. It still talks to this same server — your notes stay where they are."
      testId="about-install"
    >
      <div className={styles.install}>
        {installed ? (
          <p className={styles.installStatus} data-testid="install-status">
            <IconCheck size={16} /> Installed — you’re running Notarium as an app.
          </p>
        ) : canInstall ? (
          <Button
            variant="primary"
            onClick={() => void promptInstall()}
            data-testid="install-button"
          >
            Install app
          </Button>
        ) : iosHint ? (
          <p className={styles.blurb} data-testid="install-ios">
            On iPhone or iPad: open the Share menu in Safari and choose “Add to Home Screen”.
          </p>
        ) : (
          <p className={styles.blurb} data-testid="install-unavailable">
            Look for an install icon in your browser’s address bar or menu. If it’s missing, this
            browser doesn’t support installing web apps.
          </p>
        )}
        {updateReady && (
          <Button variant="ghost" onClick={updateNow} data-testid="install-update">
            Reload to update
          </Button>
        )}
      </div>
    </SettingsSection>
  )
}

export const AboutTab = () => {
  const [about, setAbout] = useState<HostAboutResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()

    void (async () => {
      try {
        setAbout(await api.aboutGet(ctrl.signal))
      } catch (e) {
        // A unmount-abort is expected, not an error to surface.
        if (e instanceof DOMException && e.name === 'AbortError') {
          return
        }
        setError(errorText(e))
      } finally {
        setLoaded(true)
      }
    })()

    return () => ctrl.abort()
  }, [])

  // Server-side value, or a skeleton until the fetch lands / a dash if it failed.
  const server = (node: ReactNode): ReactNode =>
    about ? node : loaded ? <span className={styles.dim}>—</span> : <SkeletonText lines={1} />

  return (
    <>
      {error && (
        <Notice variant="error" data-testid="about-error">
          {error}
        </Notice>
      )}

      <InstallSection />

      <SettingsSection
        title="Version"
        description="What you're running. The app (this page) and the server should match; a gap means a cached bundle is stale."
        testId="about-version"
      >
        <dl className={styles.grid}>
          <Row label="App (this page)">{buildLabel(buildInfo)}</Row>
          <Row label="Server">{server(about ? buildLabel(about.build) : null)}</Row>
          <Row label="Built">
            {server(
              about ? (
                about.build.builtAt ? (
                  exactDateTime(about.build.builtAt)
                ) : (
                  <span className={styles.dim}>dev</span>
                )
              ) : null,
            )}
          </Row>
          {/* Released images carry a link to the exact revision they were built from —
              the running instance's own path to its source, which AGPL-3.0
              asks us to offer. A local build has none and the row stays away rather
              than pointing somewhere plausible. canon: docs/release.md#identity */}
          {about?.build.source && (
            <Row label="Source">
              <a
                className={styles.link}
                href={about.build.source}
                target="_blank"
                rel="noreferrer"
                data-testid="about-source"
              >
                {sourceLabel(about.build.source)}
              </a>
            </Row>
          )}
        </dl>
      </SettingsSection>

      <SettingsSection
        title="Search & AI"
        description="How retrieval is configured on this host. Hybrid fuses full-text and vector search."
        testId="about-search"
      >
        {about ? (
          <dl className={styles.grid}>
            <Row label="Mode">
              {about.search.mode === 'hybrid' ? 'Hybrid — full-text + vector' : 'Full-text only'}
            </Row>
            <Row label="Graph boost">{about.search.graphBoost ? 'On' : 'Off'}</Row>
          </dl>
        ) : loaded ? (
          <span className={styles.dim}>Unavailable</span>
        ) : (
          <SkeletonText lines={2} />
        )}
      </SettingsSection>

      {about?.admin && (
        <SettingsSection
          title="Deployment"
          description="Operational details — visible to admins only."
          testId="about-deployment"
        >
          <dl className={styles.grid}>
            <Row label="Runtime">
              {`Node ${about.admin.runtime.node} · ${about.admin.runtime.platform}/${about.admin.runtime.arch}`}
            </Row>
            {about.admin.embedder && (
              <Row label="Embedder">
                {about.admin.embedder.id}
                <span className={styles.dim}> · {about.admin.embedder.dimensions}d</span>
              </Row>
            )}
            <Row label="Auth mode">{about.admin.authMode}</Row>
            <Row label="Space creation">{about.admin.spaceCreate ? 'Enabled' : 'Disabled'}</Row>
            <Row label="Metadata DB">{about.admin.metaDb}</Row>
            <Row label="Uptime">{fmtUptime(about.admin.uptimeSeconds)}</Row>
            <Row label="Spaces">
              {about.admin.spaces.length
                ? about.admin.spaces.map((s) => `${s.slug} (${s.engine})`).join(', ')
                : '—'}
            </Row>
          </dl>
        </SettingsSection>
      )}

      <SettingsSection title="About" testId="about-product">
        <p className={styles.blurb}>
          Notarium — a self-hosted, AI-agent-native knowledge base. Free and open source under the
          GNU AGPL-3.0 license — run it yourself, own your notes, no lock-in. A commercial license
          is available for productizing it (reselling, hosting as a service, or embedding).
        </p>
      </SettingsSection>
    </>
  )
}
