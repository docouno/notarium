use super::*;

#[test]
fn sqlite_note_reads_and_edits_preserve_the_budget_across_cas_and_writer_ack() {
    use notarium_core::error::{CommitEffect, RetryAdvice};
    use std::time::Duration;

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
        .block_on(async {
            let root = TempDataRoot::new("historical-budget");
            let config =
                CanonicalConfig::local_default(sample_installation_id(77), root.data_root());
            let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
            let owner = sample_principal_id(77);
            let (scope, _) = seed_space(
                &store,
                sample_space_id(77),
                sample_incarnation(77),
                owner.clone(),
            )
            .await;
            let ctx = owner_ctx(&scope, owner.clone());
            let note = sample_note_id(77);
            let created = store
                .create_note(
                    ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        CreateNote {
                            note: note.clone(),
                            parent: None,
                            slug: "before".into(),
                            class: DocClass::UserDoc,
                            carrier: format!("# Before\n{}", "x".repeat(72 * 1024)),
                        },
                    ),
                )
                .await
                .unwrap();
            let changed = store
                .rename_note(
                    ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        RenameNote {
                            note: note.clone(),
                            slug: "after".into(),
                            title: None,
                        },
                    ),
                )
                .await
                .unwrap();
            let historical = GetNote {
                note: note.clone(),
                revision: Some(created.value.revision),
                causal: CausalBasis::Exact(ReceiptSet::new([changed.receipt.clone()]).unwrap()),
            };
            assert!(
                store
                    .get_note(ctx.clone(), historical.clone())
                    .await
                    .is_ok()
            );

            let head = GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            };
            let before = store.get_note(ctx.clone(), head.clone()).await.unwrap();
            let plan = extract::finalize_document(
                before.document.explicit_read(ctx.auth()).unwrap(), DocClass::UserDoc, &note,
                &[FieldEdit::Set { key: "status".into(), value: YamlValue::String("done".into()) }],
            ).unwrap();
            let edit = next_mutation(&scope, &owner, EditNote { note, plan });

            // Both the historical read and this large edit need the only blocking worker.
            let (occupied, ready) = tokio::sync::oneshot::channel();
            let (release, hold) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                occupied.send(()).unwrap();
                let _ = hold.recv_timeout(Duration::from_secs(3));
            });
            ready.await.unwrap();
            let mut limited = ctx.clone();
            limited.budget.remaining = Duration::from_millis(100);
            let requests = async {
                tokio::join!(
                    store.get_note(limited.clone(), historical.clone()),
                    store.edit_note(limited, edit.clone()),
                )
            };
            let result = tokio::time::timeout(Duration::from_millis(500), requests).await;
            let _ = release.send(());
            let (read_result, edit_result) = result.expect("CAS waits exceeded the caller's deadline");
            blocker.await.unwrap();
            for error in [read_result.unwrap_err(), edit_result.unwrap_err()] {
                assert!(matches!(error, PortError::DeadlineExceeded(ref f) if f.effect()==CommitEffect::NotCommitted), "{error:?}");
            }
            assert!(store.get_note(ctx.clone(), historical).await.is_ok());
            assert_eq!(store.read_space(&scope.space_id).await.unwrap().last_seq, changed.receipt.seq());

            // The actor owns the admitted edit even if its caller stops waiting for the receipt.
            let hold = store.acquire_writer_safe_point().await.unwrap();
            let mut short = ctx.clone();
            short.budget.remaining = Duration::from_millis(300);
            let result = tokio::time::timeout(Duration::from_secs(2), store.edit_note(short, edit.clone())).await;
            drop(hold);
            let error = result.expect("caller remained blocked behind the writer gate").unwrap_err();
            assert!(matches!(error, PortError::Unavailable(ref f) if f.effect()==CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand), "{error:?}");
            let recovered = store.edit_note(ctx.clone(), edit.clone()).await.unwrap();
            let replayed = store.edit_note(ctx, edit).await.unwrap();
            assert_eq!(recovered.receipt, replayed.receipt);
            assert_eq!(replayed.receipt.seq().get(), changed.receipt.seq().get()+1);
            runtime.shutdown().await.unwrap();
        });
}
