import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const GITLAB_COBERTURA_LIMIT_BYTES = 10 * 1024 * 1024
export const COVERAGE_REPORT_PATH = 'coverage/cobertura-coverage.xml'

export const validateCobertura = async (path, { parserEntry = 'saxes' } = {}) => {
  const metadata = await stat(path)

  if (metadata.size < 1 || metadata.size > GITLAB_COBERTURA_LIMIT_BYTES) {
    throw new Error(
      `Cobertura report must be 1..${GITLAB_COBERTURA_LIMIT_BYTES} bytes, got ${metadata.size}`,
    )
  }
  const xml = await readFile(path, 'utf8')
  const { SaxesParser } = await import(parserEntry)
  const parser = new SaxesParser({ fileName: path })
  const elements = []
  const filenames = []
  let root = null
  let parseError = null
  let hasSources = false
  let hasSource = false
  let hasPackages = false
  let classMissingFilename = false

  parser.on('error', (error) => {
    parseError ??= error
  })
  parser.on('opentag', (tag) => {
    const parent = elements.at(-1)

    if (elements.length === 0 && root === null) {
      root = tag.name
    }
    if (tag.name === 'sources' && parent === 'coverage') {
      hasSources = true
    } else if (tag.name === 'source' && parent === 'sources' && elements.at(-2) === 'coverage') {
      hasSource = true
    } else if (tag.name === 'packages' && parent === 'coverage') {
      hasPackages = true
    } else if (tag.name === 'class' && elements[0] === 'coverage' && elements[1] === 'packages') {
      const filename = tag.attributes.filename

      if (typeof filename === 'string') {
        filenames.push(filename)
      } else {
        classMissingFilename = true
      }
    }
    elements.push(tag.name)
  })
  parser.on('closetag', () => {
    elements.pop()
  })

  try {
    parser.write(xml).close()
  } catch (error) {
    parseError ??= error
  }

  if (parseError) {
    throw new Error(`Cobertura report is not well-formed XML: ${parseError.message}`)
  }
  if (root !== 'coverage' || !hasSources || !hasSource || !hasPackages) {
    throw new Error('Cobertura report is missing coverage/sources/source/packages structure')
  }
  if (classMissingFilename) {
    throw new Error('Cobertura report contains a source class without filename')
  }
  if (!filenames.length) {
    throw new Error('Cobertura report contains no source classes')
  }
  const invalid = filenames.find(
    (filename) =>
      isAbsolute(filename) ||
      filename.includes('\\') ||
      /^[A-Za-z]:\//u.test(filename) ||
      filename.split('/').some((part) => part === '' || part === '.' || part === '..'),
  )

  if (invalid) {
    throw new Error(`Cobertura filename is not repository-relative: ${invalid}`)
  }

  return { bytes: metadata.size, classCount: filenames.length }
}
