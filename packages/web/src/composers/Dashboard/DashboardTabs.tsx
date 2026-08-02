import type { ReactNode } from 'react'
import { type PillTab, PillTabs } from '../../core/PillTabs'
import { dashboardRoute, type DashboardView } from '../../libs/routing/routePaths'

// The dashboard's pill tab-bar (#216): the old row of dead stat tiles reborn as
// SWITCHERS into deep surfaces. A thin adapter over the shared PillTabs (#243) — the
// same "sections of a surface" nav the Agents sections use — in `fill` layout (the
// full-width metric plates), each pill a `/s/<space>/dashboard/<view>` route (the
// default, Activity, points at the bare space home). A pill can carry a severity dot
// (Health goes danger when links are broken).

export type DashboardTab = {
  view: DashboardView
  label: string
  icon: ReactNode
  /** The pill's headline metric ("3 this week", "4 · 2 active", "1 to fix"). */
  metric: ReactNode
  /** A danger dot on the label — Health when the graph has broken links. */
  danger?: boolean
}

export const DashboardTabs = ({
  space,
  active,
  tabs,
}: {
  space: string
  active: DashboardView
  tabs: DashboardTab[]
}) => {
  const pills: PillTab[] = tabs.map((t) => ({
    key: t.view,
    to: dashboardRoute(space, t.view),
    label: t.label,
    icon: t.icon,
    metric: t.metric,
    danger: t.danger,
    testId: `dash-pill-${t.view}`,
  }))
  return <PillTabs tabs={pills} activeKey={active} ariaLabel="Dashboard surfaces" fill />
}
