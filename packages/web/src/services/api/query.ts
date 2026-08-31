import type { MeMemoryQuery, ProjectMemoryQuery } from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import type { NotesQueryParams } from './types'

export const notesQs = (p: NotesQueryParams): string => {
  const q = new URLSearchParams()

  if (p.sort) {
    q.set(QUERY_KEY.sort, p.sort)
  }
  if (p.offset) {
    q.set(QUERY_KEY.offset, String(p.offset))
  }
  if (p.limit !== undefined) {
    q.set(QUERY_KEY.limit, String(p.limit))
  }
  if (p.folder !== undefined) {
    q.set(QUERY_KEY.folder, p.folder)
  }
  if (p.depth) {
    q.set(QUERY_KEY.depth, p.depth)
  }
  for (const f of p.folders || []) {
    q.append(QUERY_KEY.folders, f)
  }
  for (const t of p.tags || []) {
    q.append(QUERY_KEY.tags, t)
  }
  for (const field of p.field || []) {
    q.append(QUERY_KEY.field, field)
  }
  for (const field of p.fieldDay || []) {
    q.append(QUERY_KEY.fieldDay, field)
  }
  for (const field of p.fieldAny || []) {
    q.append(QUERY_KEY.fieldAny, field)
  }
  for (const field of p.fieldBad || []) {
    q.append(QUERY_KEY.fieldBad, field)
  }
  if (p.q) {
    q.set(QUERY_KEY.q, p.q)
  }
  if (p.from) {
    q.set(QUERY_KEY.from, p.from)
  }
  if (p.to) {
    q.set(QUERY_KEY.to, p.to)
  }
  if (p.dateField) {
    q.set(QUERY_KEY.dateField, p.dateField)
  }
  if (p.from || p.to || p.tz !== undefined) {
    q.set(QUERY_KEY.tz, String(p.tz ?? -new Date().getTimezoneOffset()))
  }
  if (p.favorite) {
    q.set(QUERY_KEY.favorite, '1')
  }
  if (p.preview) {
    q.set(QUERY_KEY.preview, '1')
  }
  if (p.viewSummary) {
    q.set(QUERY_KEY.viewSummary, '1')
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const memoryQs = (p: MeMemoryQuery | ProjectMemoryQuery): string => {
  const q = new URLSearchParams()

  if ('order' in p && p.order) {
    q.set('order', p.order)
  }
  if (p.sort) {
    q.set(QUERY_KEY.sort, p.sort)
  }
  if (p.dir) {
    q.set(QUERY_KEY.dir, p.dir)
  }
  const value = q.toString()
  return value ? `?${value}` : ''
}
