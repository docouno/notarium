import type { Pat, PatCreateRequest, PatCreateResponse, PatPatchRequest } from '@notarium/contract'

export type AccountSettingsSource = {
  changePassword: (currentPassword: string, newPassword: string) => Promise<unknown>
  listTokens: () => Promise<Pat[]>
  createToken: (input: PatCreateRequest) => Promise<PatCreateResponse>
  editToken: (id: string, input: PatPatchRequest) => Promise<unknown>
  revokeToken: (id: string) => Promise<unknown>
}
