import type { OwnerProofAdoption, OwnerProofBindingRecord, OwnerProofPersistence } from '../types'

type Address = { space: string; revision: number; live: boolean }

export class InMemoryOwnerProofPersistence implements OwnerProofPersistence {
  private readonly addresses = new Map<string, Address>()
  private readonly bindings = new Map<string, OwnerProofBindingRecord>()
  private readonly receipts = new Map<string, OwnerProofBindingRecord>()

  async init(): Promise<void> {}

  /** Reference-driver seam: production SQL drivers read note_identity. */
  setAddress(noteId: string, space: string, revision: number, live = true): void {
    this.addresses.set(noteId, { space, revision, live })
  }

  async get(noteId: string): Promise<OwnerProofBindingRecord | null> {
    return this.getForRestoreTerminal(noteId)
  }

  getForRestoreTerminal(noteId: string): OwnerProofBindingRecord | null {
    const binding = this.bindings.get(noteId)
    return binding ? { ...binding } : null
  }

  async getByReceipt(space: string, receiptId: string): Promise<OwnerProofBindingRecord | null> {
    return this.getByReceiptForRestoreTerminal(space, receiptId)
  }

  getByReceiptForRestoreTerminal(space: string, receiptId: string): OwnerProofBindingRecord | null {
    const binding = this.receipts.get(`${space}\0${receiptId}`)
    return binding ? { ...binding } : null
  }

  async adopt(input: OwnerProofAdoption) {
    return this.adoptForRestoreTerminal(input)
  }

  adoptForRestoreTerminal(input: OwnerProofAdoption) {
    const receiptKey = `${input.space}\0${input.receiptId}`
    const receipt = this.receipts.get(receiptKey)

    if (receipt) {
      const binding = { ...receipt }
      return binding.noteId === input.noteId &&
        binding.addressRevision === input.addressRevision &&
        binding.sourceHash === input.sourceHash &&
        binding.proofJson === input.proofJson
        ? ({ status: 'replayed', binding } as const)
        : ({ status: 'receipt-conflict', binding } as const)
    }
    const address = this.addresses.get(input.noteId)

    if (!address || !address.live || address.space !== input.space) {
      return { status: 'missing-address' } as const
    }
    if (address.revision !== input.addressRevision) {
      return { status: 'address-conflict', addressRevision: address.revision } as const
    }
    const current = this.bindings.get(input.noteId)

    if ((current?.proofRevision ?? null) !== input.expectedProofRevision) {
      return {
        status: 'proof-conflict',
        binding: current ? { ...current } : null,
      } as const
    }
    const binding: OwnerProofBindingRecord = {
      noteId: input.noteId,
      space: input.space,
      addressRevision: input.addressRevision,
      proofRevision: (current?.proofRevision ?? 0) + 1,
      sourceHash: input.sourceHash,
      proofJson: input.proofJson,
      receiptId: input.receiptId,
      updatedAt: input.updatedAt,
    }
    this.bindings.set(input.noteId, binding)
    this.receipts.set(receiptKey, { ...binding })
    return { status: 'adopted', binding: { ...binding } } as const
  }

  snapshotForRestoreTerminal() {
    return {
      addresses: new Map([...this.addresses].map(([id, address]) => [id, { ...address }])),
      bindings: new Map([...this.bindings].map(([id, binding]) => [id, { ...binding }])),
      receipts: new Map([...this.receipts].map(([id, binding]) => [id, { ...binding }])),
    }
  }

  restoreForRestoreTerminal(snapshot: ReturnType<this['snapshotForRestoreTerminal']>): void {
    this.addresses.clear()
    this.bindings.clear()
    this.receipts.clear()
    for (const [id, address] of snapshot.addresses) {
      this.addresses.set(id, { ...address })
    }
    for (const [id, binding] of snapshot.bindings) {
      this.bindings.set(id, { ...binding })
    }
    for (const [id, binding] of snapshot.receipts) {
      this.receipts.set(id, { ...binding })
    }
  }
}
