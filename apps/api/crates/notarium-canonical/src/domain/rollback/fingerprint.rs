use notarium_core::{
    error::PortError,
    ids::{ContentDigest, NoteId, RevisionId, ViewKey},
    ports::{Mutation, RollbackAgentRun, SpaceContext},
};

use crate::{
    codec::internal_not_committed,
    domain::common::{command_identity_hash, derive_command_identity_spec},
    writer::replay::UnboundCommand,
};

pub(super) fn current(
    ctx: &SpaceContext,
    request: &Mutation<RollbackAgentRun>,
) -> Result<UnboundCommand, PortError> {
    // MessagePack frames each ID, nested tuple and ordered list, including the
    // three optional envelope predicates. Historical IDs have variable lengths.
    let input = &request.input;
    let boards: Vec<_> = input
        .associated_board_expectations
        .iter()
        .map(|a| {
            (
                &a.view.note,
                &a.view.key,
                &a.note,
                &a.expected_rank,
                &a.expected_placement_revision,
            )
        })
        .collect();
    let encoded = rmp_serde::to_vec(&(
        &input.run,
        &input.expected_run_revision,
        &input.expected_entities,
        boards,
        (
            &request.preconditions.revision,
            request.preconditions.lease,
            request.preconditions.lineage,
        ),
    ))
    .map_err(|err| internal_not_committed("rollback_fingerprint", err.to_string()))?;
    Ok(derive_command_identity_spec(
        ctx,
        &request.identity,
        "rollback_agent_run_v2",
        &encoded,
    ))
}

pub(super) fn legacy(
    request: &Mutation<RollbackAgentRun>,
) -> Result<Option<ContentDigest>, PortError> {
    // The old encoding separated records with NUL, but concatenated IDs within
    // each record. Only accept a hash whose records have exactly one typed parse.
    type IdParser = fn(&str) -> bool;
    fn splits(bytes: &str, parsers: &[IdParser]) -> usize {
        let Some((first, rest)) = parsers.split_first() else {
            return usize::from(bytes.is_empty());
        };
        if rest.is_empty() {
            return usize::from(first(bytes));
        }
        let mut matches = 0;
        for cut in 1..bytes.len() {
            if first(&bytes[..cut]) {
                matches += splits(&bytes[cut..], rest);
                if matches > 1 {
                    break;
                }
            }
        }
        matches
    }
    let note: IdParser = |s| NoteId::parse(s).is_ok();
    let rev: IdParser = |s| RevisionId::parse(s).is_ok();
    let view: IdParser = |s| ViewKey::parse(s).is_ok();
    let mut fp = blake3::Hasher::new();
    fp.update(request.input.run.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.expected_run_revision.as_str().as_bytes());
    for ent in &request.input.expected_entities {
        fp.update(&[0]);
        let pair = [ent.note.as_str(), ent.revision.as_str()].concat();
        if splits(&pair, &[note, rev]) != 1 {
            return Ok(None);
        }
        fp.update(pair.as_bytes());
    }
    for assoc in &request.input.associated_board_expectations {
        fp.update(&[0]);
        let group = [
            assoc.view.note.as_str(),
            assoc.view.key.as_str(),
            assoc.note.as_str(),
        ]
        .concat();
        if splits(&group, &[note, view, note]) != 1 {
            return Ok(None);
        }
        fp.update(group.as_bytes());
        let er = serde_json::to_vec(&assoc.expected_rank)
            .map_err(|err| internal_not_committed("rb_fp_json", err.to_string()))?;
        fp.update(&er);
        fp.update(assoc.expected_placement_revision.as_str().as_bytes());
    }
    Ok(Some(command_identity_hash(
        &request.identity,
        "rollback_agent_run",
        fp.finalize().as_bytes(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::{
        auth::{EngineAuthContext, SpaceGrant},
        ids::{
            AgentRunId, CommandKey, GrantId, HistoryIncarnation, PrincipalId, RequestId, SpaceId,
        },
        model::HistoryScope,
        ports::{
            AssociatedBoardExpectation, CallBudget, Cancellation, NoteRevision, Preconditions,
            RankExpectation, ViewRef,
        },
        receipt::CommandIdentity,
    };
    use std::{collections::BTreeMap, time::Duration};

    #[test]
    fn fingerprints_frame_legacy_rollback_ids() {
        let short = "aaaaaaaaaaaa";
        let long = "aaaaaaaaaaaaaaaa";
        let revision = RevisionId::from_bytes([2; 16]);
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([3; 16]),
            incarnation: HistoryIncarnation::from_bytes([4; 16]),
        };
        let actor = PrincipalId::from_bytes([5; 16]);
        let mut spaces = BTreeMap::new();
        spaces.insert(
            scope.space_id.clone(),
            SpaceGrant {
                role: notarium_core::auth::SpaceRole::Owner,
                read_classes: notarium_core::classes::DocClass::all(),
                write_classes: notarium_core::classes::DocClass::all(),
                project_root: None,
            },
        );
        let auth = EngineAuthContext::for_human(notarium_core::auth::VerifiedHuman::attest(
            actor.clone(),
            GrantId::from_bytes([9; 16]),
            spaces,
            false,
        ));
        let budget = CallBudget {
            remaining: Duration::from_secs(5),
            request: RequestId::from_bytes([10; 16]),
            cancellation: Cancellation::default(),
        };
        let ctx = SpaceContext::new(auth, scope.clone(), budget).unwrap();
        let command = Mutation {
            identity: CommandIdentity {
                scope,
                actor,
                key: CommandKey::from_bytes([6; 16]),
                hash: ContentDigest::from_bytes([7; 32]),
            },
            preconditions: Preconditions::default(),
            input: RollbackAgentRun {
                run: AgentRunId::from_bytes([1; 16]),
                expected_run_revision: revision.clone(),
                expected_entities: vec![],
                associated_board_expectations: vec![],
            },
        };
        let mut a = command.clone();
        let mut b = command.clone();
        a.input.expected_entities.push(NoteRevision {
            note: NoteId::parse(short).unwrap(),
            revision: RevisionId::parse(long).unwrap(),
        });
        b.input.expected_entities.push(NoteRevision {
            note: NoteId::parse(long).unwrap(),
            revision: RevisionId::parse(short).unwrap(),
        });
        assert_ne!(
            current(&ctx, &a).unwrap().command_hash(),
            current(&ctx, &b).unwrap().command_hash()
        );
        assert_eq!(legacy(&a).unwrap(), None);
        assert_eq!(legacy(&b).unwrap(), None);
        let board = |key: &str, note: &str| AssociatedBoardExpectation {
            view: ViewRef {
                note: NoteId::from_bytes([8; 16]),
                key: ViewKey::parse(key).unwrap(),
            },
            note: NoteId::parse(note).unwrap(),
            expected_rank: RankExpectation::Absent,
            expected_placement_revision: revision.clone(),
        };
        a = command.clone();
        b = command;
        a.input
            .associated_board_expectations
            .push(board(short, long));
        b.input
            .associated_board_expectations
            .push(board(long, short));
        assert_ne!(
            current(&ctx, &a).unwrap().command_hash(),
            current(&ctx, &b).unwrap().command_hash()
        );
        assert_eq!(legacy(&a).unwrap(), None);
        assert_eq!(legacy(&b).unwrap(), None);
    }
}
