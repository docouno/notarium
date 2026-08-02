// Canon-link guard (#56): every `// canon: docs/<file>.md#<anchor>` reference in
// the sources must resolve to a real anchor in that doc. It keeps the code↔canon
// link checkable rather than decorative — the same discipline the boundaries
// linter enforces for P8/P9.
// canon: docs/architecture.md#comments
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIRS = ['packages', 'scripts', 'test']
const SRC_EXT = /\.(ts|tsx|mjs|js)$/
const SKIP = /node_modules|[/\\]dist[/\\]/

// A line is parsed only when it carries the `canon:` marker; on such a line every
// token of the form docs/<path>.md#<anchor> is validated.
const MARKER = /canon:/
const REF = /docs\/[\w./-]+\.md#[\p{L}\p{N}_-]+/gu

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)

    if (SKIP.test(p)) {
      continue
    }
    const st = statSync(p)

    if (st.isDirectory()) {
      walk(p, out)
    } else if (SRC_EXT.test(name)) {
      out.push(p)
    }
  }

  return out
}

// GitHub-style heading slug: lowercase, keep unicode letters/digits, drop
// punctuation, spaces → dashes. Explicit HTML id=/name= anchors count too.
const headingSlug = (s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \t-]/gu, '')
    .replace(/[ \t]+/g, '-')

const anchorCache = new Map()

const anchorsOf = (docPath) => {
  if (anchorCache.has(docPath)) {
    return anchorCache.get(docPath)
  }
  let text

  try {
    text = readFileSync(docPath, 'utf8')
  } catch {
    anchorCache.set(docPath, null)
    return null
  }
  const set = new Set()

  for (const m of text.matchAll(/(?:id|name)=["']([\w-]+)["']/g)) {
    set.add(m[1].toLowerCase())
  }
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    set.add(headingSlug(m[1]))
  }
  anchorCache.set(docPath, set)
  return set
}

const broken = []
let refCount = 0
const roots = SRC_DIRS.filter((d) => {
  try {
    return statSync(join(ROOT, d)).isDirectory()
  } catch {
    return false
  }
})
const files = roots.flatMap((d) => walk(join(ROOT, d)))

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!MARKER.test(line)) {
      return
    }
    const refs = line.match(REF)

    if (!refs) {
      return
    }
    for (const ref of refs) {
      refCount += 1
      const [rel, anchor] = ref.split('#')
      const set = anchorsOf(resolve(ROOT, rel))
      const loc = `${relative(ROOT, file)}:${i + 1}`

      if (set === null) {
        broken.push(`${loc}  →  ${ref}  (doc file not found: ${rel})`)
      } else if (!set.has(anchor.toLowerCase())) {
        broken.push(`${loc}  →  ${ref}  (no anchor #${anchor} in ${rel})`)
      }
    }
  })
}

if (broken.length > 0) {
  console.error(`canon-guard: ${broken.length} broken of ${refCount} references checked:\n`)
  for (const b of broken) {
    console.error('  ✗ ' + b)
  }
  process.exit(1)
}
console.log(`canon-guard: ✓ ${refCount} canon references valid (${files.length} files scanned)`)
