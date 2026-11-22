use std::{collections::BTreeMap, sync::atomic::Ordering};

use notarium_canonical::{CanonicalStore, RoomCommandSettlement};
use notarium_core::{
    DomainError,
    auth::PrincipalKind,
    classes::{DocClass, authorize_field_key},
    error::{CommitEffect, PortError, ValidationReason},
    ids::RevisionId,
    patch::{BodyPatchPlan, HeaderMutation},
    ports::{
        EditNote, ExternalObservationResult, InterceptedMutation, InterceptedOutcome,
        InterceptedPayload, InterceptionResult,
    },
    value::YamlValue,
};
use notarium_syntax::live::{RoomCarrierState as HeaderState, merge_raw_header};

use crate::{
    carrier::{AppliedFm, AppliedFmEntry, authorize_collab_key, project_body},
    hub::{operation_error, unknown},
    wire::encode_update,
};

use super::{
    Room,
    persistence::{digest, invalid_state, revision_conflict},
};

pub(super) struct InterceptOutcome {
    pub(super) reply: Result<InterceptionResult, PortError>,
    pub(super) poison_room: bool,
}

impl Room {
    pub(super) async fn intercept_command(
        &mut self,
        request: InterceptedMutation,
    ) -> InterceptOutcome {
        let mut poison_room = false;
        let reply = match self.apply_command(request, &mut poison_room).await {
            Ok(outcome) => Ok(InterceptionResult::Applied(Box::new(outcome))),
            Err(PortError::Domain(error)) => Ok(InterceptionResult::Conflict(error)),
            Err(error) => {
                if unknown(&error) {
                    poison_room = true;
                }
                Err(error)
            }
        };
        InterceptOutcome { reply, poison_room }
    }

    async fn apply_command(
        &mut self,
        mut request: InterceptedMutation,
        poison_room: &mut bool,
    ) -> Result<InterceptedOutcome, PortError> {
        // Canonical callers compute identities from the persisted head. An
        // unrelated metadata commit can have advanced that revision.
        request.context.check_current(&self.lease.scope)?;
        let request_start = tokio::time::Instant::now();
        let facts = self.refresh_metadata(&request.context.budget).await?;
        request
            .context
            .auth()
            .authorize_direct_write(&facts, &facts)?;
        let (body, header, board_fields, entity_revision) = match &request.payload {
            InterceptedPayload::EditNote { body, header, .. } => {
                (Some(body), Some(header), None, None)
            }
            InterceptedPayload::ExternalObservation {
                observation,
                body,
                header,
            } => (
                Some(body),
                Some(header),
                None,
                Some(&observation.base_revision),
            ),
            InterceptedPayload::MoveBoardCard { card, .. } => {
                (None, None, Some(&card.fields), Some(&card.expected_note))
            }
        };
        // Lease mismatch uses `InvalidAuthority` for parity with closed rooms.
        if request
            .preconditions
            .lease
            .is_some_and(|lease| lease != self.lease.epoch)
        {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        let revision = &self.carrier.carrier_rev_id;
        let (body_id, header_id) = CanonicalStore::derive_carrier_identities(revision);
        if request
            .preconditions
            .revision
            .as_ref()
            .is_some_and(|rev| rev != revision)
            || entity_revision.is_some_and(|rev| rev != revision)
            || request
                .preconditions
                .lineage
                .is_some_and(|lineage| lineage != self.lease.lineage)
            || body.is_some_and(|body| body.body_identity != body_id)
            || matches!(header, Some(HeaderMutation::RawHeader(raw)) if raw.header_identity != header_id)
        {
            return Err(self.conflict().into());
        }
        let live_body = self.twin.live_body();
        let live_fm = self.twin.live_overrides().map_err(invalid_state)?;
        let mut pending = self.carrier.pending_fields(&live_fm);
        let automated = matches!(
            request.context.auth().kind(),
            PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
        );
        // Compute full-carrier change detection at most once and only when
        // board eligibility or autonomous-run separation actually needs it.
        let mut live_changed_cache: Option<bool> = None;
        let check_live_changed = |carrier: &crate::carrier::RoomCarrierState,
                                  first_dirty: bool,
                                  cache: &mut Option<bool>|
         -> Result<bool, PortError> {
            if !first_dirty {
                return Ok(false);
            }
            if let Some(changed) = *cache {
                return Ok(changed);
            }
            let changed = !carrier.matches_base(&carrier.materialize(&live_body, &live_fm)?);
            *cache = Some(changed);
            Ok(changed)
        };
        // Board facts cover the persisted view cut. Live edits can change
        // the target's group or eligibility without advancing that cut.
        if board_fields.is_some()
            && check_live_changed(
                &self.carrier,
                self.first_dirty.is_some(),
                &mut live_changed_cache,
            )?
        {
            self.checkpoint_for_command(poison_room).await?;
            return Err(self.conflict().into());
        }
        let body_mismatch = body.is_some_and(|body| {
            !body.edits.is_empty() && body.base_body_hash != digest(&live_body)
        });
        if body_mismatch || header_conflict(header, board_fields, &pending) {
            let before_rev = self.carrier.carrier_rev_id.clone();
            self.checkpoint_for_command(poison_room).await?;
            live_changed_cache = None;
            // If checkpoint was a no-op (for example, a peer set and reverted
            // an override back to the base value), re-evaluate pending fields
            // instead of returning a spurious self-conflict on the same head.
            pending = self.carrier.pending_fields(&live_fm);
            if self.carrier.carrier_rev_id != before_rev
                || body_mismatch
                || header_conflict(header, board_fields, &pending)
            {
                return Err(self.conflict().into());
            }
        }

        let projection =
            self.header_projection(header, board_fields, &live_fm, pending, header_id)?;
        let mut body = body.filter(|body| !body.edits.is_empty()).cloned();

        // An autonomous run must never adopt earlier human keystrokes as its
        // own revision, because rolling it back would remove those keystrokes.
        if automated
            && check_live_changed(
                &self.carrier,
                self.first_dirty.is_some(),
                &mut live_changed_cache,
            )?
        {
            self.checkpoint_for_command(poison_room).await?;
            if request.preconditions.revision.is_some() || entity_revision.is_some() {
                return Err(self.conflict().into());
            }
            if let Some(body) = &mut body {
                // The hash was checked against the live text that the human
                // checkpoint just saved. Rebind only the verified body spans.
                body.body_identity =
                    CanonicalStore::derive_carrier_identities(&self.carrier.carrier_rev_id).0;
            }
        }
        drop(live_body);

        let staged = self.prepare_command(body.as_ref(), projection);
        let (staged_update, materialized, fm) = match staged {
            Ok(value) => value,
            Err(error) => {
                if self.reset_staging(&[]).is_err() {
                    *poison_room = true;
                    return Err(operation_error(
                        b"collab_command_reset_staging",
                        CommitEffect::NotCommitted,
                    ));
                }
                return Err(error);
            }
        };
        let final_digest = digest(&materialized);
        let build_settlement = |this: &Self, carrier: &str| RoomCommandSettlement {
            owner_id: this.lease.owner.to_string(),
            expected_lease: this.lease.epoch,
            expected_lineage: this.lease.lineage,
            expected_base_rev: this.carrier.carrier_rev_id.clone(),
            final_carrier: carrier.to_owned(),
            yrs_snapshot: this.twin.staging_snapshot(),
            compacted_through_update_seq: Some(this.last_seq),
        };
        let settlement = build_settlement(self, &materialized);
        request.context.budget.remaining = request
            .context
            .budget
            .remaining
            .saturating_sub(request_start.elapsed());
        let result = commit(&self.store, request.clone(), settlement).await;
        let result = if result.as_ref().err().is_some_and(unknown) {
            let original_id = request.context.budget.request.clone();
            request.context.budget = self.budget();
            request.context.budget.request = original_id;
            let retry_settlement = build_settlement(self, &materialized);
            commit(&self.store, request, retry_settlement)
                .await
                .map_err(|error| {
                    if unknown(&error) {
                        error
                    } else {
                        operation_error(b"collab_command_retry_unresolved", CommitEffect::Unknown)
                    }
                })
        } else {
            result
        };
        let (revision, seq, outcome) = match result {
            Ok(value) => value,
            Err(error) if unknown(&error) => {
                *poison_room = true;
                return Err(error);
            }
            Err(error) => {
                if self.reset_staging(&[]).is_err() {
                    *poison_room = true;
                    return Err(operation_error(
                        b"collab_command_reset_staging",
                        CommitEffect::NotCommitted,
                    ));
                }
                return Err(error);
            }
        };
        // All fallible post-commit work now refers to a durable outcome. Fence
        // on an unexpected internal mismatch instead of running with two bases.
        self.last_self_seq.store(seq, Ordering::Release);
        let installed = self
            .twin
            .publish(&staged_update)
            .map_err(invalid_state)
            .and_then(|()| {
                self.carrier
                    .advance(revision, final_digest, &materialized, fm)
                    .map_err(Into::into)
            });
        if installed.is_err() {
            *poison_room = true;
            return Err(operation_error(
                b"collab_command_install",
                CommitEffect::Unknown,
            ));
        }
        self.settled();
        if staged_update != [0, 0] {
            self.broadcast(encode_update(&staged_update));
        }
        Ok(outcome)
    }

    async fn checkpoint_for_command(&mut self, poison_room: &mut bool) -> Result<(), PortError> {
        match self.checkpoint(&self.budget()).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if is_fatal_room_error(&error) {
                    *poison_room = true;
                    return Err(operation_error(
                        b"collab_command_checkpoint_fatal",
                        if unknown(&error) {
                            CommitEffect::Unknown
                        } else {
                            CommitEffect::NotCommitted
                        },
                    ));
                }
                Err(error)
            }
        }
    }

    fn conflict(&self) -> DomainError {
        revision_conflict(self.carrier.carrier_rev_id.clone(), &self.lease)
    }

    fn prepare_command(
        &mut self,
        body: Option<&BodyPatchPlan>,
        projection: HeaderProjection,
    ) -> Result<(Vec<u8>, String, AppliedFm), PortError> {
        let (staged, staged_body, current_fm) = self
            .twin
            .stage_command(body, &projection.overrides, &self.carrier, &self.lease.note)
            .map_err(invalid_state)?;
        let final_body = staged_body.unwrap_or_else(|| self.twin.staging_body());
        let carrier = if let Some(header) = projection.raw_carrier {
            project_body(&header, &final_body)?
        } else {
            self.carrier.materialize(&final_body, &current_fm)?
        };
        Ok((staged, carrier, current_fm))
    }

    fn header_projection(
        &self,
        header: Option<&HeaderMutation>,
        board_fields: Option<&BTreeMap<String, Option<YamlValue>>>,
        live_fm: &AppliedFm,
        pending_fields: BTreeMap<String, Option<YamlValue>>,
        header_identity: notarium_core::ids::HeaderIdentity,
    ) -> Result<HeaderProjection, PortError> {
        let (fields, raw) = match header {
            Some(HeaderMutation::RawHeader(raw)) => (Some(&raw.semantic_delta), Some(raw)),
            Some(HeaderMutation::SemanticFields(fields)) => (Some(fields), None),
            _ => (board_fields, None),
        };
        if (raw.is_some() || fields.is_some_and(|fields| !fields.is_empty()))
            && !self.carrier.fm_writable
        {
            return Err(DomainError::validation(ValidationReason::FmNotWritable).into());
        }
        let mut overrides = AppliedFm::new();
        for (key, field) in fields.into_iter().flatten() {
            if raw.is_some() {
                // Raw header mutations may edit non-collab YAML keys (such as
                // `title` or `slug`) just as on closed notes; only keys
                // permitted in `fm_overrides` are mirrored into the CRDT map.
                authorize_field_key(key)?;
                if authorize_collab_key(key).is_err() {
                    continue;
                }
            } else {
                authorize_collab_key(key)?;
            }
            match AppliedFmEntry::from_field(field.clone()) {
                Ok(entry) => {
                    overrides.insert(key.clone(), entry);
                }
                Err(_) if raw.is_some() && !live_fm.contains_key(key) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let raw_carrier = raw
            .map(|raw| {
                let state = HeaderState {
                    header_identity: header_identity.clone(),
                    base_carrier: self.carrier.header_merge_source().to_owned(),
                    pending_fields,
                };
                merge_raw_header(&state, raw, DocClass::UserDoc, header_identity)
                    .map(|merged| merged.final_carrier)
            })
            .transpose()?;
        Ok(HeaderProjection {
            overrides,
            raw_carrier,
        })
    }
}

fn is_fatal_room_error(error: &PortError) -> bool {
    if unknown(error) {
        return true;
    }
    matches!(
        error,
        PortError::Domain(
            DomainError::ResourceNotFound
                | DomainError::ValidationFailed {
                    diagnostic: notarium_core::error::Diagnostic {
                        reason: ValidationReason::InvalidAuthority
                            | ValidationReason::SourceMismatch
                            | ValidationReason::InvalidState
                            | ValidationReason::HistoryIncarnationMismatch,
                        ..
                    },
                }
        )
    )
}

struct HeaderProjection {
    overrides: AppliedFm,
    raw_carrier: Option<String>,
}

fn header_conflict(
    header: Option<&HeaderMutation>,
    board: Option<&BTreeMap<String, Option<YamlValue>>>,
    pending: &BTreeMap<String, Option<YamlValue>>,
) -> bool {
    match header {
        Some(HeaderMutation::RawHeader(raw)) => raw
            .semantic_delta
            .keys()
            .any(|key| pending.contains_key(key)),
        Some(HeaderMutation::SemanticFields(fields)) => fields_conflict(pending, fields),
        _ => board.is_some_and(|fields| fields_conflict(pending, fields)),
    }
}

fn fields_conflict(
    pending: &BTreeMap<String, Option<YamlValue>>,
    fields: &BTreeMap<String, Option<YamlValue>>,
) -> bool {
    fields.iter().any(|(key, value)| {
        pending
            .get(key)
            .is_some_and(|peer_value| peer_value != value)
    })
}

async fn commit(
    store: &CanonicalStore,
    request: InterceptedMutation,
    settlement: RoomCommandSettlement,
) -> Result<(RevisionId, u64, InterceptedOutcome), PortError> {
    let InterceptedMutation {
        context,
        identity,
        preconditions,
        payload,
    } = request;
    match payload {
        InterceptedPayload::EditNote { note, plan, .. } => {
            let edit = store
                .commit_intercepted_edit_note(
                    context,
                    identity,
                    preconditions,
                    EditNote { note, plan },
                    settlement,
                )
                .await?;
            let revision = edit.value.revision.clone();
            let seq = edit.receipt.seq().get();
            Ok((revision, seq, InterceptedOutcome::NoteRevision(edit)))
        }
        InterceptedPayload::ExternalObservation { observation, .. } => {
            let lineage = settlement.expected_lineage;
            match store
                .commit_intercepted_external_observation(
                    context,
                    identity,
                    preconditions,
                    observation,
                    settlement,
                )
                .await?
            {
                ExternalObservationResult::Committed(edit) => {
                    let revision = edit.value.revision.clone();
                    let seq = edit.receipt.seq().get();
                    Ok((
                        revision,
                        seq,
                        InterceptedOutcome::ExternalObservation(
                            ExternalObservationResult::Committed(edit),
                        ),
                    ))
                }
                ExternalObservationResult::Conflict { current } => {
                    Err(DomainError::RevisionConflict {
                        current,
                        lineage: Some(lineage),
                    }
                    .into())
                }
                ExternalObservationResult::NoChange { .. } => Err(operation_error(
                    b"collab_external_receipt_missing",
                    CommitEffect::Unknown,
                )),
            }
        }
        InterceptedPayload::MoveBoardCard { card, facts } => {
            let moved = store
                .commit_intercepted_board_move(
                    context,
                    identity,
                    preconditions,
                    card,
                    *facts,
                    settlement,
                )
                .await?;
            let revision = moved.value.revision.revision.clone();
            let seq = moved.receipt.seq().get();
            Ok((revision, seq, InterceptedOutcome::BoardMove(moved)))
        }
    }
}
