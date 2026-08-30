export const ADDRESS_CLASS = {
  public: 'public',
  private: 'private',
  loopback: 'loopback',
  alwaysDenied: 'always-denied',
} as const

export type AddressClass = (typeof ADDRESS_CLASS)[keyof typeof ADDRESS_CLASS]
