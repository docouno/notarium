#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { COVERAGE_REPORT_PATH, validateCobertura } from './ciCoverage.mjs'

export const JUNIT_REPORT_PATH = 'test-results/vitest-junit.xml'

export const validateJunit = async (path = JUNIT_REPORT_PATH, { parserEntry = 'saxes' } = {}) => {
  const metadata = await stat(path)
  const xml = await readFile(path, 'utf8')
  const { SaxesParser } = await import(parserEntry)
  const parser = new SaxesParser({ fileName: path })
  let root = null
  let tests = null
  let suites = 0
  let parseError = null

  if (metadata.size < 1) {
    throw new Error(`JUnit report is empty: ${path}`)
  }
  parser.on('error', (error) => {
    parseError ??= error
  })
  parser.on('opentag', (tag) => {
    root ??= tag.name

    if (tag.name === 'testsuites' && root === tag.name) {
      tests = tag.attributes.tests
    } else if (tag.name === 'testsuite' && root === 'testsuites') {
      suites += 1
    }
  })

  try {
    parser.write(xml).close()
  } catch (error) {
    parseError ??= error
  }

  if (parseError) {
    throw new Error(`JUnit report is not well-formed XML: ${parseError.message}`)
  }
  if (
    root !== 'testsuites' ||
    suites < 1 ||
    typeof tests !== 'string' ||
    !/^[1-9]\d*$/u.test(tests)
  ) {
    throw new Error(`JUnit report must have a testsuites root and a positive test count: ${path}`)
  }

  return { bytes: metadata.size, suites, tests: Number(tests) }
}

export const validateCiReports = async () => {
  const [coverage, junit] = await Promise.all([
    validateCobertura(COVERAGE_REPORT_PATH),
    validateJunit(JUNIT_REPORT_PATH),
  ])

  console.error(`ci-reports: ${JSON.stringify({ coverage, junit })}`)
  return { coverage, junit }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await validateCiReports()
}
