import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentRoleDetailQuery,
  AgentRoleDetailResponse,
  MeAgentRolesResponse,
  RoleInventoryEntry,
  RoleSummary,
} from '@notarium/contract'
import { Button } from '../../core/Button'
import { EmptyState } from '../../core/EmptyState'
import { IconBot, IconPlus, IconSparkles, IconX } from '../../core/Icons'
import { Modal } from '../../core/Modal'
import { Notice } from '../../core/Notice'
import { SkeletonText } from '../../core/Skeleton'
import { StateView } from '../../core/StateView'
import { useToast } from '../../core/Toast'
import { SettingsLayout } from '../../layouts/SettingsLayout'
import { errorText } from '../../libs/errors'
import { renderMarkdown } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import { api } from '../../services/api'
import { useAgentsSummary } from './AgentsProvider'
import { AgentsTabs } from './AgentsTabs'
import styles from './RolesPage.module.scss'

type AddTarget = 'personal' | 'project'
type ProjectSummary = MeAgentRolesResponse['projects'][number]
type DetailTarget = { role: RoleSummary | RoleInventoryEntry; query: AgentRoleDetailQuery }

const scopeLabel = (role: RoleInventoryEntry): string => {
  if (role.scope === 'project') {
    return `Project · ${role.project}`
  }
  if (role.scope === 'space') {
    return `Space · ${role.space}`
  }

  return 'Personal'
}

const roleKey = (role: RoleInventoryEntry): string =>
  role.scope === 'personal'
    ? `personal:${role.name}`
    : `${role.scope}:${role.space}:${role.scope === 'project' ? role.project : ''}:${role.name}`

const RoleCard = ({ role, onView }: { role: RoleInventoryEntry; onView: () => void }) => (
  <article className={styles.roleCard} data-testid={`owned-role-${roleKey(role)}`}>
    <div className={styles.cardTop}>
      <div>
        <h3 className={styles.cardTitle}>{role.name}</h3>
        <p className={styles.cardDescription}>{role.description}</p>
      </div>
    </div>
    <div className={styles.cardBottom}>
      <div className={styles.cardMeta}>
        <span className={styles.scopeBadge}>{scopeLabel(role)}</span>
        {role.origin?.startsWith('builtin:') && <span>Forked from built-in catalog</span>}
      </div>
      <Button
        onClick={onView}
        aria-label={`View ${role.name} role in ${scopeLabel(role)}`}
        data-testid={`role-view-${roleKey(role)}`}
      >
        View
      </Button>
    </div>
  </article>
)

const RoleMarkdown = ({
  source,
  headingOffset,
  idPrefix,
}: {
  source: string
  headingOffset: number
  idPrefix: string
}) => {
  const html = useMemo(
    () => renderMarkdown(source, { headingOffset, idPrefix }),
    [headingOffset, idPrefix, source],
  )
  const ref = useRef<HTMLDivElement>(null)
  useMarkdownEnhance(ref, html)

  useEffect(() => {
    ref.current?.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
      if (!(anchor.getAttribute('href') ?? '').startsWith('#')) {
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
      }
    })
  }, [html])

  return (
    <div
      ref={ref}
      className={`markdown ${styles.instructions}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

const RoleDetailDialog = ({
  target,
  onClose,
  onAdd,
}: {
  target: DetailTarget
  onClose: () => void
  onAdd?: () => void
}) => {
  const [detail, setDetail] = useState<AgentRoleDetailResponse | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setDetail(null)
    setFailed(null)
    void api
      .agentRoleDetail(target.role.name, target.query)
      .then((next) => {
        if (live) {
          setDetail(next)
        }
      })
      .catch((error) => {
        if (live) {
          setFailed(errorText(error))
        }
      })
    return () => {
      live = false
    }
  }, [target])

  const location =
    target.query.scope === 'catalog'
      ? 'Built-in catalog'
      : target.query.scope === 'personal'
        ? 'Personal'
        : target.query.scope === 'space'
          ? target.query.space
          : target.query.project

  return (
    <Modal onClose={onClose} labelledBy="role-detail-title" size="lg">
      <div className={styles.detailDialog} data-testid={`role-detail-${target.role.name}`}>
        <header className={styles.detailHead}>
          <div className={styles.detailTitleBlock}>
            <div className={styles.detailEyebrow}>
              <span className={styles.scopeBadge}>{location}</span>
              <span>Read-only preview</span>
            </div>
            <h2 id="role-detail-title" className={styles.dialogTitle}>
              {target.role.name}
            </h2>
            <p className={styles.dialogDescription}>{target.role.description}</p>
          </div>
          <Button icon variant="ghost" onClick={onClose} aria-label="Close role details">
            <IconX size={17} />
          </Button>
        </header>

        <div className={styles.detailBody}>
          {failed && <Notice variant="error">{failed}</Notice>}
          {!detail && !failed && <SkeletonText lines={8} />}
          {detail && (
            <>
              {detail.truncated && (
                <Notice variant="warning">
                  This unusually large role exceeds the preview limit. Its source package is
                  unchanged.
                </Notice>
              )}
              <section className={styles.instructionSection}>
                <h3>Role instructions</h3>
                <RoleMarkdown
                  source={detail.role.instructions}
                  headingOffset={3}
                  idPrefix={`role-${detail.role.name}-`}
                />
              </section>
              {detail.skills.length > 0 && (
                <section className={styles.linkedSection}>
                  <div>
                    <h3>Linked skills</h3>
                    <p>Supporting instructions loaded together with this role.</p>
                  </div>
                  {detail.skills.map((skill) => (
                    <article className={styles.linkedSkill} key={skill.name}>
                      <h4>{skill.name}</h4>
                      <p>{skill.description}</p>
                      <RoleMarkdown
                        source={skill.instructions}
                        headingOffset={4}
                        idPrefix={`role-${detail.role.name}-skill-${skill.name}-`}
                      />
                    </article>
                  ))}
                </section>
              )}
            </>
          )}
        </div>

        <footer className={styles.detailActions}>
          <Button onClick={onClose}>Close</Button>
          {onAdd && (
            <Button variant="primary" onClick={onAdd} data-testid="role-detail-add">
              <IconPlus size={14} /> Add role
            </Button>
          )}
        </footer>
      </div>
    </Modal>
  )
}

const AddRoleDialog = ({
  role,
  projects,
  onClose,
  onAdded,
}: {
  role: RoleSummary
  projects: ProjectSummary[]
  onClose: () => void
  onAdded: (added: RoleInventoryEntry) => Promise<void>
}) => {
  const toast = useToast()
  const [target, setTarget] = useState<AddTarget>('personal')
  const [project, setProject] = useState(projects[0]?.handle ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const add = async () => {
    setBusy(true)
    setFailed(null)
    try {
      const created = await api.agentRoleAdd({
        name: role.name,
        scope: target,
        ...(target === 'project' ? { project } : {}),
      })
      await onAdded(created)
      toast.success(`${role.name} added to ${target === 'personal' ? 'Personal' : project}`)
      onClose()
    } catch (error) {
      setFailed(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={busy ? undefined : onClose} labelledBy="add-role-title">
      <div className={styles.dialog}>
        <div>
          <h2 id="add-role-title" className={styles.dialogTitle}>
            Add {role.name}
          </h2>
          <p className={styles.dialogDescription}>
            This creates an independent, writable copy. Future catalog updates will not overwrite
            it.
          </p>
        </div>
        {failed && <Notice variant="error">{failed}</Notice>}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Add to</span>
          <select
            className={styles.nativeSelect}
            value={target}
            onChange={(event) => setTarget(event.target.value as AddTarget)}
            data-testid="role-add-scope"
          >
            <option value="personal">Personal — across projects</option>
            <option value="project">Project — only in one project</option>
          </select>
        </label>
        {target === 'project' && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Project</span>
            {projects.length ? (
              <select
                className={styles.nativeSelect}
                value={project}
                onChange={(event) => setProject(event.target.value)}
                data-testid="role-add-project"
              >
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.handle}>
                    {entry.displayName} — {entry.handle}
                  </option>
                ))}
              </select>
            ) : (
              <span className={styles.fieldHint}>No writable project is available.</span>
            )}
          </label>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void add()}
            disabled={busy || (target === 'project' && !project)}
            data-testid="role-add-confirm"
          >
            {busy ? 'Adding…' : 'Add role'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export const RolesPage = () => {
  const { updateRoles } = useAgentsSummary()
  const [data, setData] = useState<MeAgentRolesResponse | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [adding, setAdding] = useState<RoleSummary | null>(null)
  const [viewing, setViewing] = useState<DetailTarget | null>(null)

  const load = useCallback(async () => {
    setFailed(null)
    try {
      const next = await api.agentRolesGet()
      setData(next)
      updateRoles(next)
      setFailed(null)
    } catch (error) {
      setFailed(errorText(error))
    }
  }, [updateRoles])

  useEffect(() => {
    void load()
  }, [load])

  const roles = useMemo(
    () =>
      [...(data?.roles ?? [])].sort((left, right) =>
        `${left.scope}:${left.name}`.localeCompare(`${right.scope}:${right.name}`),
      ),
    [data?.roles],
  )

  return (
    <SettingsLayout
      trail={[{ label: 'Agents' }, { label: 'Roles' }]}
      spaceLess
      sectionTabs={<AgentsTabs active="roles" />}
      testIdPrefix="roles"
    >
      <div className={styles.page} data-testid="agents-roles">
        <header className={styles.head}>
          <h1 className={styles.title}>Role library</h1>
          <p className={styles.sub}>
            Roles shape how an agent approaches a session. The catalog is only a source of
            templates: nothing there is available to agents until you explicitly add a copy.
          </p>
        </header>

        {failed && data && (
          <Notice variant="error" className={styles.loadError}>
            <span>{failed}</span>
            <Button onClick={() => void load()}>Retry</Button>
          </Notice>
        )}
        {!data && !failed ? (
          <SkeletonText lines={7} />
        ) : !data ? (
          <StateView
            tone="error"
            title="Couldn't load roles"
            description={failed}
            actions={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : (
          <>
            {data.truncated && (
              <Notice variant="warning" className={styles.loadError}>
                This role library is unusually large. Some locations were not scanned, so role
                placements may be missing from this bounded view.
              </Notice>
            )}
            <section className={styles.section} aria-labelledby="owned-roles-title">
              <div className={styles.sectionHead}>
                <div>
                  <h2 id="owned-roles-title">Your roles</h2>
                  <p>
                    Writable copies available to your agent, with narrower scopes taking precedence.
                  </p>
                </div>
              </div>
              {roles.length ? (
                <div className={styles.grid}>
                  {roles.map((role) => (
                    <RoleCard
                      key={roleKey(role)}
                      role={role}
                      onView={() =>
                        setViewing({
                          role,
                          query:
                            role.scope === 'personal'
                              ? { scope: 'personal' }
                              : role.scope === 'space'
                                ? { scope: 'space', space: role.space }
                                : { scope: 'project', project: role.project },
                        })
                      }
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<IconBot size={22} />}
                  title={data.truncated ? 'No roles in this bounded view' : 'No roles added'}
                  hint={
                    data.truncated
                      ? 'Roles in unscanned locations may be omitted. This view cannot prove that the agent is in base mode.'
                      : 'You are in base mode. Add a catalog role below when a session needs a specialized way of working.'
                  }
                />
              )}
            </section>

            <section className={styles.section} aria-labelledby="catalog-roles-title">
              <div className={styles.sectionHead}>
                <div>
                  <h2 id="catalog-roles-title">Built-in catalog</h2>
                  <p>
                    Read-only templates. Adding one creates your own fork; it does not activate a
                    session.
                  </p>
                </div>
              </div>
              <div className={styles.grid}>
                {(data?.catalog ?? []).map((role) => (
                  <article
                    className={styles.catalogCard}
                    key={role.name}
                    data-testid={`catalog-role-${role.name}`}
                  >
                    <span className={styles.catalogIcon}>
                      <IconSparkles size={16} />
                    </span>
                    <div className={styles.catalogBody}>
                      <h3 className={styles.cardTitle}>{role.name}</h3>
                      <p className={styles.cardDescription}>{role.description}</p>
                    </div>
                    <div className={styles.catalogActions}>
                      <Button
                        onClick={() => setViewing({ role, query: { scope: 'catalog' } })}
                        aria-label={`View built-in ${role.name} role`}
                        data-testid={`role-view-${role.name}-catalog`}
                      >
                        View
                      </Button>
                      <Button
                        onClick={() => setAdding(role)}
                        aria-label={`Add built-in ${role.name} role`}
                        data-testid={`role-add-${role.name}`}
                      >
                        <IconPlus size={14} /> Add
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
      {adding && data && (
        <AddRoleDialog
          role={adding}
          projects={data.projects}
          onClose={() => setAdding(null)}
          onAdded={async (added) => {
            const next = {
              ...data,
              roles: [...data.roles.filter((role) => roleKey(role) !== roleKey(added)), added],
            }
            setData(next)
            updateRoles(next)
            await load()
          }}
        />
      )}
      {viewing && (
        <RoleDetailDialog
          target={viewing}
          onClose={() => setViewing(null)}
          onAdd={
            viewing.query.scope === 'catalog'
              ? () => {
                  setViewing(null)
                  setAdding(viewing.role)
                }
              : undefined
          }
        />
      )}
    </SettingsLayout>
  )
}
