# @notarium/desktop

A stub for the Electron shell — deliberately empty at MVP (see `docs/architecture.md`, the Desktop vs Cloud map).

When the milestone arrives: the core in the main process (the Joplin pattern), the engine — a lite `KnowledgeStore` implementation (deductions from `@notarium/engine-memory` + an fs-scan/persistence via better-sqlite3+FTS5), the gap with cloud closed by the `test/store-contract` contract tests.
