import { Link } from 'react-router'
import { IconSettings } from '../../core/Icons'
import { settingsRoute } from '../../libs/routing/routePaths'
import styles from './Sidebar.module.scss'

// Settings in one click (#112): a dedicated gear pinned in the rail footer →
// /settings, present in BOTH auth modes. Settings used to be reachable only
// through the avatar dropdown (a 2–3 click detour for a frequently-opened page) —
// pulling it out as its own control is the issue's core fix. The avatar's menu
// goes to the Profile tab, not here: the abstract Settings is the gear's job, the
// personal half is the avatar's (a clearer split than duplicating Settings).
export const SettingsGear = () => (
  <Link
    to={settingsRoute()}
    className={styles.iconBtn}
    title="Settings"
    data-testid="rail-settings"
  >
    <IconSettings size={17} />
  </Link>
)
