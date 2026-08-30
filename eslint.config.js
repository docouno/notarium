// Repo-wide lint. The load-bearing part is eslint-plugin-boundaries: the layering
// (package layers apps/services/libs, the web UI levels, and core's domain concerns)
// is enforced here, not by discipline — unidirectional architecture without
// enforcement does not survive (#19). Code-organization canon lives outside the repo.

import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import prettierConfig from 'eslint-config-prettier'
import boundaries from 'eslint-plugin-boundaries'
import importPlugin from 'eslint-plugin-import'
import perfectionist from 'eslint-plugin-perfectionist'
import preferArrow from 'eslint-plugin-prefer-arrow-functions'
import reactHooks from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const PROVIDER_FACET_WRITE =
  /\bUPDATE\s+(?:credentials|provider_resources)(?:\s+AS\s+\w+)?\s+SET\b/iu
const PROVIDER_FACET_WRITE_OWNERS = [
  '/services/metaDb/drivers/sqlite/credentials.ts',
  '/services/metaDb/drivers/pg/credentials.ts',
  '/services/metaDb/drivers/sqlite/providerResources.ts',
  '/services/metaDb/drivers/pg/providerResources.ts',
  '/services/metaDb/drivers/sqlite/providerCiphertexts.ts',
  '/services/metaDb/drivers/pg/providerCiphertexts.ts',
  '/services/metaDb/sqliteMetaDb.ts',
  '/services/metaDb/pgMetaDb.ts',
]

const providerEpochPlugin = {
  rules: {
    'owned-facet-writes': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          owner:
            'Write provider credential/resource columns through their driver facet; retarget, re-encryption and purge-unreadable are the only named system exceptions.',
        },
      },
      create(context) {
        const filename = context.filename.replaceAll('\\', '/')
        const ownsWrite = PROVIDER_FACET_WRITE_OWNERS.some((suffix) => filename.endsWith(suffix))
        const inspect = (node, value) => {
          if (!ownsWrite && typeof value === 'string' && PROVIDER_FACET_WRITE.test(value)) {
            context.report({ node, messageId: 'owner' })
          }
        }

        return {
          Literal: (node) => inspect(node, node.value),
          TemplateElement: (node) => inspect(node, node.value.raw),
        }
      },
    },
  },
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'temp/**',
      'docker/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node contexts: configs, scripts, tests.
  {
    files: ['*.config.{js,ts}', 'packages/*/vite.config.js', 'scripts/**', 'test/**'],
    languageOptions: { globals: globals.node },
  },

  // Web SPA: browser globals + hooks correctness. Deliberately the two classic
  // react-hooks rules only — the compiler-era set (set-state-in-effect, refs)
  // flagged exactly the god-component patterns #19 step 6 dismantled. That split is now
  // done, so the set is unblocked; enabling it is folded into the lint task (#56).
  {
    files: ['packages/web/src/**/*.{js,jsx,ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Browser alerts/logs have no place in the SPA: dialogs go through
      // useDialog(), errors through the banner/state. (The server still logs
      // via console until pino lands — not enabled there.)
      'no-alert': 'error',
      'no-console': 'error',
    },
  },

  // Provider consent epochs are default-fail-closed by WRITE OWNER. Every SQL write
  // to the two mutable facets stays in their driver modules; the two facade retarget
  // methods and providerCiphertexts' re-encryption/recovery paths are the three named
  // exceptions. The companion source registry classifies each owned method.
  {
    files: ['packages/server/src/**/*.ts'],
    plugins: { 'provider-epochs': providerEpochPlugin },
    rules: { 'provider-epochs/owned-facet-writes': 'error' },
  },

  // Keep the contract's zod barrel out of the browser bundle (#56). Web takes
  // runtime dictionaries from the zod-free `@notarium/contract/enums` subpath;
  // the root `@notarium/contract` is TYPE-ONLY here (types erase, so no zod
  // reaches the SPA chunk). A value import from the root re-drags zod + every
  // schema into the initial chunk and breaks the production build (Workbox 2 MiB).
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@notarium/contract',
              allowTypeImports: true,
              message:
                'web: import runtime values from @notarium/contract/enums (zod-free); the root is type-only here — a value import drags zod into the SPA bundle (#56).',
            },
          ],
        },
      ],
    },
  },

  // core ↔ contract stay DECOUPLED: a domain enum both layers need lives as two
  // independent const-object copies, reconciled by test/enumDrift.test.ts rather than
  // by an import. The one sanctioned edge is TYPE-ONLY — types erase, so core still
  // ships without contract at runtime, and a type it borrows cannot drift from the
  // schema the way a copied one can. A VALUE import is the thing that would make the
  // two packages one, so it is the thing this refuses.
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@notarium/contract',
              allowTypeImports: true,
              message:
                'core: @notarium/contract is TYPE-ONLY here — core and contract are decoupled packages, and a runtime value shared between them lives as two copies gated by test/enumDrift.test.ts.',
            },
          ],
          patterns: [
            {
              group: ['@notarium/contract/*'],
              message:
                'core: @notarium/contract is TYPE-ONLY here — core and contract are decoupled packages, and a runtime value shared between them lives as two copies gated by test/enumDrift.test.ts.',
            },
          ],
        },
      ],
    },
  },

  // Consts purity (#56): consts/ is the zod-free SINK — no zod, no schema imports; a value
  // type derives from its dict via (typeof X)[keyof typeof X], never z.infer / keyof<schema>
  // / `satisfies Record<…, SchemaType>`. Locks the one-way schema→const dependency, which
  // STORE_EVENT/QUERY_KEY once inverted. Covers contract consts/ + every core `consts.ts`.
  {
    files: ['packages/contract/src/consts/**/*.ts', 'packages/core/src/**/consts.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['zod', '**/schemas/**', '**/registry', '@notarium/contract'],
              message:
                'consts/ is a pure zod-free sink (#56): no zod, no schema imports. Derive types from the dict — type X = (typeof X)[keyof typeof X].',
            },
          ],
        },
      ],
    },
  },

  // ── Shared baseline ESLint config: the semantic subset ──────────────────────
  // Adopted: the layer that matches the code-organization canon (types/imports/enum/
  // exports) plus correctness rules. NOT adopted: the formatting layer (semi,
  // perfectionist sorts, func-style/prefer-arrow, padding-line-between-
  // statements) — it conflicts with the codebase style (no semicolons, function
  // declarations) and would mean mechanically reformatting the whole repo;
  // typeChecked unsafe-* — #19 made web fully TS (no JS/any imports), so this is
  // now unblocked and folded into the lint task (#56); camelcase properties — the
  // domain deliberately mirrors wire snake_case until #54; naming-convention/
  // id-length — deferred to the formatting-layer task as well.
  {
    files: ['packages/*/src/**/*.{js,jsx,ts,tsx}', 'test/**/*.ts', 'scripts/**'],
    plugins: { 'unused-imports': unusedImports },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }], // `x != null` is the null|undefined idiom
      'no-debugger': 'error',
      'no-sequences': 'error',
      'no-new-wrappers': 'error',
      'no-extend-native': 'error',
      'no-implied-eval': 'error',
      'no-useless-concat': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-unexpected-multiline': 'error',
      'array-callback-return': 'error',
      'max-classes-per-file': ['error', 1],
      'unused-imports/no-unused-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use objects with `as const` instead of enum' },
      ],
    },
  },
  // ── Postgres lock order, layer 0: a tiered lock is taken through a helper ────
  // The meta-DB's lock hierarchy is stated in ONE module
  // (services/metaDb/drivers/pg/lockOrder.ts, with the revision stripes in
  // revisionLocks.ts) and checked by test/meta-db-contract/pgLockOrder.test.ts. That
  // check can only recognize a lock it can name, so the locks have to come from a
  // finite surface: 15 of the 21 tiered lock statements used to be inline
  // `client.query`, in 15 shapes, two of them assembled by interpolation and carrying
  // no text at all. This rule is what makes the surface finite (#327).
  //
  // The selector matches the CALLED MEMBER `.query`, not a receiver named `client`:
  // half the driver goes through `ctx.required.query`, and a rule keyed to a variable
  // name would leave a hole in its own foundation.
  //
  // A non-tiered lock (the setup mutex, the jobs queue, an OAuth client table, a
  // session row, a spaces row) is exempt where it stands, with the reason inline —
  // it is outside the hierarchy, so it constrains nothing and no helper owns it. The
  // exemption is only as true as its table's absence from `LOCK_LEVEL_OF_TABLE`, and
  // that is a moving target: `folders` acquired a level (L4f) with tier 4, which made
  // the inline `FOR KEY SHARE` in `agentDeltaCursors` a tiered lock with a stale note
  // saying otherwise. Adding a table to the tier map means auditing the exemptions
  // that name it; the live gate in `pgLockOrder.test.ts` now levels a lock statement
  // by its table too, so the second half no longer depends on this comment.
  //
  // A narrow `files` block REPLACES `no-restricted-syntax` wholesale for the files it
  // matches, so the repo-wide `TSEnumDeclaration` ban above is repeated here.
  {
    files: [
      'packages/server/src/services/metaDb/drivers/pg/**/*.ts',
      'packages/server/src/services/metaDb/pgMetaDb.ts',
      'packages/server/src/services/metaDb/migrations/runPgMigrations.ts',
    ],
    ignores: [
      'packages/server/src/services/metaDb/drivers/pg/lockOrder.ts',
      'packages/server/src/services/metaDb/drivers/pg/revisionLocks.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use objects with `as const` instead of enum' },
        {
          selector:
            "CallExpression[callee.property.name='query'] > Literal[value=/FOR\\s+(NO\\s+KEY\\s+)?UPDATE|FOR\\s+(KEY\\s+)?SHARE|pg_advisory|LOCK\\s+TABLE/i]",
          message:
            'Take a tiered lock through drivers/pg/lockOrder (or revisionLocks) — the order is stated and checked there, and a lock taken here is invisible to both (#327).',
        },
        {
          selector:
            "CallExpression[callee.property.name='query'] > TemplateLiteral > TemplateElement[value.raw=/FOR\\s+(NO\\s+KEY\\s+)?UPDATE|FOR\\s+(KEY\\s+)?SHARE|pg_advisory|LOCK\\s+TABLE/i]",
          message:
            'Take a tiered lock through drivers/pg/lockOrder (or revisionLocks) — the order is stated and checked there, and a lock taken here is invisible to both (#327).',
        },
        {
          selector: "CallExpression[callee.property.name='push'] > SpreadElement",
          message:
            'Spreading an array into arguments throws RangeError past ~125k elements (a function of remaining stack, not a constant). Where the length is a function of user data, push in a loop; where it is provably bounded, disable inline and name the bound.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(min|max)$/] > SpreadElement",
          message:
            'Spreading an array into arguments throws RangeError past ~125k elements (a function of remaining stack, not a constant). Where the length is a function of user data, fold with a loop/reduce; where it is provably bounded, disable inline and name the bound.',
        },
      ],
    },
  },
  // ── Spread-into-arguments, server-side (#392) ────────────────────────────────
  // The boundary criterion: these packages hold code whose ARRAY LENGTHS are a
  // function of user data — document bytes, document lines, corpus rows, import
  // batches — and an argument spread caps such an array at V8's argument limit
  // (~125k, itself a function of remaining stack). `web` is excluded on the same
  // criterion, not leniency: there an array length is a function of layout. Honest
  // limit of the rule: it bans the two FORMS that have fired (`.push(...)`,
  // `Math.min/max(...)`), not the class — a plain `f(...xs)` passes.
  //
  // A narrow `files` block REPLACES `no-restricted-syntax` wholesale for its files,
  // so the repo-wide `TSEnumDeclaration` ban is repeated here, the pg-block's files
  // are ignored here to keep the lock-order selectors (#327) alive for them (that
  // block carries these two selectors itself), and the pg-block's OWN ignores —
  // lockOrder.ts / revisionLocks.ts — get the third block below: skipped by both
  // narrow blocks, they would otherwise carry no spread rule at all, and they are
  // exactly where the next batch-shaped lock helper will be written.
  {
    files: ['packages/{core,engine,engine-memory,server}/src/**/*.ts'],
    ignores: [
      'packages/server/src/services/metaDb/drivers/pg/**/*.ts',
      'packages/server/src/services/metaDb/pgMetaDb.ts',
      'packages/server/src/services/metaDb/migrations/runPgMigrations.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use objects with `as const` instead of enum' },
        {
          selector: "CallExpression[callee.property.name='push'] > SpreadElement",
          message:
            'Spreading an array into arguments throws RangeError past ~125k elements (a function of remaining stack, not a constant). Where the length is a function of user data, push in a loop; where it is provably bounded, disable inline and name the bound.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(min|max)$/] > SpreadElement",
          message:
            'Spreading an array into arguments throws RangeError past ~125k elements (a function of remaining stack, not a constant). Where the length is a function of user data, fold with a loop/reduce; where it is provably bounded, disable inline and name the bound.',
        },
      ],
    },
  },
  {
    files: [
      'packages/server/src/services/metaDb/drivers/pg/lockOrder.ts',
      'packages/server/src/services/metaDb/drivers/pg/revisionLocks.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use objects with `as const` instead of enum' },
        {
          selector: "CallExpression[callee.property.name='push'] > SpreadElement",
          message:
            'Spreading an array into arguments throws RangeError past ~125k elements (a function of remaining stack, not a constant). Where the length is a function of user data, push in a loop; where it is provably bounded, disable inline and name the bound.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(min|max)$/] > SpreadElement",
          message:
            'Spreading an array into arguments throws RangeError past ~125k elements (a function of remaining stack, not a constant). Where the length is a function of user data, fold with a loop/reduce; where it is provably bounded, disable inline and name the bound.',
        },
      ],
    },
  },

  {
    files: ['packages/*/src/**/*.{ts,tsx}', 'test/**/*.ts'],
    // d.ts: declaration merging (interface Window) is impossible without interface.
    ignores: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
    },
  },
  // Named exports only (conventions). Web is fully TS now, so this glob covers
  // every source file (no .jsx remain after #19).
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    plugins: { import: importPlugin },
    rules: { 'import/no-default-export': 'error' },
  },

  // ── Format layer (#56): Prettier + the structural rules it can't do ──────────
  // The formatting layer #19 deferred, decided in #56. Prettier owns ALL whitespace,
  // wrapping, indentation and block expansion — a block body always lands on its own
  // line, so there are no crammed `if (x) { return a ?? b }` one-liners (formal braces
  // are NOT readability; the body-on-its-own-line is). Run `npm run format`. eslint
  // keeps only what Prettier does NOT do:
  //   • func-style → arrow (prefer-arrow-functions);
  //   • import ordering (perfectionist — imports ONLY; object keys and union members
  //     carry semantic order, e.g. h1..h6 / ReadScope widening, and are left be);
  //   • the blank lines Prettier won't insert (padding-line-between-statements).
  // Everything Prettier owns is turned off by eslint-config-prettier (below).
  {
    files: ['packages/*/src/**/*.{js,jsx,ts,tsx}', 'test/**/*.ts', 'scripts/**'],
    // .d.ts are ambient declarations (no bodies) — the arrow rule doesn't apply.
    ignores: ['**/*.d.ts'],
    plugins: { '@stylistic': stylistic, perfectionist, 'prefer-arrow-functions': preferArrow },
    rules: {
      'prefer-arrow-functions/prefer-arrow-functions': ['error', {}],
      'perfectionist/sort-imports': [
        'error',
        {
          type: 'natural',
          internalPattern: ['^@notarium/'],
          newlinesBetween: 'ignore',
          groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index'], 'style'],
        },
      ],
      'perfectionist/sort-named-imports': ['error', { type: 'natural' }],
      // Blank lines Prettier does not insert: after a declaration before the block
      // that follows it (no `const x = …` butting a bare `if` — #56 pt.1), and before
      // a return that follows a multiline block — air after a big if/for/try (pt.3).
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: 'block-like' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'return' },
      ],
    },
  },

  // Prettier owns whitespace/wrapping — turn off every eslint rule that would fight
  // it (semi, quotes, comma-dangle, indent, max-len, …). Must sit AFTER the rules above.
  prettierConfig,

  // curly:all IS Prettier-safe (Prettier respects braces, never adds them) but
  // eslint-config-prettier disables `curly` defensively — re-enable it here. Braces on
  // every `if` are what let Prettier then break the body onto its own line (#56).
  {
    files: ['packages/*/src/**/*.{js,jsx,ts,tsx}', 'test/**/*.ts', 'scripts/**'],
    ignores: ['**/*.d.ts'],
    rules: { curly: ['error', 'all'] },
  },

  // ── Boundaries: who may import whom ─────────────────────────────────────────
  {
    files: ['packages/*/src/**/*.{js,jsx,ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: ['packages/*/tsconfig.json'] } },
      'boundaries/elements': [
        // Package layers (conventions: apps → services → libs, one-directional).
        { type: 'apps', pattern: 'packages/*/src/apps/**' },
        { type: 'services', pattern: 'packages/*/src/services/**' },
        { type: 'libs', pattern: 'packages/*/src/libs/**' },
        // Core (backend-library tier): the domain concerns are
        // top-level modules, NOT a services/ bucket. Classifying them closes the
        // `default: allow` gap so the P9 agnostic-libs invariant is tool-enforced
        // (#56): `libs/` may not reach into a domain concern; concerns may use
        // libs + the knowledgeStore port + each other.
        {
          type: 'core-domain',
          pattern:
            'packages/core/src/{cachedStore,graph,identity,importer,knowledgeStore,listing,referenceResolver,revisionJournal,semanticOps,snippet,visibility}/**',
        },
        // Web UI levels (pages → layouts/composers → widgets → core). The
        // patterns pre-date the directories: rules activate as the #19 step 6
        // restructure moves components into them.
        { type: 'web-pages', pattern: 'packages/web/src/pages/**' },
        { type: 'web-layouts', pattern: 'packages/web/src/layouts/**' },
        { type: 'web-composers', pattern: 'packages/web/src/composers/**' },
        { type: 'web-widgets', pattern: 'packages/web/src/widgets/**' },
        { type: 'web-core', pattern: 'packages/web/src/core/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          rules: [
            { from: { type: 'libs' }, disallow: { to: { type: ['apps', 'services', 'core-domain'] } } },
            { from: { type: 'services' }, disallow: { to: { type: 'apps' } } },
            {
              from: { type: 'web-core' },
              disallow: {
                to: { type: ['web-widgets', 'web-composers', 'web-layouts', 'web-pages', 'services'] },
              },
            },
            {
              from: { type: 'web-widgets' },
              disallow: { to: { type: ['web-composers', 'web-layouts', 'web-pages', 'services'] } },
            },
            {
              from: { type: 'web-composers' },
              disallow: { to: { type: ['web-layouts', 'web-pages'] } },
            },
            { from: { type: 'web-layouts' }, disallow: { to: { type: 'web-pages' } } },
          ],
        },
      ],
    },
  },
)
