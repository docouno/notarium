import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

export const ACTIVITY_GROUP_PRODUCTION_LAYERS = [
  'rest-wire',
  'cached-store',
  'history-surface',
  'revision-journal',
  'sqlite-driver',
  'postgres-driver',
] as const

export type ActivityGroupProductionLayer = (typeof ACTIVITY_GROUP_PRODUCTION_LAYERS)[number]
export type ActivityGroupProductionSources = Record<ActivityGroupProductionLayer, string>

export type ActivityGroupsSourceAudit = {
  bodyReads: number
  rawRevisionMaterializations: number
  queryPerGroup: number
  duplicateOverviewScans: number
  missingProductionLayers: ActivityGroupProductionLayer[]
}

const between = (source: string, start: string, end: string, layer: string): string => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)

  if (from < 0 || to < 0) {
    throw new Error(`Activity source boundary ${layer} was not found`)
  }

  return source.slice(from, to)
}

/** Load only the exact production chain whose latency/result the gate claims.
 * Tests mutate these extracted real sections; no synthetic sample is accepted as
 * evidence for a forbidden strategy. */
export const loadActivityGroupProductionSources = (
  root = resolve('.'),
): ActivityGroupProductionSources => {
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
  const route = read('packages/server/src/apps/server/routes/activity/activity.ts')
  const cached = read('packages/core/src/cachedStore/cachedStore.ts')
  const history = read('packages/core/src/cachedStore/helpers/historySurface/historySurface.ts')
  const journal = read('packages/core/src/revisionJournal/revisionJournal.ts')
  const sqlite = read('packages/server/src/services/metaDb/drivers/sqlite/revisions.ts')
  const postgres = read('packages/server/src/services/metaDb/drivers/pg/revisions.ts')

  return {
    'rest-wire': between(
      route,
      "app.get(s('/activity/groups')",
      "app.get(s('/activity/events')",
      'rest-wire',
    ),
    'cached-store': between(
      cached,
      '  activityGroups(opts:',
      '  activityProjection(opts?:',
      'cached-store',
    ),
    'history-surface': between(
      history,
      '  async activityGroups(opts:',
      '  /** Per-note activity counts',
      'history-surface',
    ),
    'revision-journal': between(
      journal,
      '  async activityGroupsByNote(opts:',
      '  private requestedActivityLease(',
      'revision-journal',
    ),
    'sqlite-driver': between(sqlite, 'activityGroupsByNote:', 'activityByNote:', 'sqlite-driver'),
    'postgres-driver': between(
      postgres,
      'activityGroupsByNote:',
      'activityByNote:',
      'postgres-driver',
    ),
  }
}

const requiredBoundaries: Record<ActivityGroupProductionLayer, readonly string[]> = {
  'rest-wire': ['store.activityGroups({', 'ActivityGroupsResponseSchema.parse'],
  'cached-store': ['this.trash.activityGroups(opts)'],
  'history-surface': [
    'this.host.activityProjection(scope)',
    'this.host.journal.activityGroupsByNote',
  ],
  'revision-journal': ['this.persistence.activityGroupsByNote', 'encodeActivityVersion'],
  'sqlite-driver': ['bucket_states AS', 'activityLease'],
  'postgres-driver': ['bucket_states AS', 'activityLease'],
}

const wrapped = (layer: ActivityGroupProductionLayer, source: string): string =>
  layer === 'sqlite-driver' || layer === 'postgres-driver'
    ? `const facet = { ${source} activityByNote: undefined }`
    : layer === 'rest-wire'
      ? source
      : `class ProductionBoundary { ${source} }`

const productionAst = (layer: ActivityGroupProductionLayer, source: string): ts.SourceFile =>
  ts.createSourceFile(
    `${layer}.ts`,
    wrapped(layer, source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  parseDiagnostics?: readonly ts.Diagnostic[]
}

export const activityGroupProductionSyntaxFailures = (
  source: ActivityGroupProductionSources,
): string[] =>
  ACTIVITY_GROUP_PRODUCTION_LAYERS.flatMap((layer) => {
    const ast = productionAst(layer, source[layer]) as SourceFileWithParseDiagnostics

    return (ast.parseDiagnostics ?? []).map(
      (diagnostic) => `${layer}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    )
  })

const QUERY_METHODS = new Set([
  'activityEvents',
  'activityGroups',
  'activityGroupsByNote',
  'prepare',
  'query',
  'read',
])

const ARRAY_ITERATION_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
])

const isQueryCall = (node: ts.Node, aliases: ReadonlySet<string>): boolean =>
  ts.isCallExpression(node) &&
  ((ts.isPropertyAccessExpression(node.expression) &&
    QUERY_METHODS.has(node.expression.name.text)) ||
    (ts.isIdentifier(node.expression) && aliases.has(node.expression.text)))

const isQueryReference = (node: ts.Node, aliases: ReadonlySet<string>): boolean =>
  isQueryCall(node, aliases) ||
  (ts.isIdentifier(node) && QUERY_METHODS.has(node.text)) ||
  (ts.isIdentifier(node) && aliases.has(node.text)) ||
  (ts.isPropertyAccessExpression(node) && QUERY_METHODS.has(node.name.text))

const isRevisionMaterializerReference = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) && node.text === 'revisionOfRow') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'revisionOfRow')

const isArrayIteration = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ARRAY_ITERATION_METHODS.has(node.expression.name.text)

const isPromiseFanout = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'Promise' &&
  ['all', 'allSettled', 'any', 'race'].includes(node.expression.name.text)

const containsNode = (root: ts.Node, predicate: (node: ts.Node) => boolean): boolean => {
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) {
      return
    }
    if (predicate(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

const hasDescendant = (root: ts.Node, predicate: (node: ts.Node) => boolean): boolean => {
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) {
      return
    }
    if (node !== root && predicate(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(root, visit)
  return found
}

const isLiteralBoundedFor = (node: ts.ForStatement): boolean =>
  !!node.condition &&
  ts.isBinaryExpression(node.condition) &&
  [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(
    node.condition.operatorToken.kind,
  ) &&
  ts.isNumericLiteral(node.condition.right)

// Query-per-group loops iterate a collection in any control-flow spelling. The
// production location-consistency retry is the one ordinary `for` with a literal
// bound (`attempt < 2`); excluding literal-bounded retries keeps that one query
// honest without exempting indexed `i < groups.length`, while or do loops.
const isCollectionLoop = (node: ts.Node): boolean =>
  ts.isForInStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node) ||
  (ts.isForStatement(node) && !isLiteralBoundedFor(node))

const queryAliasesOf = (ast: ts.SourceFile): Set<string> => {
  const aliases = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      containsNode(node.initializer, (candidate) => isQueryReference(candidate, new Set<string>()))
    ) {
      aliases.add(node.name.text)
    }
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      ((node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        QUERY_METHODS.has(node.propertyName.text)) ||
        (!node.propertyName && QUERY_METHODS.has(node.name.text)))
    ) {
      aliases.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(ast)
  return aliases
}

const countOverviewQueries = (ast: ts.SourceFile): number => {
  let queries = 0

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      /\bactivity_note_actor_heads\b/i.test(node.getText(ast)) &&
      /\bactivity_note_actor_states\b/i.test(node.getText(ast))
    ) {
      queries++
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return queries
}

const structuralAudits = (source: ActivityGroupProductionSources) => {
  let rawRevisionMaterializations = 0
  let queryPerGroup = 0

  for (const layer of ACTIVITY_GROUP_PRODUCTION_LAYERS) {
    const ast = productionAst(layer, source[layer])
    const queryAliases = queryAliasesOf(ast)
    const queryCall = (node: ts.Node) => isQueryCall(node, queryAliases)
    const queryReference = (node: ts.Node) => isQueryReference(node, queryAliases)

    const visit = (node: ts.Node): void => {
      if (
        isArrayIteration(node) &&
        node.arguments.some((argument) => containsNode(argument, isRevisionMaterializerReference))
      ) {
        rawRevisionMaterializations++
      }
      if (
        (isCollectionLoop(node) && hasDescendant(node, queryCall)) ||
        (isArrayIteration(node) &&
          node.arguments.some((argument) => containsNode(argument, queryReference))) ||
        (isPromiseFanout(node) &&
          node.arguments.some((argument) => containsNode(argument, queryReference)))
      ) {
        queryPerGroup++
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }

  return { rawRevisionMaterializations, queryPerGroup }
}

export const auditActivityGroupSections = (
  source: ActivityGroupProductionSources,
): ActivityGroupsSourceAudit => {
  const drivers = structuralAudits(source)
  const driverAsts = (['sqlite-driver', 'postgres-driver'] as const).map((layer) =>
    productionAst(layer, source[layer]),
  )

  return {
    bodyReads: Object.values(source).filter((section) => section.includes('revision_blobs')).length,
    ...drivers,
    duplicateOverviewScans: driverAsts.reduce(
      (duplicates, ast) => duplicates + Math.max(0, countOverviewQueries(ast) - 1),
      0,
    ),
    missingProductionLayers: ACTIVITY_GROUP_PRODUCTION_LAYERS.filter((layer) =>
      requiredBoundaries[layer].some((boundary) => !source[layer].includes(boundary)),
    ),
  }
}

export type ActivityGroupForbiddenMutation =
  'eager-raw-array' | 'query-per-group' | 'duplicate-scan'

const insertBeforeLastBrace = (source: string, insertion: string): string => {
  const at = source.lastIndexOf('}')

  if (at < 0) {
    throw new Error('Activity production section has no mutation boundary')
  }

  return `${source.slice(0, at)}\n${insertion}\n${source.slice(at)}`
}

/** Mutation operators install each rejected strategy into a real production
 * boundary. The negative suite passes only if the structural gate turns red on
 * that executable chain while the unmodified source stays green. */
export const mutateActivityGroupProductionSource = (
  source: ActivityGroupProductionSources,
  mutation: ActivityGroupForbiddenMutation,
): ActivityGroupProductionSources => {
  if (mutation === 'query-per-group') {
    const mutated = {
      ...source,
      'history-surface': insertBeforeLastBrace(
        source['history-surface'],
        'const forbiddenGroups: unknown[] = []; for (let forbiddenIndex = 0; forbiddenIndex < forbiddenGroups.length; forbiddenIndex++) { await this.host.journal.activityGroupsByNote({} as never) }',
      ),
    }

    if (activityGroupProductionSyntaxFailures(mutated).length) {
      throw new Error('Query-per-group production mutation is not parse-clean')
    }

    return mutated
  }

  const mutated = {
    ...source,
    'postgres-driver': insertBeforeLastBrace(
      source['postgres-driver'],
      mutation === 'eager-raw-array'
        ? 'const forbiddenRaw = rows.map((row) => revisionOfRow(row)); void forbiddenRaw'
        : 'const duplicateOverview = `WITH alternate_actor_states AS (SELECT states.* FROM activity_note_actor_heads AS heads JOIN activity_note_actor_states AS states ON states.space = heads.space AND states.generation = heads.generation) SELECT * FROM alternate_actor_states`; await client.query(duplicateOverview)',
    ),
  }

  if (activityGroupProductionSyntaxFailures(mutated).length) {
    throw new Error(`${mutation} production mutation is not parse-clean`)
  }

  return mutated
}
