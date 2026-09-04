import type {
  Me,
  MePatchRequest,
  Pat,
  PatCreateRequest,
  PatCreateResponse,
  PatPatchRequest,
} from '@notarium/contract'

export type AccountSettingsSource = {
  /** Rename / re-address the account; resolves once `me` reflects the change. */
  updateIdentity: (patch: MePatchRequest) => Promise<Me>
  changePassword: (currentPassword: string, newPassword: string) => Promise<unknown>
  listTokens: () => Promise<Pat[]>
  createToken: (input: PatCreateRequest) => Promise<PatCreateResponse>
  editToken: (id: string, input: PatPatchRequest) => Promise<unknown>
  revokeToken: (id: string) => Promise<unknown>
}
