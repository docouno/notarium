import type { Me } from '@notarium/contract'
import { IdentitySection } from './IdentitySection'
import { PasswordSection } from './PasswordSection'
import { TokensSection } from './TokensSection'
import type { AccountSettingsSource } from './types'

export type { AccountSettingsSource }

type AccountSettingsProps = {
  me: Me
  source: AccountSettingsSource
}

// The account-settings widget (#10): who I am (handle, e-mail), password change,
// personal access tokens. Props-driven, transport via the host-wired source port
// (widgets never import services).
export const AccountSettings = ({ me, source }: AccountSettingsProps) => (
  <>
    <IdentitySection me={me} source={source} />
    <PasswordSection source={source} />
    <TokensSection me={me} source={source} />
  </>
)
