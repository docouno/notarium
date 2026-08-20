import { describe, expect, it } from 'vitest'
import {
  canonicalPackageLibraryParams,
  PACKAGE_LIBRARY_AVAILABILITIES,
  PACKAGE_LIBRARY_HOMES,
  PACKAGE_LIBRARY_SOURCES,
  packageLibraryQuery,
  patchPackageLibraryState,
  readPackageLibraryState,
} from './packageLibraryState'

describe('package library URL state', () => {
  it('trims values, removes invalid filters, and preserves unrelated params', () => {
    const canonical = canonicalPackageLibraryParams(
      new URLSearchParams(
        'q=++shared+review++&source=external&home=space&availability=selected&project=++team%2Fother++&keep=1',
      ),
    )

    expect(canonical.toString()).toBe(
      'q=shared+review&home=space&availability=selected&project=team%2Fother&keep=1',
    )
    expect(readPackageLibraryState(canonical)).toEqual({
      q: 'shared review',
      source: null,
      home: 'space',
      availability: 'selected',
      project: 'team/other',
    })
  })

  it('patches only explicit fields and omits cursor from the durable query', () => {
    const current = new URLSearchParams('q=review&source=owned&keep=1')
    const next = patchPackageLibraryState(current, { source: null, project: 'team/alpha' })

    expect(next.toString()).toBe('q=review&keep=1&project=team%2Falpha')
    expect(packageLibraryQuery(readPackageLibraryState(next), 'cursor-1')).toEqual({
      q: 'review',
      project: 'team/alpha',
      limit: 24,
      cursor: 'cursor-1',
    })
    expect(next.has('cursor')).toBe(false)
  })
})

// One dictionary, two readers: the URL reader and the aside's controls. A third copy
// is what the module header forbids, so the vocabulary is exported and the test holds
// the reader to it.
describe('package library filter vocabulary', () => {
  it('accepts every exported source, home and availability', () => {
    for (const source of PACKAGE_LIBRARY_SOURCES) {
      expect(readPackageLibraryState(new URLSearchParams(`source=${source}`)).source).toBe(source)
    }
    for (const home of PACKAGE_LIBRARY_HOMES) {
      expect(readPackageLibraryState(new URLSearchParams(`home=${home}`)).home).toBe(home)
    }
    for (const availability of PACKAGE_LIBRARY_AVAILABILITIES) {
      expect(
        readPackageLibraryState(new URLSearchParams(`availability=${availability}`)).availability,
      ).toBe(availability)
    }
  })

  it('offers the sources in the order the aside renders them', () => {
    expect([...PACKAGE_LIBRARY_SOURCES]).toEqual(['owned', 'system', 'catalog'])
  })

  it('refuses a value outside the vocabulary', () => {
    expect(readPackageLibraryState(new URLSearchParams('source=external')).source).toBeNull()
  })
})
