import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import type { AgentTelemetryConfig } from '@notarium/contract'
import { AUTH_MODE } from '@notarium/contract/enums'
import { useAuth } from '../../composers/AuthProvider'
import { Button } from '../../core/Button'
import { Notice } from '../../core/Notice'
import { Select } from '../../core/Select'
import { SettingsSection } from '../../core/SettingsSection'
import { Switch } from '../../core/Switch'
import { settingsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import styles from './TelemetryTab.module.scss'

const COMPACT_OPTIONS = [30, 90, 180, 365] as const
const DETAILED_OPTIONS = [7, 30, 90] as const

export const TelemetryTab = () => {
  const { me, mode } = useAuth()
  const canManage = mode === AUTH_MODE.none || me?.admin === true
  const [config, setConfig] = useState<AgentTelemetryConfig | null>(null)
  const [draft, setDraft] = useState<AgentTelemetryConfig | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!canManage) {
      return
    }
    void api
      .agentTelemetryConfigGet()
      .then((next) => {
        setConfig(next)
        setDraft(next)
      })
      .catch(() => setFailed(true))
  }, [canManage])

  if (!canManage) {
    return <Navigate to={settingsRoute()} replace />
  }
  const changed =
    config != null &&
    draft != null &&
    (config.detailedEnabled !== draft.detailedEnabled ||
      config.compactRetentionDays !== draft.compactRetentionDays ||
      config.detailedRetentionDays !== draft.detailedRetentionDays)

  const save = async () => {
    if (!config || !draft || !changed) {
      return
    }
    setSaving(true)
    setFailed(false)
    try {
      const next = await api.agentTelemetryConfigPatch({
        versionToken: config.versionToken,
        detailedEnabled: draft.detailedEnabled,
        compactRetentionDays: draft.compactRetentionDays,
        detailedRetentionDays: draft.detailedRetentionDays,
      })
      setConfig(next)
      setDraft(next)
    } catch {
      setFailed(true)
      try {
        const current = await api.agentTelemetryConfigGet()
        setConfig(current)
        setDraft(current)
      } catch {
        // Keep the first actionable failure visible.
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.page}>
      {failed && (
        <Notice variant="error">
          Telemetry settings changed or could not be saved. Reloaded values are shown when
          available.
        </Notice>
      )}
      <SettingsSection
        title="Detailed agent telemetry"
        description="Optional diagnostic detail for newly admitted agent calls. Compact trace remains available when this is off."
        action={
          <Switch
            checked={draft?.detailedEnabled ?? false}
            disabled={!draft}
            onChange={(checked) =>
              setDraft((current) => (current ? { ...current, detailedEnabled: checked } : current))
            }
            label="Detailed agent telemetry"
            data-testid="agent-telemetry-detailed"
          />
        }
        testId="agent-telemetry-settings"
      >
        <p className={styles.cost}>
          When enabled, eligible calls write an additional allowlisted detail row to the meta-DB.
          This increases database storage, backup size and write I/O in proportion to call volume
          and the selected retention period. Busy installations may see additional database load. It
          does not make extra model or API calls and does not add token charges.
        </p>
        <div className={styles.controls}>
          <label>
            <span>Compact retention</span>
            <Select
              aria-label="Compact trace retention"
              value={draft ? String(draft.compactRetentionDays) : undefined}
              disabled={!draft}
              options={COMPACT_OPTIONS.map((days) => ({
                value: String(days),
                label: `${days} days`,
              }))}
              onChange={(value) => {
                const compactRetentionDays = Number(
                  value,
                ) as AgentTelemetryConfig['compactRetentionDays']
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        compactRetentionDays,
                        detailedRetentionDays:
                          current.detailedRetentionDays > compactRetentionDays
                            ? compactRetentionDays === 30
                              ? 30
                              : 90
                            : current.detailedRetentionDays,
                      }
                    : current,
                )
              }}
            />
          </label>
          <label>
            <span>Detailed retention</span>
            <Select
              aria-label="Detailed trace retention"
              value={draft ? String(draft.detailedRetentionDays) : undefined}
              disabled={!draft}
              options={DETAILED_OPTIONS.filter(
                (days) => !draft || days <= draft.compactRetentionDays,
              ).map((days) => ({ value: String(days), label: `${days} days` }))}
              onChange={(value) =>
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        detailedRetentionDays: Number(
                          value,
                        ) as AgentTelemetryConfig['detailedRetentionDays'],
                      }
                    : current,
                )
              }
            />
          </label>
        </div>
        <p className={styles.disclosure}>
          Compact always stores tool, outcome, timing, argument shape and bounded retrieval queries
          with up to five hit titles. Detailed adds allowlisted selectors and summaries, retained
          for the period above. Note bodies, edit content, memory observations, ability
          instructions, full recall context, credentials, version tokens and idempotency keys are
          never stored.
        </p>
        <div className={styles.actions}>
          <Button variant="primary" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save telemetry settings'}
          </Button>
        </div>
      </SettingsSection>
    </div>
  )
}
