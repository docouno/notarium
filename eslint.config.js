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
            'packages/core/src/{cachedStore,graph,identity,importer,knowledgeStore,listing,revisionJournal,semanticOps,snippet,visibility}/**',
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
