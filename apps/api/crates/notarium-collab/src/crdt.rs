//! Room-owned CRDT state. Only a durably settled update is copied into live.

// The cost campaign observes actual work at these call sites. Production
// builds and ordinary test runs compile out the instrumentation completely.
macro_rules! guard_work {
    ($($field:ident += $amount:expr),+ $(,)?) => {
        #[cfg(all(test, feature = "collab-bench"))]
        $crate::crdt::benchmark::record(|work| { $(work.$field += $amount;)+ });
    };
}

#[cfg(all(test, feature = "collab-bench"))]
mod benchmark;
mod body;
mod topology;
mod update;

use std::sync::{Arc, Mutex};

use notarium_canonical::CanonicalStore;
use notarium_core::{
    ids::{BodyIdentity, NoteId},
    patch::BodyPatchPlan,
};
use notarium_syntax::{patch, unicode::validate_content};
use yrs::{
    Any, Doc, GetString, IdSet, Map, MapRef, Observable, OffsetKind, Options, Out, ReadTxn,
    Snapshot, StateVector, Text, TextRef, Transact, TransactionMut, Update, block::ClientID,
    merge_updates_v1, types::EntryChange, updates::decoder::Decode,
};

use self::{
    body::{BodyIndex, LocalEdit},
    topology::{MAX_ROOM_CLIENTS, Topology},
    update::Frame,
};
use crate::{
    carrier::{
        AppliedFm, AppliedFmEntry, RoomCarrierState, authorize_collab_key, finalize_nota_body,
    },
    wire::PolicyRejectReason as Reject,
};

const BODY: &str = "body";
const FIELDS: &str = "fm_overrides";
const EMPTY_UPDATE: &[u8] = &[0, 0];

type ObservedFields = Vec<(Arc<str>, bool)>;

struct Replica {
    doc: Doc,
    body: TextRef,
    fields: MapRef,
    observed_fields: Option<Arc<Mutex<ObservedFields>>>,
}

impl Replica {
    fn new_staging(excluded: impl Fn(ClientID) -> bool) -> Self {
        Self::new_with_observer(excluded, true)
    }

    fn new_live(excluded: impl Fn(ClientID) -> bool) -> Self {
        Self::new_with_observer(excluded, false)
    }

    fn new_with_observer(excluded: impl Fn(ClientID) -> bool, observe_fields: bool) -> Self {
        let mut options = Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        };
        while excluded(options.client_id) {
            options.client_id = ClientID::random();
        }
        Self::from_doc(Doc::with_options(options), observe_fields)
    }

    fn from_doc(doc: Doc, observe_fields: bool) -> Self {
        let body = doc.get_or_insert_text(BODY);
        let fields = doc.get_or_insert_map(FIELDS);
        let observed_fields = if observe_fields {
            let observed_fields = Arc::new(Mutex::new(Vec::new()));
            let observed = Arc::clone(&observed_fields);
            fields.observe("collab", move |txn, event| {
                observed
                    .lock()
                    .expect("collab field observer")
                    .extend(event.keys(txn).iter().map(|(key, entry)| {
                        (Arc::clone(key), matches!(entry, EntryChange::Removed(_)))
                    }));
            });
            Some(observed_fields)
        } else {
            None
        };
        Self {
            doc,
            body,
            fields,
            observed_fields,
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        let snapshot = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        guard_work!(
            snapshot_exports += 1,
            generated_binary_bytes += snapshot.len()
        );
        snapshot
    }

    fn apply(&self, bytes: &[u8]) -> Result<(), Reject> {
        let mut txn = self.doc.transact_mut();
        apply_update(&mut txn, bytes)?;
        self.take_field_changes();
        Ok(())
    }

    fn take_field_changes(&self) -> ObservedFields {
        match &self.observed_fields {
            Some(observed) => std::mem::take(&mut *observed.lock().expect("collab field observer")),
            None => Vec::new(),
        }
    }

    fn overrides(&self, txn: &impl ReadTxn) -> Result<AppliedFm, Reject> {
        self.fields
            .iter(txn)
            .map(|(key, value)| {
                guard_work!(map_entries += 1);
                authorize_collab_key(key).map_err(|_| Reject::ProtectedFrontmatterKey)?;
                let Out::Any(value) = value else {
                    return Err(Reject::InvalidFrontmatterValue);
                };
                let entry = AppliedFmEntry::from_any(&value)
                    .map_err(|_| Reject::InvalidFrontmatterValue)?;
                Ok((key.to_string(), entry))
            })
            .collect()
    }

    fn verified_body(&self, txn: &impl ReadTxn) -> Result<String, Reject> {
        let body = self.body.get_string(txn);
        guard_work!(
            whole_body_passes += 2,
            body_input_bytes += body.len() * 2,
            body_copy_bytes += body.len()
        );
        if body.encode_utf16().count() != self.body.len(txn) as usize {
            return Err(Reject::InvalidBodyContent);
        }
        guard_work!(whole_body_passes += 1, body_input_bytes += body.len());
        validate_content(&body).map_err(|_| Reject::InvalidBodyContent)?;
        Ok(body)
    }

    fn rebuild_body_index(&self) -> Result<BodyIndex, Reject> {
        let mut txn = self.doc.transact_mut();
        guard_work!(snapshot_exports += 1);
        let hi = txn.snapshot();
        // Comparing with the empty snapshot asks Yrs to report the ID of
        // each visible item in text order in a single traversal.
        let chunks =
            self.body
                .diff_range(&mut txn, Some(&hi), Some(&Snapshot::default()), |change| {
                    change.id
                });
        let mut body = String::new();
        let mut ordered = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            match (&chunk.insert, &chunk.attributes, chunk.ychange) {
                (Out::Any(Any::String(text)), None, Some(id)) => {
                    guard_work!(body_items += 1, body_copy_bytes += text.len() * 2);
                    body.push_str(text);
                    ordered.push((id, text.as_ref()));
                }
                _ => return Err(Reject::InvalidBodyContent),
            }
        }
        guard_work!(whole_body_passes += 1, body_input_bytes += body.len());
        let index = BodyIndex::rebuild(&body, &ordered)?;
        if index.len != self.body.len(&txn) {
            return Err(Reject::InvalidBodyContent);
        }
        Ok(index)
    }

    fn rebuild_index(&self) -> Result<(Topology, BodyIndex), Reject> {
        let topology = Topology::from_snapshot(&update::inspect_snapshot(&self.snapshot(), true)?)?;
        let index = self.rebuild_body_index()?;
        Ok((topology, index))
    }
}

pub(crate) struct RecoveryReplay {
    pub(crate) snapshot_overrides: AppliedFm,
    pub(crate) final_body: String,
    pub(crate) final_overrides: AppliedFm,
    pub(crate) final_snapshot: Vec<u8>,
}

/// Replay a fenced room's snapshot and WAL tail in a single `Replica`, without
/// allocating a `TwinDoc`, staging replica, or `BodyIndex`.
pub(crate) fn replay_for_recovery(
    base_body: &str,
    snapshot: Option<&[u8]>,
    updates: &[&[u8]],
) -> Result<RecoveryReplay, Reject> {
    let Some(snapshot) = snapshot else {
        if !updates.is_empty() {
            return Err(Reject::MalformedUpdate);
        }
        validate_content(base_body).map_err(|_| Reject::InvalidBodyContent)?;
        if base_body.encode_utf16().count() > i32::MAX as usize {
            return Err(Reject::InvalidBodyContent);
        }
        let seed = Replica::new_live(|_| false);
        seed.body.insert(&mut seed.doc.transact_mut(), 0, base_body);
        return Ok(RecoveryReplay {
            snapshot_overrides: AppliedFm::new(),
            final_body: base_body.to_owned(),
            final_overrides: AppliedFm::new(),
            final_snapshot: seed.snapshot(),
        });
    };
    let frame = update::inspect_snapshot(snapshot, true)?;
    Topology::from_snapshot(&frame)?;
    let replica = Replica::new_live(|id| frame.runs.contains_key(&id));
    replica.apply(snapshot)?;
    let snapshot_overrides = {
        let txn = replica.doc.transact();
        verify_roots(&txn)?;
        replica.overrides(&txn)?
    };
    for bytes in updates {
        update::inspect_snapshot(bytes, true)?;
        replica.apply(bytes)?;
    }
    let (final_body, final_overrides) = {
        let txn = replica.doc.transact();
        verify_roots(&txn)?;
        (replica.verified_body(&txn)?, replica.overrides(&txn)?)
    };
    Ok(RecoveryReplay {
        snapshot_overrides,
        final_body,
        final_overrides,
        final_snapshot: replica.snapshot(),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GuardPath {
    Ordinary,
    Structural,
}

#[derive(Debug)]
pub(crate) struct StagedUpdate {
    pub(crate) bytes: Vec<u8>,
}

pub(crate) struct TwinDoc {
    live: Replica,
    staging: Replica,
    topology: Topology,
    body: BodyIndex,
}

impl TwinDoc {
    pub(crate) fn seed(body: &str) -> Result<Self, Reject> {
        validate_content(body).map_err(|_| Reject::InvalidBodyContent)?;
        if body.encode_utf16().count() > i32::MAX as usize {
            return Err(Reject::InvalidBodyContent);
        }
        let seed = Replica::new_live(|_| false);
        seed.body.insert(&mut seed.doc.transact_mut(), 0, body);
        Self::restore(&seed.snapshot())
    }

    pub(crate) fn restore(snapshot: &[u8]) -> Result<Self, Reject> {
        let frame = update::inspect_snapshot(snapshot, true)?;
        let topology = Topology::from_snapshot(&frame)?;
        let live = Replica::new_live(|id| frame.runs.contains_key(&id));
        let staging =
            Replica::new_staging(|id| id == live.doc.client_id() || frame.runs.contains_key(&id));
        live.apply(snapshot)?;
        staging.apply(snapshot)?;
        {
            let txn = staging.doc.transact();
            verify_roots(&txn)?;
            staging.overrides(&txn)?;
        }
        let body = staging.rebuild_body_index()?;
        Ok(Self {
            live,
            staging,
            topology,
            body,
        })
    }

    pub(crate) fn has_client(&self, id: ClientID) -> bool {
        self.topology.has_client(id)
    }

    pub(crate) fn client_ids(&self) -> [ClientID; 2] {
        [self.live.doc.client_id(), self.staging.doc.client_id()]
    }

    pub(crate) fn live_state_vector(&self) -> StateVector {
        self.live.doc.transact().state_vector()
    }

    pub(crate) fn sync_step2(&self, remote: &StateVector) -> Vec<u8> {
        self.live.doc.transact().encode_state_as_update_v1(remote)
    }

    pub(crate) fn live_snapshot(&self) -> Vec<u8> {
        self.live.snapshot()
    }

    pub(crate) fn staging_snapshot(&self) -> Vec<u8> {
        self.staging.snapshot()
    }

    pub(crate) fn live_body(&self) -> String {
        self.live.body.get_string(&self.live.doc.transact())
    }

    pub(crate) fn staging_body(&self) -> String {
        self.staging.body.get_string(&self.staging.doc.transact())
    }

    pub(crate) fn live_overrides(&self) -> Result<AppliedFm, Reject> {
        self.live.overrides(&self.live.doc.transact())
    }

    #[cfg(test)]
    pub(crate) fn staging_overrides(&self) -> Result<AppliedFm, Reject> {
        self.staging.overrides(&self.staging.doc.transact())
    }

    /// Validate against the already-accepted prefix in staging. On rejection
    /// the caller rebuilds staging from live and that prefix before continuing.
    pub(crate) fn stage_peer(
        &mut self,
        bytes: &[u8],
        carrier: &RoomCarrierState,
        note: &NoteId,
    ) -> Result<StagedUpdate, Reject> {
        self.stage_peer_with_path(bytes, carrier, note, false)
            .map(|(update, _)| update)
    }

    fn stage_peer_with_path(
        &mut self,
        bytes: &[u8],
        carrier: &RoomCarrierState,
        note: &NoteId,
        force_structural: bool,
    ) -> Result<(StagedUpdate, GuardPath), Reject> {
        let frame = update::inspect_peer(bytes, carrier.fm_writable)?;
        let input_bytes = bytes.len();
        let reserved = self.client_ids();
        let local = (!force_structural)
            .then(|| self.local_edit(&frame, &reserved))
            .flatten();
        let mut evidence = local
            .is_none()
            .then(|| {
                self.topology
                    .prove(&frame, &self.body, &reserved, Some(MAX_ROOM_CLIENTS))
            })
            .transpose()?;
        let mut txn = self.staging.doc.transact_mut();
        apply_update(&mut txn, bytes)?;
        let observed = self.staging.take_field_changes();

        if let Some(edit) = local
            && local_applied(&edit, self.body.len, self.staging.body.len(&txn), &txn)
            && observed.is_empty()
        {
            drop(txn);
            let mut local_units = edit.delete.as_ref().map_or(0, |delete| delete.len as usize);
            if let Some(insert) = &edit.insert {
                let inserted_len = insert.units.len();
                self.topology
                    .append_body(insert.id, insert.id.clock + inserted_len);
                local_units += inserted_len as usize;
            }
            self.body.apply(edit);
            guard_work!(wal_copy_bytes += bytes.len());
            log_guard(
                GuardPath::Ordinary,
                input_bytes,
                input_bytes,
                frame.blocks.len() + frame.deletes.len(),
                local_units,
                0,
            );
            return Ok((
                StagedUpdate {
                    bytes: bytes.to_vec(),
                },
                GuardPath::Ordinary,
            ));
        }

        // The observed transaction is already committed in staging, but the
        // room's proof of the pre-update state is still intact for fallback.
        let mut evidence = match evidence.take() {
            Some(evidence) => evidence,
            None => self
                .topology
                .prove(&frame, &self.body, &reserved, Some(MAX_ROOM_CLIENTS))?,
        };
        if evidence.insertions != *txn.insert_set() {
            return Err(Reject::PendingClockGap);
        }
        verify_roots(&txn)?;
        if observed.iter().any(|(_, deleted)| *deleted) {
            return Err(Reject::FrontmatterKeyDeleted);
        }
        if !carrier.fm_writable && !observed.is_empty() {
            return Err(Reject::FrontmatterNotWritable);
        }
        if observed
            .iter()
            .any(|(key, _)| !evidence.fields.contains(key))
        {
            return Err(Reject::ForbiddenRootOrSubdoc);
        }
        let body = if evidence.touches_body {
            Some(self.staging.verified_body(&txn)?)
        } else {
            None
        };
        let fields = self.staging.overrides(&txn)?;
        if evidence
            .fields
            .drain()
            .any(|key| !fields.contains_key(key.as_ref()))
        {
            // A map set followed by delete can be invisible to observers;
            // the wire still carries the key and its final absence.
            return Err(Reject::FrontmatterKeyDeleted);
        }
        let applied = txn.encode_update_v1();
        guard_work!(generated_binary_bytes += applied.len());
        drop(txn);
        let body_len = body.as_ref().map_or(0, String::len);
        let bytes = if let Some(body) = &body {
            let bytes = self.finalize(applied, carrier, note, body, &fields)?;
            self.rebuild_staging_index()?;
            bytes
        } else {
            // FM-only update: validate overrides on the header prefix alone and
            // advance topology without rebuilding `BodyIndex`.
            carrier
                .validate_overrides(&fields)
                .map_err(|_| Reject::FrontmatterNotWritable)?;
            let encoded = update::inspect_snapshot(&applied, carrier.fm_writable)?;
            let encoded_evidence =
                self.topology
                    .prove(&encoded, &self.body, &reserved, Some(MAX_ROOM_CLIENTS))?;
            self.topology.apply_resolved(&encoded, &encoded_evidence)?;
            applied
        };
        log_guard(
            GuardPath::Structural,
            input_bytes,
            bytes.len(),
            frame.blocks.len() + frame.deletes.len(),
            0,
            body_len,
        );
        Ok((StagedUpdate { bytes }, GuardPath::Structural))
    }

    fn local_edit(&self, frame: &Frame<'_>, reserved: &[ClientID; 2]) -> Option<LocalEdit> {
        let delete = match frame.deletes.as_slice() {
            [] => None,
            [deletion] => Some(self.body.local_removal(*deletion)?),
            _ => return None,
        };
        match frame.blocks.as_slice() {
            [] => Some(LocalEdit {
                insert: None,
                delete,
            }),
            [block]
                if block.id.clock == self.topology.clock(block.id.client)
                    && !reserved.contains(&block.id.client)
                    && (self.topology.has_client(block.id.client)
                        || self.topology.client_count() < MAX_ROOM_CLIENTS)
                    && self.body.len.checked_add(block.len())? <= i32::MAX as u32 =>
            {
                self.body.local_insert(*block, delete)
            }
            _ => None,
        }
    }

    pub(crate) fn stage_command(
        &mut self,
        body_plan: Option<&BodyPatchPlan>,
        overrides_delta: &AppliedFm,
        carrier: &RoomCarrierState,
        note: &NoteId,
    ) -> Result<(Vec<u8>, Option<String>, AppliedFm), Reject> {
        let identity = CanonicalStore::derive_carrier_identities(&carrier.carrier_rev_id).0;
        let mut txn = self.staging.doc.transact_mut();
        let expected_body = body_plan
            .map(|plan| validate_body_plan(&self.staging.body.get_string(&txn), &identity, plan))
            .transpose()?;
        let fields = command_fields(overrides_delta, carrier.fm_writable)?;
        check_local_clock(&txn, body_plan, fields.len())?;
        if let Some(plan) = body_plan {
            apply_splices(&self.staging.body, &mut txn, plan);
        }
        for (key, entry, value) in fields {
            let unchanged = self
                .staging
                .fields
                .get(&txn, key)
                .and_then(|out| match out {
                    Out::Any(existing) => AppliedFmEntry::from_any(&existing).ok(),
                    _ => None,
                })
                .is_some_and(|existing| existing == *entry);
            if !unchanged {
                self.staging.fields.insert(&mut txn, key, value);
            }
        }
        txn.commit();
        self.staging.take_field_changes();
        let body_touched = body_plan.is_some_and(|plan| !plan.edits.is_empty());
        let body = if body_touched || expected_body.is_some() {
            let body = self.staging.verified_body(&txn)?;
            if expected_body.is_some_and(|expected| body != expected) {
                return Err(Reject::InvalidBodyContent);
            }
            Some(body)
        } else {
            None
        };
        let fields = self.staging.overrides(&txn)?;
        let delta = txn.encode_update_v1();
        drop(txn);
        if body_touched {
            let body = body.expect("body_touched loaded verified body");
            let (bytes, final_body) =
                self.finalize_with_body(delta, carrier, note, body, &fields)?;
            self.rebuild_staging_index()?;
            Ok((bytes, Some(final_body), fields))
        } else {
            carrier
                .validate_overrides(&fields)
                .map_err(|_| Reject::FrontmatterNotWritable)?;
            if delta != EMPTY_UPDATE {
                let encoded = update::inspect_snapshot(&delta, carrier.fm_writable)?;
                let evidence = self.topology.prove(&encoded, &self.body, &[], None)?;
                self.topology.apply_resolved(&encoded, &evidence)?;
            }
            Ok((delta, body, fields))
        }
    }

    fn finalize(
        &mut self,
        applied: Vec<u8>,
        carrier: &RoomCarrierState,
        note: &NoteId,
        body: &str,
        fields: &AppliedFm,
    ) -> Result<Vec<u8>, Reject> {
        let (bytes, _) =
            self.finalize_with_body(applied, carrier, note, body.to_owned(), fields)?;
        Ok(bytes)
    }

    fn finalize_with_body(
        &mut self,
        applied: Vec<u8>,
        carrier: &RoomCarrierState,
        note: &NoteId,
        body: String,
        fields: &AppliedFm,
    ) -> Result<(Vec<u8>, String), Reject> {
        carrier
            .validate_overrides(fields)
            .map_err(|_| Reject::FrontmatterNotWritable)?;
        let identity = CanonicalStore::derive_carrier_identities(&carrier.carrier_rev_id).0;
        guard_work!(nota_finalizations += 1, nota_input_bytes += body.len());
        let Some(plan) = finalize_nota_body(carrier, &body, fields, note, identity.clone())
            .map_err(|_| Reject::InvalidBodyContent)?
        else {
            return Ok((applied, body));
        };

        let expected = validate_body_plan(&body, &identity, &plan)?;
        let mut txn = self.staging.doc.transact_mut();
        check_local_clock(&txn, Some(&plan), 0)?;
        apply_splices(&self.staging.body, &mut txn, &plan);
        txn.commit();
        let body = self.staging.verified_body(&txn)?;
        if body != expected {
            return Err(Reject::InvalidBodyContent);
        }
        let normalization = txn.encode_update_v1();
        guard_work!(generated_binary_bytes += normalization.len());
        let merged = merge_updates_v1([applied.as_slice(), normalization.as_slice()])
            .map_err(|_| Reject::MalformedUpdate)?;
        guard_work!(generated_binary_bytes += merged.len());
        update::inspect_snapshot(&merged, carrier.fm_writable)?;
        Ok((merged, body))
    }

    fn rebuild_staging_index(&mut self) -> Result<(), Reject> {
        let (topology, mut body) = self.staging.rebuild_index()?;
        body.keep_deleted_anchors(&mut self.body);
        self.topology = topology;
        self.body = body;
        Ok(())
    }

    pub(crate) fn publish(&mut self, bytes: &[u8]) -> Result<(), Reject> {
        if bytes != EMPTY_UPDATE {
            self.live.apply(bytes)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn replay(&mut self, bytes: &[u8]) -> Result<(), Reject> {
        self.replay_batch(&[bytes])
    }

    /// Replay a durable WAL tail and rebuild `Topology` + `BodyIndex` once at
    /// the end instead of scanning the full document per update.
    pub(crate) fn replay_batch<T: AsRef<[u8]>>(&mut self, updates: &[T]) -> Result<(), Reject> {
        if updates.is_empty() {
            return Ok(());
        }
        for bytes in updates {
            let bytes = bytes.as_ref();
            update::inspect_snapshot(bytes, true)?;
            self.staging.apply(bytes)?;
            self.publish(bytes)?;
        }
        {
            let txn = self.staging.doc.transact();
            verify_roots(&txn)?;
            self.staging.overrides(&txn)?;
            self.staging.verified_body(&txn)?;
        }
        self.rebuild_staging_index()
    }

    pub(crate) fn reset_staging<T: AsRef<[u8]>>(&mut self, prefix: &[T]) -> Result<(), Reject> {
        let live = self.live.snapshot();
        let frame = update::inspect_snapshot(&live, true)?;
        let staging = Replica::new_staging(|id| {
            id == self.live.doc.client_id() || frame.runs.contains_key(&id)
        });
        staging.apply(&live)?;
        // The actor supplies only updates it already validated against this
        // exact durable base and prefix. Rebuild the projection once after
        // replay, rather than scanning the document after every valid update.
        for bytes in prefix {
            staging.apply(bytes.as_ref())?;
        }
        let (topology, body) = staging.rebuild_index()?;
        self.staging = staging;
        self.topology = topology;
        self.body = body;
        Ok(())
    }
}

fn verify_roots(txn: &impl ReadTxn) -> Result<(), Reject> {
    if txn.root_refs().count() != 2
        || !txn
            .root_refs()
            .all(|root| matches!(root, (BODY, Out::YText(_)) | (FIELDS, Out::YMap(_))))
        || txn.subdocs().next().is_some()
    {
        return Err(Reject::ForbiddenRootOrSubdoc);
    }
    Ok(())
}

fn apply_update(txn: &mut TransactionMut<'_>, bytes: &[u8]) -> Result<(), Reject> {
    let update = Update::decode_v1(bytes).map_err(|_| Reject::MalformedUpdate)?;
    txn.apply_update(update)
        .map_err(|_| Reject::MalformedUpdate)?;
    txn.commit();
    let store = ReadTxn::store(txn);
    if store.pending_update().is_some() || store.pending_ds().is_some() {
        return Err(Reject::PendingClockGap);
    }
    Ok(())
}

fn local_applied(edit: &LocalEdit, before: u32, after: u32, txn: &TransactionMut<'_>) -> bool {
    let mut insertions = IdSet::new();
    let mut deletes = IdSet::new();
    let mut expected = before;
    if let Some(delete) = &edit.delete {
        deletes.insert(delete.first, delete.len);
        expected -= delete.len;
    }
    if let Some(insert) = &edit.insert {
        let len = insert.units.len();
        insertions.insert(insert.id, len);
        expected += len;
    }
    after == expected && *txn.insert_set() == insertions && *txn.delete_set() == deletes
}

fn validate_body_plan(
    body: &str,
    identity: &BodyIdentity,
    plan: &BodyPatchPlan,
) -> Result<String, Reject> {
    let expected =
        patch::apply_body(body, identity, plan).map_err(|_| Reject::InvalidBodyContent)?;
    validate_content(&expected).map_err(|_| Reject::InvalidBodyContent)?;
    if expected.encode_utf16().count() > i32::MAX as usize {
        return Err(Reject::InvalidBodyContent);
    }
    Ok(expected)
}

fn command_fields(
    delta: &AppliedFm,
    writable: bool,
) -> Result<Vec<(&str, &AppliedFmEntry, Any)>, Reject> {
    if !writable && !delta.is_empty() {
        return Err(Reject::FrontmatterNotWritable);
    }
    delta
        .iter()
        .map(|(key, entry)| {
            authorize_collab_key(key).map_err(|_| Reject::ProtectedFrontmatterKey)?;
            Ok((
                key.as_str(),
                entry,
                entry
                    .to_any()
                    .map_err(|_| Reject::InvalidFrontmatterValue)?,
            ))
        })
        .collect()
}

fn check_local_clock(
    txn: &TransactionMut<'_>,
    plan: Option<&BodyPatchPlan>,
    field_count: usize,
) -> Result<(), Reject> {
    let units =
        plan.into_iter()
            .flat_map(|plan| &plan.edits)
            .try_fold(field_count, |units, edit| {
                units
                    .checked_add(edit.replacement_utf16_len)
                    .ok_or(Reject::InvalidBodyContent)
            })?;
    if (ReadTxn::store(txn).get_local_state() as usize)
        .checked_add(units)
        .is_none_or(|clock| clock > i32::MAX as usize)
    {
        return Err(Reject::InvalidBodyContent);
    }
    Ok(())
}

fn apply_splices(text: &TextRef, txn: &mut TransactionMut<'_>, plan: &BodyPatchPlan) {
    for splice in plan.edits.iter().rev() {
        let span = splice.utf16.0;
        let start = span.start() as u32;
        if !span.is_empty() {
            text.remove_range(txn, start, (span.end() - span.start()) as u32);
        }
        if !splice.replacement.is_empty() {
            text.insert(txn, start, &splice.replacement);
        }
    }
}

fn log_guard(
    path: GuardPath,
    frame_bytes: usize,
    wal_bytes: usize,
    update_elements: usize,
    local_units: usize,
    body_bytes: usize,
) {
    tracing::trace!(
        ?path,
        frame_bytes,
        wal_bytes,
        update_elements,
        local_units,
        body_bytes,
        "collaboration update checked"
    );
}

#[cfg(test)]
mod tests;
