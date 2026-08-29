export type WikilinkLabelCacheStats = Readonly<{
  entries: number
  labelOccurrences: number
  labelCodeUnits: number
  inFlight: number
  hits: number
  misses: number
  joins: number
  loads: number
  rejectedLoads: number
  evictions: number
  pruned: number
  metadataRows: number
  bodyReads: number
  parserCalls: number
  retries: number
  fallbacks: number
}>

type Entry = {
  noteSeq: number
  sourceHash: string
  labels: readonly string[]
}

type Publication = {
  rowid: number
  noteSeq: number
  invalidated: boolean
}

/** The private parsed-label owner for one NotariumStore/space. Entries are
 * generation-exact; normal fills may only occupy an empty/same-generation slot,
 * while a write-through publication is the sole operation allowed to replace a
 * different generation. That asymmetry prevents an older async loader from
 * overwriting a newer upsert. */
export class WikilinkLabelCache {
  private readonly entries = new Map<number, Entry>()
  private readonly inFlight = new Map<string, Promise<readonly string[]>>()
  /** Write-through work that crossed the notes publication gate but has not yet
   * completed its cache-only fingerprint verification. Newer publications and
   * deletion/pruning invalidate these tickets before they can settle. */
  private readonly publications = new Set<Publication>()
  /** Keys invalidated after their loader started (delete/prune). Kept only until
   * that loader settles, so deletion cannot republish a dead row and churn does
   * not leave a rowid tombstone map behind. */
  private readonly invalidatedInFlight = new Set<string>()
  private hits = 0
  private misses = 0
  private joins = 0
  private loads = 0
  private rejectedLoads = 0
  private evictions = 0
  private pruned = 0
  private metadataRows = 0
  private bodyReads = 0
  private parserCalls = 0
  private retries = 0
  private fallbacks = 0

  get(rowid: number, sourceHash: string): readonly string[] | undefined {
    const entry = this.entries.get(rowid)

    if (entry?.sourceHash === sourceHash) {
      this.hits++
      return entry.labels
    }
    this.misses++
    return undefined
  }

  /** Fill one exact generation, joining concurrent graph/search derivations.
   * Rejected work is removed in `finally`, so a transient SQL failure is always
   * retryable. */
  load(
    rowid: number,
    noteSeq: number,
    sourceHash: string,
    loader: () => Promise<readonly string[]>,
  ): Promise<readonly string[]> {
    const cached = this.get(rowid, sourceHash)

    if (cached) {
      return Promise.resolve(cached)
    }
    const key = `${rowid}\u0000${noteSeq}\u0000${sourceHash}`
    const current = this.inFlight.get(key)

    if (current) {
      this.joins++
      return current
    }
    this.loads++
    const pending = loader()
      .then((labels) => {
        const existing = this.entries.get(rowid)

        if (!this.invalidatedInFlight.has(key) && (!existing || existing.noteSeq <= noteSeq)) {
          this.entries.set(rowid, { noteSeq, sourceHash, labels: [...labels] })
        }

        return labels
      })
      .catch((error: unknown) => {
        this.rejectedLoads++
        throw error
      })
      .finally(() => {
        this.inFlight.delete(key)
        this.invalidatedInFlight.delete(key)
      })

    this.inFlight.set(key, pending)
    return pending
  }

  /** Start one write-through publication immediately after its notes generation
   * becomes visible. A newer generation supersedes every older pending ticket. */
  beginPublication(rowid: number, noteSeq: number): Publication {
    for (const publication of this.publications) {
      if (publication.rowid === rowid && publication.noteSeq < noteSeq) {
        publication.invalidated = true
      }
    }
    const publication = { rowid, noteSeq, invalidated: false }

    this.publications.add(publication)
    return publication
  }

  /** Publish labels only while the ticket still names the newest live generation.
   * Returns false after delete/prune or when a newer entry already won. */
  publish(publication: Publication, sourceHash: string, labels: readonly string[]): boolean {
    const pending = this.publications.delete(publication)
    const existing = this.entries.get(publication.rowid)

    if (
      !pending ||
      publication.invalidated ||
      (existing && existing.noteSeq > publication.noteSeq)
    ) {
      return false
    }
    this.entries.set(publication.rowid, {
      noteSeq: publication.noteSeq,
      sourceHash,
      labels: [...labels],
    })
    return true
  }

  /** Finish a publication that cannot prove an exact graph-visible generation.
   * It may discard its own/older entry, never a newer winner. */
  discardPublication(publication: Publication): void {
    this.publications.delete(publication)
    this.invalidateLoads(publication.rowid)
    const existing = this.entries.get(publication.rowid)

    if (existing && existing.noteSeq <= publication.noteSeq) {
      this.entries.delete(publication.rowid)
      this.evictions++
    }
  }

  cancelPublication(publication: Publication): void {
    this.publications.delete(publication)
  }

  evict(rowids: Iterable<number>): void {
    for (const rowid of rowids) {
      this.invalidateLoads(rowid)
      this.invalidatePublications(rowid)
      if (this.entries.delete(rowid)) {
        this.evictions++
      }
    }
  }

  /** Authoritative graph-visible rowids bound settled memory even if a future
   * delete path forgets immediate eviction. In-flight work is generation-fenced
   * by its SQL loader and self-clears; it is never promoted after a newer entry. */
  prune(liveRowids: ReadonlySet<number>): void {
    for (const rowid of this.entries.keys()) {
      if (!liveRowids.has(rowid)) {
        this.invalidateLoads(rowid)
        this.entries.delete(rowid)
        this.pruned++
      }
    }
    for (const key of this.inFlight.keys()) {
      const rowid = Number(key.slice(0, key.indexOf('\u0000')))

      if (!liveRowids.has(rowid)) {
        this.invalidatedInFlight.add(key)
      }
    }
    for (const publication of this.publications) {
      if (!liveRowids.has(publication.rowid)) {
        publication.invalidated = true
      }
    }
  }

  private invalidateLoads(rowid: number): void {
    const prefix = `${rowid}\u0000`

    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.invalidatedInFlight.add(key)
      }
    }
  }

  private invalidatePublications(rowid: number): void {
    for (const publication of this.publications) {
      if (publication.rowid === rowid) {
        publication.invalidated = true
      }
    }
  }

  observeMetadataRows(count: number): void {
    this.metadataRows += count
  }

  observeBodyRead(count = 1): void {
    this.bodyReads += count
  }

  observeParserCall(): void {
    this.parserCalls++
  }

  observeRetry(): void {
    this.retries++
  }

  observeFallback(): void {
    this.fallbacks++
  }

  stats(): WikilinkLabelCacheStats {
    let labelOccurrences = 0
    let labelCodeUnits = 0

    for (const { labels } of this.entries.values()) {
      labelOccurrences += labels.length
      for (const label of labels) {
        labelCodeUnits += label.length
      }
    }

    return {
      entries: this.entries.size,
      labelOccurrences,
      labelCodeUnits,
      inFlight: this.inFlight.size,
      hits: this.hits,
      misses: this.misses,
      joins: this.joins,
      loads: this.loads,
      rejectedLoads: this.rejectedLoads,
      evictions: this.evictions,
      pruned: this.pruned,
      metadataRows: this.metadataRows,
      bodyReads: this.bodyReads,
      parserCalls: this.parserCalls,
      retries: this.retries,
      fallbacks: this.fallbacks,
    }
  }
}
