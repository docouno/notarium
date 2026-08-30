import type { FieldSchemaResponse } from '@notarium/contract'

import { FIELD_SCHEMA_STATUS } from './consts'
import type { FieldSchemaSnapshot } from './fieldSchemaStore'

export const fieldSchemaToWire = (snapshot: FieldSchemaSnapshot): FieldSchemaResponse => ({
  version: snapshot.version,
  fields: snapshot.fields,
  versionToken: snapshot.versionToken,
  valueWrites:
    snapshot.status !== FIELD_SCHEMA_STATUS.unavailable &&
    snapshot.status !== FIELD_SCHEMA_STATUS.structuralError,
  ...(snapshot.readOnly ? { readOnly: true } : {}),
  ...(snapshot.error ? { error: snapshot.error } : {}),
})
