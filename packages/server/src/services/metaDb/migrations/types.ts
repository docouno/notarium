export type MetaMigration = {
  version: number
  name: string
  checksum: string
  sqlite: string
  postgres: string
}

export type AppliedMetaMigration = {
  version: number
  name: string
  checksum: string
}
