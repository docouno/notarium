import { describe, expect, it } from 'vitest'

import { STORE_ERROR_REASON } from '@notarium/core'

import { FIELD_SCHEMA_STATUS } from './consts'
import type { FieldSchemaStore } from './fieldSchemaStore'
import { prepareFieldWrite } from './prepareFieldWrite'

const storeWith = (status: (typeof FIELD_SCHEMA_STATUS)[keyof typeof FIELD_SCHEMA_STATUS]) =>
  ({
    read: async () => ({
      version: 1,
      fields: [{ key: 'priority', type: 'number' as const }],
      versionToken: 'v1',
      status,
      ...(status === FIELD_SCHEMA_STATUS.ready ? {} : { readOnly: true as const, error: status }),
    }),
    update: async () => {
      throw new Error('unused')
    },
    clear: () => undefined,
  }) as FieldSchemaStore

describe('prepareFieldWrite', () => {
  it('rejects only unavailable and structurally invalid schema documents', async () => {
    for (const status of [FIELD_SCHEMA_STATUS.unavailable, FIELD_SCHEMA_STATUS.structuralError]) {
      await expect(
        prepareFieldWrite(storeWith(status), 's1', { priority: '3' }),
      ).rejects.toMatchObject({ reason: STORE_ERROR_REASON.fieldSchemaUnavailable })
    }
  })

  it('allows future and form-error documents without byte-shape advice', async () => {
    for (const status of [FIELD_SCHEMA_STATUS.futureVersion, FIELD_SCHEMA_STATUS.formError]) {
      await expect(prepareFieldWrite(storeWith(status), 's1', { priority: '3' })).resolves.toEqual(
        [],
      )
    }
  })

  it('resolves valid declared number fields and rejects a missing schema service', async () => {
    await expect(
      prepareFieldWrite(storeWith(FIELD_SCHEMA_STATUS.ready), 's1', { priority: '3' }),
    ).resolves.toEqual(['priority'])
    await expect(prepareFieldWrite(undefined, 's1', { priority: '3' })).rejects.toMatchObject({
      reason: STORE_ERROR_REASON.fieldSchemaUnavailable,
    })
  })
})
