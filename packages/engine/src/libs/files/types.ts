// The engine's storage seam — P5's minimal contract in file form: enumerate,
// read, write, stat, move, delete. localfs is the only v1 backend (desktop =
// the user's folder, cloud v1 = the server volume); s3/seafile/webdav arrive
// with the working-set milestone (#70), behind this same seam.
// All paths are storage-relative POSIX ('dir/note.md'); the adapter owns
// mapping them onto its medium and refusing escapes.

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

export type FileStore = {
  /** Every note file under the root, recursively. The full-inventory truth
   *  source (P3) — cheap by design: stats only. The engine independently
   *  source-verifies a bounded rotating subset. */
  scan(): Promise<FileStat[]>
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
  /** Atomic visibility: an operation-owned temp file + rename (P3 — readers and
   *  a process crash mid-write must never leave a half-written note). This does
   *  not promise fsync-level durability across sudden power loss. Creates parent
   *  directories. */
  write(path: string, content: string): Promise<void>
  /** Move one file; creates the destination's parents, prunes emptied source
   *  directories (the engine's tree shows folders only through the notes in
   *  them — an empty leftover dir would be invisible anyway). */
  rename(from: string, to: string): Promise<void>
  /** Move a whole directory subtree. */
  renameDir(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  /** Create an empty directory (and any missing ancestors), idempotently — the
   *  on-disk anchor for a "New folder" (#97). Durable: never auto-pruned. */
  makeDir(path: string): Promise<void>
  /** Delete a directory subtree wholesale (#97 folder delete): its notes,
   *  sibling markers and nested dirs. Idempotent (a missing dir is a no-op). */
  removeDir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Does the path exist AS A DIRECTORY? (#97) The root ('') always does; a file
   *  answers false. Lets a move distinguish an empty-but-real folder (no indexed
   *  notes) from a genuinely missing one. */
  dirExists(path: string): Promise<boolean>
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
