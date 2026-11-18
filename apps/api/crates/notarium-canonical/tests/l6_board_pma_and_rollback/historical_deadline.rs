use super::*;

#[test]
fn sqlite_historical_get_note_respects_the_caller_during_blob_read() {
    use std::time::Duration;

    tokio::runtime::Builder::new_current_thread()
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
                            carrier: "# Before\n".into(),
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
                note,
                revision: Some(created.value.revision),
                causal: CausalBasis::Exact(ReceiptSet::new([changed.receipt]).unwrap()),
            };
            assert!(
                store
                    .get_note(ctx.clone(), historical.clone())
                    .await
                    .is_ok()
            );

            // Historical LocalZstdV1 reads dispatch the verified CAS read to the blocking pool.
            let (occupied, ready) = tokio::sync::oneshot::channel();
            let (release, hold) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                occupied.send(()).unwrap();
                let _ = hold.recv_timeout(Duration::from_secs(3));
            });
            ready.await.unwrap();
            let mut limited = ctx.clone();
            limited.budget.remaining = Duration::from_millis(100);
            let request = store.get_note(limited, historical.clone());
            tokio::pin!(request);
            let result = tokio::time::timeout(Duration::from_millis(400), &mut request).await;
            let _ = release.send(());
            let before_release = result.is_ok();
            let outcome = match result {
                Ok(outcome) => outcome,
                Err(_) => request.await,
            };
            blocker.await.unwrap();
            let code = outcome.as_ref().err().map(PortError::code).unwrap_or("ok");
            assert!(store.get_note(ctx, historical).await.is_ok());
            runtime.shutdown().await.unwrap();
            assert!(
                before_release && matches!(outcome, Err(PortError::DeadlineExceeded(_))),
                "historical read exceeded its original deadline: {code}"
            );
        });
}
