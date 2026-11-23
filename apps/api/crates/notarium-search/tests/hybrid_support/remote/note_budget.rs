use super::*;
use crate::storage::{
    sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
};

pub(super) struct NoteQuota {
    note: NoteId,
    allowed_parts: usize,
    paid: BTreeSet<ContentDigest>,
    charged_parts: usize,
    release_on_refusal: bool,
    refused: bool,
}

impl NoteQuota {
    pub(super) fn admit(&mut self, inputs: &[EmbeddingInput]) -> Result<(), DomainError> {
        let Some(EmbeddingInput::Part(first)) = inputs.first() else {
            unreachable!()
        };
        if first.provenance().reference().note_id != self.note {
            return Ok(());
        }
        if self.paid.len() >= self.allowed_parts {
            self.refused = true;
            if self.release_on_refusal {
                self.allowed_parts = usize::MAX;
            }
            return Err(DomainError::RateLimited {
                budget: BudgetKind::Tokens,
                retry_after_ms: 50,
            });
        }
        self.charged_parts += inputs.len();
        for input in inputs {
            let EmbeddingInput::Part(part) = input else {
                unreachable!()
            };
            self.paid.insert(part.part().key());
        }
        Ok(())
    }
}

pub async fn atomic_note_budget(store: Arc<CanonicalStore>, root: DataRoot) {
    let tag = 0x7c;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "atomic-note-budget".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let large = sample_note_id(1);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(View::new(space.scope.clone(), folder.clone())),
        live: RwLock::new(BTreeSet::new()),
    });
    let provider = Arc::new(ModelProvider::default());
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.model_resolver = Some(Arc::new(SwitchingResolver::new(5, 512)));
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();

    let commit_revision = async |revision: u8, carrier: String| {
        let healthy = sample_note_id(revision + 1);
        let mut doc = note(&large, &folder, "Large", "");
        doc.carrier = carrier;
        let (written, _) = store
            .commit_synthetic_note_batch_for_test(
                &space.scope,
                lease,
                &owner,
                vec![
                    doc,
                    note(
                        &healthy,
                        &folder,
                        "Healthy",
                        &format!("Unaffected {revision}."),
                    ),
                ],
            )
            .await
            .unwrap();
        {
            let mut view = projection.snapshot.write().unwrap();
            let mut live = projection.live.write().unwrap();
            if live.insert(large.clone()) {
                view.index(large.clone(), folder.clone());
            }
            live.insert(healthy.clone());
            view.index(healthy.clone(), folder.clone());
            view.advance(written.last_seq);
        }
        (healthy, written.last_seq)
    };
    let search = async || {
        engine
            .search(context(&space.scope, &owner), query("semanticbudgetprobe"))
            .await
            .unwrap()
    };
    let wait_for_complete = async |sequence: SpaceSeq| {
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let manifest = layout.search_manifest().unwrap().unwrap();
                if manifest.vector_seq == Some(sequence)
                    && !manifest.embeddings_pending
                    && search().await.hits.iter().any(|hit| {
                        hit.card.document.provenance().reference().note_id == large
                            && hit
                                .chunks
                                .iter()
                                .any(|chunk| chunk.text().contains("atomiclastpiece"))
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the complete revision must become searchable after embedding settles");
    };

    // Cold seed, warm segmented replacement, and warm inline replacement.
    for (revision, parts, allowed_parts) in [(1, 320, 256), (2, 320, 256), (3, 32, 16)] {
        *provider.note_quota.lock().unwrap() = Some(NoteQuota {
            note: large.clone(),
            allowed_parts,
            paid: BTreeSet::new(),
            charged_parts: 0,
            release_on_refusal: false,
            refused: false,
        });
        let carrier = (0..parts)
            .map(|i| {
                let marker = if i + 1 == parts {
                    "atomiclastpiece"
                } else {
                    ""
                };
                format!(
                    "# Revision {revision} section {i}\n\nUnique text {revision} {i}. {marker}\n\n"
                )
            })
            .collect();
        let (healthy, sequence) = commit_revision(revision, carrier).await;
        if revision == 1 {
            engine.start_space(space.scope.clone()).unwrap();
        }

        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                if provider
                    .note_quota
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .refused
                {
                    let hits: BTreeSet<_> = search()
                        .await
                        .hits
                        .into_iter()
                        .map(|hit| hit.card.document.provenance().reference().note_id.clone())
                        .collect();
                    if hits.contains(&healthy) {
                        assert!(
                            !hits.contains(&large),
                            "partial revision {revision} appeared in search"
                        );
                        assert!(
                            layout
                                .search_manifest()
                                .unwrap()
                                .unwrap()
                                .embeddings_pending
                        );
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("an unrelated note must be searchable while this note awaits more tokens");

        {
            let mut quota = provider.note_quota.lock().unwrap();
            let quota = quota.as_mut().unwrap();
            assert_eq!(quota.paid.len(), allowed_parts);
            quota.allowed_parts = usize::MAX;
        }
        wait_for_complete(sequence).await;
        assert_eq!(
            provider
                .note_quota
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .paid
                .len(),
            parts
        );
    }

    *provider.note_quota.lock().unwrap() = None;
    // The 17th input is sent alone. In the two-part revision the same terminal
    // zero vector is returned alongside a valid row in one provider response.
    for (revision, parts, expected_batch_len) in [(4, 17, 1), (5, 2, 2)] {
        provider.affected_row_batch_len.store(0, Ordering::SeqCst);
        let carrier = (0..parts)
            .map(|i| {
                let marker = if i + 1 == parts {
                    "atomiczerorow"
                } else {
                    "atomiclastpiece"
                };
                format!("# Section {i}\n\nPermanent {revision} {i} {marker}.\n\n")
            })
            .collect();
        let (_, sequence) = commit_revision(revision, carrier).await;
        wait_for_complete(sequence).await;
        assert_eq!(
            provider.affected_row_batch_len.load(Ordering::SeqCst),
            expected_batch_len
        );
    }

    // A transient error on a single row hides the new revision while a
    // different note in the same commit can already be found.
    provider.fail_transient_row.store(true, Ordering::SeqCst);
    provider.affected_row_batch_len.store(0, Ordering::SeqCst);
    let (healthy, sequence) = commit_revision(
        6,
        "# First\n\nTransient healthy prefix.\n\n# Tail\n\natomictransientrow atomiclastpiece."
            .to_string(),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let hits = search().await.hits;
            if provider.affected_row_batch_len.load(Ordering::SeqCst) == 2
                && hits
                    .iter()
                    .any(|hit| hit.card.document.provenance().reference().note_id == healthy)
            {
                assert!(
                    hits.iter()
                        .all(|hit| hit.card.document.provenance().reference().note_id != large)
                );
                assert!(
                    layout
                        .search_manifest()
                        .unwrap()
                        .unwrap()
                        .embeddings_pending
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a transient row must defer only its own note");
    provider.fail_transient_row.store(false, Ordering::SeqCst);
    wait_for_complete(sequence).await;
    // A single TPM refusal separates two batches. In either order each paid
    // input is sent once, even when the entire first batch is unembeddable.
    for (revision, zero_prefix) in [(7, true), (8, false)] {
        *provider.note_quota.lock().unwrap() = Some(NoteQuota {
            note: large.clone(),
            allowed_parts: 16,
            paid: BTreeSet::new(),
            charged_parts: 0,
            release_on_refusal: true,
            refused: false,
        });
        let carrier = (0..17)
            .map(|i| {
                let marker = if (i < 16) == zero_prefix {
                    "atomiczerorow"
                } else {
                    "atomiclastpiece"
                };
                format!("# Section {i}\n\nQuota {revision} {i} {marker}.\n\n")
            })
            .collect();
        let (_, sequence) = commit_revision(revision, carrier).await;
        wait_for_complete(sequence).await;
        let quota = provider.note_quota.lock().unwrap().take().unwrap();
        assert!(quota.refused);
        assert_eq!(quota.paid.len(), 17);
        assert_eq!(
            quota.charged_parts, 17,
            "paid parts before TPM were replayed"
        );
    }
    engine.shutdown().await;
}
