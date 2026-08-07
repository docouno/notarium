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
   * pathname is absent. `false` means another entry owns it; unsupported media
   * omit the capability so callers fail closed instead of emulating a race. */
  renameDirIfAbsent?(from: string, to: string): Promise<boolean>
  remove(path: string): Promise<void>
  /** Remove only the exact regular-file version whose bytes the caller read.
   *  `false` means the pathname was replaced or edited and remains intact;
   *  an already-absent source counts as successfully removed. */
  removeIfUnchanged?(path: string, expectedContent: string): Promise<boolean>
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
