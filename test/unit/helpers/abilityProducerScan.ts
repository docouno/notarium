/**
 * The mechanism behind `abilityProducerRegistry.test.ts`: the Ability domain's rules,
 * located in the source as SYNTAX rather than as text.
 *
 * WHY AST. The register used to search for the ingredients of each rule with regular
 * expressions over the file text, and round 6 walked out of it eighteen ways. Most of
 * them were not clever: a space before a paren, a line break prettier inserts by
 * itself once a name grows, a property order TypeScript does not fix, a shorthand, a
 * template string, double quotes, `ABILITY_SOURCE.owned` instead of `'owned'`. Two
 * more came from the text stripper: a string literal containing `/*` opened a comment
 * that swallowed 84 lines of a live file, so the scan could not see what was in them.
 * None of that survives a parser — `ts.createSourceFile` answers with nodes, and a
 * node does not care how it was spelled, quoted, wrapped or ordered.
 *
 * The matchers below therefore look for SHAPES: an object literal whose property set
 * is an addressed locator, a membership call whose receiver is a reach list, a cast
 * to a branded placement type. What they cannot see is stated in the register.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

export type ScannedFile = {
  /** Repo-relative, POSIX separators — the form the register's keys are written in. */
  readonly file: string
  readonly text: string
}

/** One occurrence of a rule, addressed at the granularity the register allows: the
 *  enclosing function, not the file. A copy inside the producer's own file is the
 *  shape that got through the previous register, so `roles.ts` cannot be waved past
 *  as a whole any more. */
export type Site = {
  /** `<repo-relative path>#<enclosing symbol>`. */
  readonly at: string
  readonly line: number
  /** The matched source, collapsed to one line, for the failure message. */
  readonly source: string
}

export type Matcher = (file: ScannedFile) => Site[]

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** A test states a rule on purpose — including the fixtures that prove this gate
 *  reddens — so test bodies are not scanned. This is the ONLY name-based exclusion;
 *  every directory-level one is declared in the register with its reason. */
/** A stand-in for "this element declares no property name", chosen so it cannot
 *  collide with a real one. It used to be a string carrying raw NUL bytes, which made
 *  this whole file BINARY to `grep` and `git grep` — the tools a reader reaches for
 *  first when asking what the register actually covers. */
const NO_PROPERTY_NAME = '\u0000none'

const isTestBody = (entry: string): boolean => /\.(test|spec)\.tsx?$/.test(entry)

const walk = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir).sort()) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = path.join(dir, entry)

    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.tsx?$/.test(entry) && !isTestBody(entry)) {
      out.push(full)
    }
  }
}

/** Every scannable file under the given repo-relative roots. */
export const readSurface = (roots: readonly string[]): ScannedFile[] => {
  const found: string[] = []

  for (const root of roots) {
    walk(path.join(REPO_ROOT, root), found)
  }

  return found.map((full) => ({
    file: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }))
}

/** The immediate children of a repo-relative directory, so the register can be held to
 *  covering ALL of them: a new sibling is then a failing test rather than a silent
 *  hole. */
export const childDirectories = (root: string): string[] =>
  readdirSync(path.join(REPO_ROOT, root))
    .filter((entry) => statSync(path.join(REPO_ROOT, root, entry)).isDirectory())
    .filter((entry) => !IGNORED_DIRECTORIES.has(entry))
    .sort()

export const hasDirectory = (relative: string): boolean => {
  try {
    return statSync(path.join(REPO_ROOT, relative)).isDirectory()
  } catch {
    return false
  }
}

/** Parsing 1200 files once per rule is the whole cost of this gate; the surface is
 *  read once and every matcher sees the same trees. */
const parsed = new WeakMap<ScannedFile, ts.SourceFile>()

const parse = (file: ScannedFile): ts.SourceFile => {
  const cached = parsed.get(file)

  if (cached) {
    return cached
  }
  const sf = ts.createSourceFile(
    file.file,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  parsed.set(file, sf)

  return sf
}

const named = (node: ts.Node): string | null => {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name ? node.name.getText() : null
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent

    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text
    }
  }

  return null
}

/** The nearest enclosing function, or failing that the binding the node initialises.
 *  Functions first on purpose: `const locator = cond ? { … } : null` inside a 400-line
 *  method would otherwise be addressed as `locator`, which names nothing a reader can
 *  find. */
const symbolOf = (node: ts.Node): string => {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    if (ts.isFunctionLike(cursor)) {
      const name = named(cursor)

      if (name) {
        return name
      }
    }
    if (ts.isClassDeclaration(cursor) && cursor.name) {
      return cursor.name.text
    }
  }
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) {
      return cursor.name.text
    }
  }

  return '<module>'
}

const siteOf = (sf: ts.SourceFile, file: string, node: ts.Node): Site => ({
  at: `${file}#${symbolOf(node)}`,
  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  source: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
})

const walked = new WeakMap<ts.Node, ts.Node[]>()

/** Pre-order, so a matcher that claims a node has already seen its ancestors. */
const nodes = (root: ts.Node): ts.Node[] => {
  const cached = walked.get(root)

  if (cached) {
    return cached
  }
  const out: ts.Node[] = []

  const visit = (node: ts.Node): void => {
    out.push(node)
    ts.forEachChild(node, visit)
  }

  visit(root)
  walked.set(root, out)

  return out
}

/** A file that never spells the name a rule is about cannot carry that rule under ANY
 *  syntax: every rewrite the register answers to — bracket access, destructuring,
 *  shorthand, aliasing — still contains the name it renames FROM. So this is a cost
 *  filter over which files get parsed, not a second, weaker matcher: `reachSpellings`
 *  needs `projectIds` to exist before it can be aliased, and a locator literal needs a
 *  `packageId` property to be one. */
const mentions = (file: ScannedFile, token: string): boolean => file.text.includes(token)

/** The name an expression REFERS to, whatever syntax carried it: `a.projectIds`,
 *  `projectIds`, and `a['projectIds']` are one answer, which is what makes the
 *  bracket-access and destructuring rewrites stop being escapes. */
const referencedName = (node: ts.Node): string | null => {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }

  return null
}

const namesIn = (root: ts.Node): string[] =>
  nodes(root).flatMap((node) => {
    const name = referencedName(node)

    return name ? [name] : []
  })

/** Peel away the wrappers that carry a value through unchanged. A rewrite into
 *  `new Set(...)`, a spread copy, an `as` cast or a `?? []` default is the same list,
 *  and the register is about the list. */
const unwrap = (expression: ts.Expression): ts.Expression => {
  let current = expression

  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression
      continue
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      current = current.left
      continue
    }
    if (
      ts.isArrayLiteralExpression(current) &&
      current.elements.length === 1 &&
      ts.isSpreadElement(current.elements[0]!)
    ) {
      current = current.elements[0]!.expression
      continue
    }
    if (
      (ts.isNewExpression(current) || ts.isCallExpression(current)) &&
      current.arguments?.length === 1
    ) {
      const callee = referencedName(current.expression)

      if (callee === 'Set' || callee === 'from') {
        current = current.arguments[0]!
        continue
      }
    }

    return current
  }
}

// ---------------------------------------------------------------------------
// Rule: does an ability's reach cover this project
// ---------------------------------------------------------------------------

const REACH_LIST = 'projectIds'
/** Membership: one element against the list. Whatever the argument, this IS the
 *  reach question. */
const DIRECT_MEMBERSHIP = new Set(['includes', 'indexOf', 'lastIndexOf', 'has', 'contains'])
/** Search: the same question when the predicate compares an element to something from
 *  outside, and an ordinary list operation when it does not. */
const PREDICATE_MEMBERSHIP = new Set(['some', 'every', 'find', 'findIndex', 'filter'])
const ITERATION = new Set(['map', 'forEach', 'flatMap', 'reduce', 'sort', 'filter'])

/** Names bound to the reach list within one file: `const ids = a.projectIds`,
 *  `const { projectIds: ids } = a`, `new Set(a.projectIds)`. */
const reachAliasesOf = (sf: ts.SourceFile): Set<string> => {
  const aliases = new Set<string>([REACH_LIST])

  for (let pass = 0; pass < 3; pass += 1) {
    for (const node of nodes(sf)) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const source = referencedName(unwrap(node.initializer))

        if (source && aliases.has(source)) {
          aliases.add(node.name.text)
        }
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName) {
        const source = referencedName(node.propertyName as ts.Node)

        if (source && aliases.has(source)) {
          aliases.add(node.name.text)
        }
      }
    }
  }

  return aliases
}

const isReachList = (expression: ts.Expression, aliases: ReadonlySet<string>): boolean =>
  namesIn(expression).some((name) => aliases.has(name))

const calleeName = (node: ts.CallExpression): string | null =>
  ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : ts.isElementAccessExpression(node.expression) &&
        ts.isStringLiteralLike(node.expression.argumentExpression)
      ? node.expression.argumentExpression.text
      : null

const receiverOf = (node: ts.CallExpression): ts.Expression | null =>
  ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
    ? node.expression.expression
    : null

/** Spans in which an identifier names an ELEMENT of the reach list rather than a
 *  project the caller is asking about — the parameters of a callback handed to the
 *  list itself. Without this, `[...next].every((id) => covered.has(id))` in the web's
 *  reach-comparison would read as a reach test, and an honest neighbour flagged by a
 *  gate is how allow-lists learn to grow. */
const elementSpansOf = (
  sf: ts.SourceFile,
  aliases: ReadonlySet<string>,
): Array<{
  readonly start: number
  readonly end: number
  readonly names: ReadonlySet<string>
}> => {
  const spans: Array<{ start: number; end: number; names: Set<string> }> = []

  for (const node of nodes(sf)) {
    if (!ts.isCallExpression(node)) {
      continue
    }
    const name = calleeName(node)
    const receiver = receiverOf(node)

    if (
      !name ||
      !receiver ||
      !(DIRECT_MEMBERSHIP.has(name) || PREDICATE_MEMBERSHIP.has(name) || ITERATION.has(name)) ||
      !isReachList(receiver, aliases)
    ) {
      continue
    }
    const names = new Set<string>()

    for (const argument of node.arguments) {
      if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) {
        continue
      }
      for (const parameter of argument.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          names.add(parameter.name.text)
        }
      }
    }
    if (names.size) {
      spans.push({ start: node.getStart(sf), end: node.getEnd(), names })
    }
  }

  return spans
}

const ASKS_ABOUT_ONE_PROJECT = /project/i

/** Every place that answers "does this reach cover that project" without asking the
 *  producer. */
export const reachSpellings: Matcher = (file) => {
  if (!mentions(file, REACH_LIST)) {
    return []
  }
  const sf = parse(file)
  const aliases = reachAliasesOf(sf)
  const spans = elementSpansOf(sf, aliases)
  const isElement = (name: string, position: number): boolean =>
    spans.some((span) => position >= span.start && position <= span.end && span.names.has(name))
  const out: Site[] = []

  const membership = (node: ts.CallExpression): boolean => {
    const name = calleeName(node)
    const receiver = receiverOf(node)

    if (!name || !receiver || !isReachList(receiver, aliases)) {
      return false
    }
    if (DIRECT_MEMBERSHIP.has(name)) {
      const argument = node.arguments[0]

      if (!argument) {
        return false
      }
      const referenced = namesIn(argument).filter((each) => !aliases.has(each))
      // A project the caller named, however it was spelled — or any value at all that
      // is not an element of the list being searched.
      return (
        referenced.some(
          (each) => ASKS_ABOUT_ONE_PROJECT.test(each) && !isElement(each, argument.getStart(sf)),
        ) ||
        (referencedName(argument) !== null &&
          !referenced.some((each) => isElement(each, argument.getStart(sf))))
      )
    }
    if (!PREDICATE_MEMBERSHIP.has(name)) {
      return false
    }
    const callback = node.arguments[0]

    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      return false
    }
    const parameters = new Set(
      callback.parameters.flatMap((parameter) =>
        ts.isIdentifier(parameter.name) ? [parameter.name.text] : [],
      ),
    )
    const element = callback.parameters[0]
    const elementName =
      element && ts.isIdentifier(element.name) ? element.name.text : NO_PROPERTY_NAME

    // The predicate compares an ELEMENT to something from outside the list: that is
    // the membership question, written as a search.
    return nodes(callback).some((inner) => {
      if (!ts.isBinaryExpression(inner)) {
        return false
      }
      const equality =
        inner.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        inner.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        inner.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        inner.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken

      if (!equality) {
        return false
      }
      const sides = [
        [inner.left, inner.right],
        [inner.right, inner.left],
      ] as const

      return sides.some(
        ([side, other]) =>
          referencedName(unwrap(side)) === elementName &&
          !namesIn(other).some((each) => parameters.has(each)),
      )
    })
  }

  for (const node of nodes(sf)) {
    if (ts.isCallExpression(node) && membership(node)) {
      out.push(siteOf(sf, file.file, node))
      continue
    }
    // `projectId in reachSet` — the operator form of the same question.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      isReachList(node.right, aliases) &&
      namesIn(node.left).some((each) => ASKS_ABOUT_ONE_PROJECT.test(each) && !aliases.has(each))
    ) {
      out.push(siteOf(sf, file.file, node))
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Rule: which address does this placement answer to
// ---------------------------------------------------------------------------

const ADDRESSED_LOCATOR_FIELDS = ['source', 'kind', 'packageId', 'location'] as const

/** Object literals bound to a name in this file, so a spread of one can be followed. */
const literalsByName = (sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> => {
  const found = new Map<string, ts.ObjectLiteralExpression>()

  for (const node of nodes(sf)) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const value = unwrap(node.initializer)

      if (ts.isObjectLiteralExpression(value)) {
        found.set(node.name.text, value)
      }
    }
  }

  return found
}

/** The fields an object expression CARRIES, following one hop of `{ ...base, … }` and
 *  through `Object.assign(a, b)`. Splitting a literal in two is the cheapest way to
 *  fall out of a whole-literal match, so the halves are put back together here. */
const propertyNamesOf = (
  expression: ts.Expression,
  bound: ReadonlyMap<string, ts.ObjectLiteralExpression>,
  depth = 0,
): Set<string> => {
  const names = new Set<string>()
  const value = unwrap(expression)

  if (ts.isIdentifier(value)) {
    const literal = depth < 3 ? bound.get(value.text) : undefined

    return literal ? propertyNamesOf(literal, bound, depth + 1) : names
  }
  if (ts.isCallExpression(value) && referencedName(value.expression) === 'assign') {
    for (const argument of value.arguments) {
      for (const name of propertyNamesOf(argument, bound, depth + 1)) {
        names.add(name)
      }
    }

    return names
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return names
  }
  for (const property of value.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text)
      continue
    }
    if (ts.isSpreadAssignment(property) && depth < 3) {
      for (const name of propertyNamesOf(property.expression, bound, depth + 1)) {
        names.add(name)
      }
      continue
    }
    if (!ts.isPropertyAssignment(property)) {
      continue
    }
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
      names.add(property.name.text)
      continue
    }
    if (
      ts.isComputedPropertyName(property.name) &&
      ts.isStringLiteralLike(property.name.expression)
    ) {
      names.add(property.name.expression.text)
    }
  }

  return names
}

/** Every expression that IS an addressed ability locator, spelled out: the
 *  discriminator, the kind, the package and the placement carried together. The
 *  property SET is the match, so field order, shorthand, quoting style,
 *  `ABILITY_SOURCE.owned` versus `'owned'`, a template string in a value and a
 *  factory call for the placement are all the same node. */
export const addressedLocatorLiterals: Matcher = (file) => {
  if (!mentions(file, PACKAGE_ADDRESS)) {
    return []
  }
  const sf = parse(file)
  const bound = literalsByName(sf)
  const out: Site[] = []
  // Pre-order, so an outer `Object.assign(…)` claims the halves it merged rather than
  // reporting the same mint twice.
  const claimed: Array<{ start: number; end: number }> = []

  for (const node of nodes(sf)) {
    const isCandidate =
      ts.isObjectLiteralExpression(node) ||
      (ts.isCallExpression(node) && referencedName(node.expression) === 'assign')

    if (
      !isCandidate ||
      claimed.some((range) => node.getStart(sf) >= range.start && node.getEnd() <= range.end)
    ) {
      continue
    }
    const names = propertyNamesOf(node as ts.Expression, bound)

    if (ADDRESSED_LOCATOR_FIELDS.every((field) => names.has(field))) {
      claimed.push({ start: node.getStart(sf), end: node.getEnd() })
      out.push(siteOf(sf, file.file, node))
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Rule: what a skill may be called
// ---------------------------------------------------------------------------

/** The skill-name pattern, with every quantifier BODY erased. Two spellings of the
 *  same alphabet differing only in their bounds — `[a-z0-9-]*` against `[a-z0-9-]{0,62}`
 *  — are the same rule stated twice, and the second is how the length half went
 *  missing: the charset was copied and the bound was not. */
const SKILL_NAME_SHAPE = '/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/'

/** The PATTERN a regex literal states, with everything that is not the pattern removed:
 *  its delimiters, its FLAGS, and its quantifier bodies.
 *
 *  Flags are stripped because they were the whole bypass. A live fifth author of this
 *  rule sat in the tree behind a single `/u`, invisible to a matcher that compared the
 *  literal's text — and `/i` is worse than invisible, it WIDENS the domain while
 *  reading as the same rule. Quantifier bodies go for the neighbouring reason: two
 *  spellings of one alphabet differing only in their bounds are the same rule twice,
 *  and the copy that dropped the length half is exactly how the bound went missing. */
const patternOf = (literal: string): string =>
  literal
    .replace(/^\/|\/[a-z]*$/gu, '')
    .replace(/\{[^}]*\}/gu, '*')
    .replace(/\s+/gu, '')

/** Every place that decides what a skill may be CALLED, other than the one predicate
 *  that owns the domain. Three files carried this pattern and only one of them carried
 *  its length, so a label past the wire's bound was read as an exact attachment and the
 *  detail door answered 500 for a package the host called valid.
 *
 *  What it sees: the pattern, however its quantifiers are written or quoted. What it
 *  does NOT see, stated because a silent limit is the whole failure mode this register
 *  exists for: a rule expressed some other way entirely — a character-by-character
 *  loop, a `Set` of allowed characters, a bare `length <= 64` with no alphabet. The
 *  length alone is deliberately not matched: it is not this rule, and flagging it would
 *  put every unrelated bound in the register. */
export const skillNameDomains: Matcher = (file) => {
  if (!file.text.includes('a-z0-9')) {
    return []
  }
  const sf = parse(file)
  const out: Site[] = []

  for (const node of nodes(sf)) {
    const text = ts.isRegularExpressionLiteral(node)
      ? node.getText(sf)
      : ts.isStringLiteralLike(node)
        ? `/${node.text}/`
        : null

    if (text && patternOf(text) === patternOf(SKILL_NAME_SHAPE)) {
      out.push(siteOf(sf, file.file, node))
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Rule: what is a package address
// ---------------------------------------------------------------------------

const PACKAGE_ADDRESS = 'packageId'
const BOUND_NAME = /(MAX|MIN|LEN|LENGTH|LIMIT|SIZE)$/

const packageAddressAliases = (sf: ts.SourceFile): Set<string> => {
  const aliases = new Set<string>([PACKAGE_ADDRESS])

  for (const node of nodes(sf)) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const source = referencedName(unwrap(node.initializer))

      if (source && aliases.has(source)) {
        aliases.add(node.name.text)
      }
    }
  }

  return aliases
}

const isPackageAddress = (node: ts.Node, aliases: ReadonlySet<string>): boolean => {
  const name = referencedName(node)

  return name !== null && aliases.has(name)
}

/** Numeric literals that CONSTRAIN rather than index: `locator[2]` is not a domain. */
const constrainingNumbers = (root: ts.Node): ts.Node[] =>
  nodes(root).filter(
    (node) =>
      (ts.isNumericLiteral(node) &&
        !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)) ||
      ts.isRegularExpressionLiteral(node),
  )

/** Every place that decides what a package address IS, other than the one predicate
 *  that owns the domain. The cancelled generation bounded it by length alone; the
 *  domain is now the exact form a host mints, and a length or a pattern spelled at a
 *  site is a second answer that can only ever be wider. */
export const packageAddressDomains: Matcher = (file) => {
  if (!mentions(file, PACKAGE_ADDRESS)) {
    return []
  }
  const sf = parse(file)
  const aliases = packageAddressAliases(sf)
  const out: Site[] = []

  for (const node of nodes(sf)) {
    // `packageId.length` — a length is the cancelled domain, whatever it is compared to.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'length' &&
      isPackageAddress(node.expression, aliases)
    ) {
      out.push(siteOf(sf, file.file, node.parent))
      continue
    }
    if (ts.isCallExpression(node)) {
      const args = [...node.arguments]
      const carriesAddress = args.some((argument) => isPackageAddress(argument, aliases))
      const bounded = args.some(
        (argument) =>
          ts.isNumericLiteral(argument) ||
          ts.isRegularExpressionLiteral(argument) ||
          (ts.isIdentifier(argument) && BOUND_NAME.test(argument.text)),
      )

      if (carriesAddress && bounded) {
        out.push(siteOf(sf, file.file, node))
        continue
      }
      // `/…/.test(packageId)` and `packageId.match(/…/)` — a pattern is a domain too.
      const callee = calleeName(node)
      const receiver = receiverOf(node)

      if (
        (callee === 'test' && carriesAddress && receiver && constrainingNumbers(receiver).length) ||
        (callee === 'match' && receiver && isPackageAddress(receiver, aliases))
      ) {
        out.push(siteOf(sf, file.file, node))
      }
      continue
    }
    // A schema field: the wire may state the address by NAMING the one schema, never
    // by describing it again.
    if (ts.isPropertyAssignment(node) && referencedName(node.name as ts.Node) === PACKAGE_ADDRESS) {
      const declared = namesIn(node.initializer)
      const describesItself =
        constrainingNumbers(node.initializer).length > 0 ||
        (declared.includes('z') && !declared.some((each) => /PackageIdSchema$/.test(each)))

      if (describesItself) {
        out.push(siteOf(sf, file.file, node))
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Rule: which placements did the service derive
// ---------------------------------------------------------------------------

const BRANDED_PLACEMENT = /\bAddressed(Project)?Placement\b/

/** Every cast that FORGES the addressed-placement brand. The brand is the compiler's
 *  only statement that a placement was derived by the service rather than handed in by
 *  a client, and a cast is the one way to produce it without deriving it. */
export const placementBrandForgeries: Matcher = (file) => {
  if (!mentions(file, 'AddressedPlacement') && !mentions(file, 'AddressedProjectPlacement')) {
    return []
  }
  const sf = parse(file)

  return nodes(sf).flatMap((node) => {
    const type = ts.isAsExpression(node)
      ? node.type
      : ts.isTypeAssertionExpression(node)
        ? node.type
        : ts.isSatisfiesExpression(node)
          ? node.type
          : null

    return type && BRANDED_PLACEMENT.test(type.getText(sf)) ? [siteOf(sf, file.file, node)] : []
  })
}

// ---------------------------------------------------------------------------
// Call register: the producer is asked from exactly these places
// ---------------------------------------------------------------------------

/** Every call of the named producer. A comment that mentions it, a docblock that
 *  names it and a same-named helper in another package are not calls — the parser
 *  answers that question, which is the half a text scan got wrong in both directions. */
export const callSitesOf =
  (producer: string): Matcher =>
  (file) => {
    if (!mentions(file, producer)) {
      return []
    }
    const sf = parse(file)

    return nodes(sf).flatMap((node) => {
      if (!ts.isCallExpression(node)) {
        return []
      }
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null

      return name === producer ? [siteOf(sf, file.file, node)] : []
    })
  }

/** Run a matcher over a surface and return the sites, addressed and sorted. */
export const sitesOf = (matcher: Matcher, surface: readonly ScannedFile[]): Site[] =>
  surface
    .flatMap((file) => matcher(file))
    .sort((a, b) => a.at.localeCompare(b.at) || a.line - b.line)

/** The distinct `file#symbol` addresses a matcher found. */
export const addressesOf = (matcher: Matcher, surface: readonly ScannedFile[]): string[] => [
  ...new Set(sitesOf(matcher, surface).map((site) => site.at)),
]

/** A matcher run against a snippet — how the register proves each rule reddens on a
 *  real second spelling, and states which rewrites it does NOT catch. */
export const matchesSnippet = (matcher: Matcher, code: string): boolean =>
  matcher({ file: 'fixture.ts', text: code }).length > 0
