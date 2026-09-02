import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** The manifests the corpus reads a name, a version and a source ref out of. They
 *  arrive with the @notarium/engine-vector carrier, which the lean profile omits on
 *  purpose (#200), so absence is a legitimate profile rather than a broken install.
 *
 *  This is deliberately not the vector gate: that probes whether vec0 loads, while
 *  this module asks only whether full-profile packages exist on disk. */
export const FULL_DEPS_NATIVE_MANIFESTS = Object.freeze([
  'node_modules/onnxruntime-common',
  'node_modules/onnxruntime-node',
  'node_modules/onnxruntime-web',
  'node_modules/onnxruntime-web/node_modules/onnxruntime-common',
])

export const missingFullDepsManifests = ({
  rootPath = root,
  exists = existsSync,
}: {
  rootPath?: string
  exists?: (path: string) => boolean
} = {}): string[] =>
  FULL_DEPS_NATIVE_MANIFESTS.filter((dir) => !exists(join(rootPath, dir, 'package.json')))

/** Probed once for Vitest's conditional declaration; an install cannot appear mid-run. */
export const fullDepsInstalled = missingFullDepsManifests().length === 0

/** Plain-Node precheck used before selecting only full-install Vitest cases in CI. */
export const assertFullDepsInstalled = (missing = missingFullDepsManifests()): void => {
  if (missing.length) {
    throw new Error(
      `full-deps test contour requires the native manifests; missing: ${missing.join(', ')}`,
    )
  }
}
