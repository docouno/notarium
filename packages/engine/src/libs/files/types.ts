// The engine's storage seam — P5's minimal contract in file form: enumerate,
// read, write, stat, move, delete. localfs is the only v1 backend (desktop =
// the user's folder, cloud v1 = the server volume); s3/seafile/webdav arrive
// with the working-set milestone (#70), behind this same seam.
// All paths are storage-relative POSIX ('dir/note.md'); the adapter owns
// mapping them onto its medium and refusing lexical escapes. LocalFS v1 assumes
// the configured vault directory topology itself is trusted (a symlinked parent
// inside that root needs a separate containment hardening boundary).

export type FileStat = {
  path: string
  mtimeMs: number
  size: number
  /** Adapter-opaque, cheap change hint obtained by the same stat/list operation.
   *  LocalFS combines device/inode/ctime; an object store can expose an etag.
   *  Equality is only a prefilter — content verification remains the arbiter. */
  changeToken?: string
  /** Creation time when the medium honestly knows it; null when it doesn't
   *  (filesystems without btime report nothing rather than a guess). */
  birthtimeMs: number | null
}

/** Adapter-opaque proof that one pathname was sampled in a particular state.
 * Claims are meaningful only for the resource and adapter that returned them;
 * callers compare the whole object and never parse `value`. Present and absent
 * claims intentionally occupy different domains. */
export type FileClaim = {
  kind: 'present' | 'absent'
  value: string
}

/** One stable physical sample. Bytes, claim and mtime are captured together —
 * assembling them from separate read/stat calls would let a racing replacement
 * produce a state that never existed on the medium. Non-regular entries are not
 * absence: a symlink/directory still owns the pathname and must fail closed. */
export type FileObservation =
  | {
      kind: 'present'
      bytes: Uint8Array
      claim: FileClaim & { kind: 'present' }
      mtimeMs: number | null
    }
  | {
      kind: 'absent'
      claim: FileClaim & { kind: 'absent' }
      mtimeMs: null
    }
  | {
      kind: 'occupied'
      claim: FileClaim & { kind: 'present' }
      entryType: 'directory' | 'other' | 'symlink'
      mtimeMs: number | null
    }
  | {
      kind: 'unavailable'
      reason: 'not-regular' | 'too-large' | 'unstable'
      mtimeMs: null
    }

export type FilePublicationRequest =
  | {
      kind: 'put'
      path: string
      content: Uint8Array
      expected: FileClaim
    }
  | {
      kind: 'move-put'
      sourcePath: string
      targetPath: string
      content: Uint8Array
      expectedSource: FileClaim & { kind: 'present' }
      expectedTarget: FileClaim & { kind: 'absent' }
    }

export type FilePackagePublicationRequest = {
  rootPath: string
  files: ReadonlyArray<{ path: string; content: Uint8Array }>
  expectedRoot: FileClaim & { kind: 'absent' }
}

export type FileProofTransition = {
  path: string
  before: FileClaim
  after: FileClaim
  mtimeMs: number | null
}

export type FilePublicationResult =
  | { status: 'conflict' }
  | {
      status: 'published'
      candidateHash: string
      transitions: FileProofTransition[]
    }

export type FileStrictStageRequest = {
  /** Stable operation id chosen by the causal metadata layer. */
  operationId: string
  /** Privacy-safe actor/request binding. LocalFS treats it as opaque. */
  binding: string
  path: string
  content: Uint8Array
  expected: FileClaim
}

export type FileStrictStageHeader = {
  operationId: string
  binding: string
  path: string
  expected: FileClaim
  candidateHash: string
}

export type FileStrictMutationReceipt = {
  operationId: string
  binding: string
  observationId: string
  semanticEventTime: string
  restartDurable: true
  candidateHash: string
  transitions: FileProofTransition[]
}

export type FileStrictStageState =
  | { status: 'missing' }
  | {
      status: 'staged' | 'publishing'
      stage: FileStrictStageHeader
    }
  | {
      status: 'published'
      stage: FileStrictStageHeader
      receipt: FileStrictMutationReceipt
    }
  | {
      status: 'failed-recoverable'
      stage: FileStrictStageHeader
      reason: string
      recoveryPaths: string[]
    }

export type FileStrictStageResult =
  | {
      status: 'accepted'
      created: boolean
      state: Exclude<FileStrictStageState, { status: 'missing' }>
    }
  | { status: 'idempotency-conflict' }

export type FileStrictPublicationResult =
  | { status: 'conflict'; stage: FileStrictStageHeader }
  | { status: 'published'; receipt: FileStrictMutationReceipt }
  | {
      status: 'failed-recoverable'
      stage: FileStrictStageHeader
      reason: string
      recoveryPaths: string[]
    }

export type FileStrictPublication = {
  /** False is a valid capability answer for process-only adapters. */
  readonly restartDurable: boolean
  stage(request: FileStrictStageRequest): Promise<FileStrictStageResult>
  inspect(operationId: string, binding: string): Promise<FileStrictStageState>
  publish(operationId: string, binding: string): Promise<FileStrictPublicationResult>
  /** Drop only a matching terminal/staged artifact after the metadata barrier. */
  discard(operationId: string, binding: string): Promise<boolean>
}

export type FileStore = {
  /** Every note file under the root, recursively. The full-inventory truth
   *  source (P3) — cheap by design: stats only. The engine independently
   *  source-verifies a bounded rotating subset. */
  scan(): Promise<FileStat[]>
  /** Every regular file under the root as raw bytes. A package/resource capability kept separate
   *  from scan(): the knowledge index remains Markdown-only, while a full export can preserve
   *  auxiliary files byte-for-byte. Paths are storage-relative POSIX. OPTIONAL: note-only or
   *  remote adapters may omit it and keep the legacy Markdown export path. */
  exportFiles?(): AsyncIterable<{ path: string; content: Uint8Array }>
  /** Every non-dot directory under the root, recursively (#97 directory channel).
   *  Space-relative POSIX paths, root ('') excluded. A SEPARATE walk from scan()
   *  — never mixed into the note FileStat[] (index = notes only, #78). This is
   *  what makes an empty folder first-class: the tree shows real on-disk dirs,
   *  not only the dirs notes happen to live in. */
  listDirs(): Promise<string[]>
  stat(path: string): Promise<FileStat | null>
  /** null = the file is gone (a stat/read race with an external delete is a
   *  normal answer, not an error). */
  read(path: string): Promise<string | null>
  /** Exact physical bytes from the same observation as read(). Optional only for legacy/remote
   * adapters; callers that need opaque-source fidelity degrade explicitly when it is absent. */
  readBytes?(path: string): Promise<Uint8Array | null>
  /** Exact physical observation for provenance-sensitive operations. Unlike
   * `readBytes`, this distinguishes absence from an occupied non-regular path
   * and binds bytes/change claim/mtime to one stable adapter sample. */
  observe?(path: string, options?: { maxBytes?: number }): Promise<FileObservation>
  /** Atomically publish against adapter claims and return proof transitions
   * derived inside that mutation operation. A conflict never mutates storage. */
  publish?(request: FilePublicationRequest): Promise<FilePublicationResult>
  /** Atomically install one absent package directory and return one aggregate
   * proof set for its root and every submitted resource. */
  publishPackageIfAbsent?(request: FilePackagePublicationRequest): Promise<FilePublicationResult>
  /** Strict publication is a separate durable protocol from ordinary writes:
   * the causal metadata layer stages first, prepares its row, then asks this
   * capability to publish/resume and finally discards the recovery artifact. */
  strictPublication?: FileStrictPublication
  /** Atomic visibility: an operation-owned temp file + rename (P3 — readers and
   *  a process crash mid-write must never leave a half-written note). This does
   *  not promise fsync-level durability across sudden power loss. Creates parent
   *  directories. */
  write(path: string, content: string): Promise<void>
  /** Atomically publish complete bytes only when the pathname is absent. `false`
   *  means another file, directory or symlink already owns it. Optional for media
   *  without a no-replace create primitive. */
  writeIfAbsent?(path: string, content: string): Promise<boolean>
  /** Whether two path spellings currently name the same file or directory entry.
   *  Used only to permit case/NFC-only renames on insensitive filesystems without
   *  treating a symlink or distinct hardlink pathname as the source itself. */
  sameEntry?(left: string, right: string): Promise<boolean>
  /** Move one file with the medium's ordinary replacement semantics. Creates
   *  destination parents; directories remain durable when the source empties. */
  rename(from: string, to: string): Promise<void>
  /** Publish the source's exact bytes at the destination without overwriting,
   *  then remove only the source version that was observed. Also handles two
   *  spellings of the same medium entry. `false` means a different entry owns
   *  the destination. */
  renameIfAbsent?(from: string, to: string): Promise<boolean>
  /** Atomically publish the FINAL bytes at an absent destination while moving a
   *  source whose exact bytes were read by the caller. The adapter must never
   *  overwrite either a racing destination or a replacement of the source.
   *  `false` means another entry owns the destination. */
  replaceIfAbsent?(
    from: string,
    to: string,
    expectedSource: string,
    content: string,
  ): Promise<boolean>
  /** Move a whole directory subtree. */
  renameDir(from: string, to: string): Promise<void>
  /** Atomically move a whole directory subtree only while the destination
   * pathname is absent. `false` means another entry owns it; an adapter whose
   * medium or RUNTIME carries no such primitive omits the capability entirely,
   * so callers fail closed instead of emulating a race. Presence answers for the
   * deployment, not for every pathname under it.
   * canon: docs/note-model.md#create-collisions */
  renameDirIfAbsent?(from: string, to: string): Promise<boolean>
  remove(path: string): Promise<void>
  /** Remove only the exact regular-file version whose bytes the caller read.
   *  `false` means the pathname was replaced or edited and remains intact;
   *  an already-absent source counts as successfully removed. */
  removeIfUnchanged?(path: string, expectedContent: string): Promise<boolean>
  /** Remove only the exact adapter claim produced by an earlier publication.
   *  The adapter must bind claim verification and pathname detachment into one
   *  conditional operation; checking the claim in a caller and deleting later
   *  would let a same-byte replacement win between those two steps. */
  removeIfClaimed?(
    path: string,
    expectedContent: string,
    expectedClaim: FileClaim & { kind: 'present' },
  ): Promise<boolean>
  /** Create the durable on-disk anchor for a "New folder" (#97). Missing parents
   *  are created, then the leaf is claimed atomically. `false` means a file or
   *  directory already owns that exact medium pathname. */
  makeDir(path: string): Promise<boolean>
  /** Delete a directory subtree wholesale (#97 folder delete): its notes,
   *  sibling markers and nested dirs. Idempotent (a missing dir is a no-op). */
  removeDir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Does the path exist AS A DIRECTORY? (#97) The root ('') always does; a file
   *  answers false. Lets a move distinguish an empty-but-real folder (no indexed
   *  notes) from a genuinely missing one. */
  dirExists(path: string): Promise<boolean>
  /** Does a directory exist under EXACTLY this spelling? On a case-insensitive or
   *  NFC-normalizing medium `dirExists` answers for a different spelling too, and
   *  the difference is precisely what a write must refuse. Answering it needs one
   *  shallow listing of the parent — the alternative is a recursive walk of the
   *  whole mount on every write, which is O(tree) per note.
   *  OPTIONAL for a different reason than `renameDirIfAbsent` above, and the two
   *  must not be read as the same kind of thing: that one is missing when the
   *  deployment CANNOT perform it, so its absence fails a caller closed. This one
   *  is a cost, not a power — every adapter that can list a directory can answer
   *  it, and one that doesn't leaves the caller on the recursive walk, which is
   *  equally correct and merely slow. canon: docs/core.md#cooperative */
  dirExistsExact?(path: string): Promise<boolean>
  /** Watch the subtree for external changes (#146, P5 capability). `onChange`
   *  receives the storage-relative path when the medium can identify it, or null
   *  for a pathless hint. It fires (coalesced upstream) on any non-hidden
   *  create/modify/delete under the root — it is an INVITATION TO RESCAN, never a
   *  source of truth: the caller reconciles via a full scan() (P3), so a missed or
   *  duplicate signal only shifts WHEN the rescan runs, never its correctness.
   *  Returns a closer, or
   *  `null` when a watcher can't be ESTABLISHED on this medium (inotify exhausted,
   *  an unsupported platform) — the caller degrades to periodic polling (honest P5,
   *  not a crash). A watcher that establishes but then under-delivers (a network
   *  mount only sees local writes, not another host's edits; an async inotify
   *  overflow) can't be detected here — the caller's periodic backstop is the net
   *  for that, by design. OPTIONAL: a backend with no change feed omits it. */
  watch?(onChange: (path: string | null) => void): (() => void) | null
}
