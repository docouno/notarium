use std::collections::BTreeMap;

use notarium_canonical::{CanonicalStore, RoomCommandSettlement};
use notarium_core::{
    DomainError,
    auth::PrincipalKind,
    classes::DocClass,
    error::{CommitEffect, PortError, ValidationReason},
    ids::RevisionId,
    patch::{BodyPatchPlan, HeaderMutation},
    ports::{
        EditNote, ExternalObservationResult, InterceptedMutation, InterceptedPayload,
        InterceptionResult,
    },
    receipt::MutationReceiptToken,
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

impl Room {
    pub(super) async fn intercept_command(
        &mut self,
        request: InterceptedMutation,
    ) -> Result<InterceptionResult, PortError> {
        match self.apply_command(request).await {
            Ok(receipt) => Ok(InterceptionResult::Applied(receipt)),
            Err(PortError::Domain(error)) => Ok(InterceptionResult::Conflict(error)),
            Err(error) => Err(error),
        }
    }

    async fn apply_command(
        &mut self,
        mut request: InterceptedMutation,
    ) -> Result<MutationReceiptToken, PortError> {
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
                .lease
                .is_some_and(|lease| lease != self.lease.epoch)
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
        let pending = self.carrier.pending_fields(&live_fm);
        // Board facts cover the persisted view cut. Live edits can change
        // the target's group or eligibility without advancing that cut.
        if board_fields.is_some()
            && self.first_dirty.is_some()
            && self.carrier.materialize(&live_body, &live_fm)? != self.carrier.base_carrier
        {
            self.checkpoint(&self.budget()).await?;
            return Err(self.conflict().into());
        }
        if body
            .is_some_and(|body| !body.edits.is_empty() && body.base_body_hash != digest(&live_body))
            || header_conflict(header, board_fields, &pending)
        {
            self.checkpoint(&self.budget()).await?;
            return Err(self.conflict().into());
        }

        let projection =
            self.header_projection(header, board_fields, &live_fm, pending, header_id)?;
        let mut body = body.filter(|body| !body.edits.is_empty()).cloned();

        // An autonomous run must never adopt earlier human keystrokes as its
        // own revision, because rolling it back would remove those keystrokes.
        let automated = matches!(
            request.context.auth().kind(),
            PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
        );
        if automated
            && self.first_dirty.is_some()
            && self.carrier.materialize(&live_body, &live_fm)? != self.carrier.base_carrier
        {
            self.checkpoint(&self.budget()).await?;
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

        let staged = self.prepare_command(body.as_ref(), projection);
        let (staged_update, materialized, fm) = match staged {
            Ok(value) => value,
            Err(error) => {
                self.reset_staging(&[])?;
                return Err(error);
            }
        };
        let settlement = RoomCommandSettlement {
            owner_id: self.lease.owner.to_string(),
            expected_lease: self.lease.epoch,
            expected_lineage: self.lease.lineage,
            expected_base_rev: self.carrier.carrier_rev_id.clone(),
            final_carrier: materialized.clone(),
            yrs_snapshot: self.twin.staging_snapshot(),
            compacted_through_update_seq: Some(self.last_seq),
        };
        request.context.budget.remaining = request
            .context
            .budget
            .remaining
            .saturating_sub(request_start.elapsed());
        let result = commit(&self.store, request.clone(), settlement.clone()).await;
        let result = if result.as_ref().err().is_some_and(unknown) {
            let original_id = request.context.budget.request.clone();
            request.context.budget = self.budget();
            request.context.budget.request = original_id;
            commit(&self.store, request, settlement)
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
        let (revision, receipt) = match result {
            Ok(value) => value,
            Err(error) if unknown(&error) => return Err(error),
            Err(error) => {
                self.reset_staging(&[])?;
                return Err(error);
            }
        };
        // All fallible post-commit work now refers to a durable outcome. Fence
        // on an unexpected internal mismatch instead of running with two bases.
        let installed = self
            .twin
            .publish(&staged_update)
            .map_err(invalid_state)
            .and_then(|()| {
                self.carrier
                    .advance(revision, digest(&materialized), materialized, fm)
                    .map_err(Into::into)
            });
        if installed.is_err() {
            return Err(operation_error(
                b"collab_command_install",
                CommitEffect::Unknown,
            ));
        }
        self.settled();
        if staged_update != [0, 0] {
            self.broadcast(encode_update(&staged_update));
        }
        Ok(receipt)
    }

    fn conflict(&self) -> DomainError {
        revision_conflict(self.carrier.carrier_rev_id.clone(), &self.lease)
    }

    fn prepare_command(
        &mut self,
        body: Option<&BodyPatchPlan>,
        projection: HeaderProjection,
    ) -> Result<(Vec<u8>, String, AppliedFm), PortError> {
        let staged = self
            .twin
            .stage_command(body, &projection.overrides, &self.carrier, &self.lease.note)
            .map_err(invalid_state)?;
        let final_body = self.twin.staging_body();
        let current_fm = self.twin.staging_overrides().map_err(invalid_state)?;
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
            authorize_collab_key(key)?;
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
                    base_carrier: self.carrier.base_carrier.clone(),
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
) -> Result<(RevisionId, MutationReceiptToken), PortError> {
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
            Ok((edit.value.revision, edit.receipt))
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
                    Ok((edit.value.revision, edit.receipt))
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
            Ok((moved.value.revision.revision, moved.receipt))
        }
    }
}
