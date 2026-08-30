import type { FieldSchemaResponse, FieldSchemaUpdate, FieldsResponse } from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'

import { req, sp } from './client'

export const fieldsApi = {
  fieldsGet: (space: string, params: { q?: string; limit?: number; valuesLimit?: number } = {}) => {
    const query = new URLSearchParams()

    if (params.q) {
      query.set(QUERY_KEY.q, params.q)
    }
    if (params.limit !== undefined) {
      query.set(QUERY_KEY.limit, String(params.limit))
    }
    if (params.valuesLimit !== undefined) {
      query.set(QUERY_KEY.valuesLimit, String(params.valuesLimit))
    }
    const value = query.toString()
    return req<FieldsResponse>(`${sp(space)}/fields${value ? `?${value}` : ''}`)
  },
  fieldSchemaGet: (space: string) => req<FieldSchemaResponse>(`${sp(space)}/fields/schema`),
  fieldSchemaPut: (space: string, body: FieldSchemaUpdate) =>
    req<FieldSchemaResponse>(`${sp(space)}/fields/schema`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}
