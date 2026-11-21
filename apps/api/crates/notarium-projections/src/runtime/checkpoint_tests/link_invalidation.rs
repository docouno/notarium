use super::*;
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    patch::CarrierEditOrigin,
    ports::{EditNote, RenameNote},
};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn edits_reuse_folder_catalog_and_rename_reads_only_dependent_links() {
    for unrelated in [0, 12] {
        let scratch = Scratch::new();
        let root = scratch.root();
        let (canonical, canonical_runtime) = CanonicalRuntime::open(
            CanonicalConfig::local_default(InstallationId::from_bytes(entropy()), root.clone()),
        )
        .await
        .unwrap();
        let ctx = owner(&canonical).await;
        let scope = ctx.scope();
        let derived =
            DerivedStore::open_sqlite(&root, ProjectionGeneration::new(GENERATION).unwrap())
                .await
                .unwrap();
        for i in 0..unrelated {
            let slug = format!("folder-{i}");
            canonical
                .create_folder(CreateFolderSpec {
                    scope: scope.clone(),
                    active_epoch: LeaseEpoch::new(1).unwrap(),
                    folder_id: FolderId::from_bytes(entropy()),
                    parent: None,
                    display_name: slug.clone(),
                    slug,
                    is_project: false,
                    project_slug: None,
                    actor: ctx.auth().principal().clone(),
                    timestamp: None,
                })
                .await
                .unwrap();
        }
        let target = create(&canonical, &ctx, "target", "plain body".into())
            .await
            .value;
        let source = create(
            &canonical,
            &ctx,
            "source",
            format!("{} [[target]]", format!("[[{}]] ", target.note).repeat(500)),
        )
        .await;
        let runtime = start(&canonical, &derived, &root).await;
        let engine = runtime.engine();
        engine
            .wait_for_projected(scope, source.receipt.seq(), &budget())
            .await
            .unwrap();
        let initial = engine.published_cut(scope).unwrap();
        runtime.shutdown().await.unwrap();

        let mut folders = None;
        let stop = Cancellation::default();
        let warm = create(&canonical, &ctx, "warm", "first command in the feed".into())
            .await
            .receipt
            .seq();
        let warmed = apply::command_with_folders(
            &engine,
            &initial,
            CommandSeqRange::new(warm, warm).unwrap(),
            &stop,
            &mut folders,
        )
        .await
        .unwrap()
        .cut;
        assert!(derived.folder_page_reads.swap(0, Ordering::Relaxed) > 0);
        derived.reverse_link_reads.store(0, Ordering::Relaxed);
        let body = notarium_syntax::frontmatter::analyze("plain body", DocClass::UserDoc)
            .unwrap()
            .carrier
            .body;
        let edit = canonical
            .edit_note(
                ctx.clone(),
                Mutation {
                    identity: command_identity(&ctx),
                    preconditions: Preconditions {
                        revision: Some(target.revision),
                        ..Default::default()
                    },
                    input: EditNote {
                        note: target.note.clone(),
                        plan: notarium_syntax::patch::plan(
                            "plain body",
                            body,
                            vec![(CarrierEditOrigin::Body, body, "updated body".into())],
                        )
                        .unwrap(),
                    },
                },
            )
            .await
            .unwrap();
        let q = edit.receipt.seq();
        let edited = apply::command_with_folders(
            &engine,
            &warmed,
            CommandSeqRange::new(q, q).unwrap(),
            &stop,
            &mut folders,
        )
        .await
        .unwrap()
        .cut;
        assert_eq!(derived.folder_page_reads.load(Ordering::Relaxed), 0);
        assert_eq!(derived.reverse_link_reads.load(Ordering::Relaxed), 0);

        let renamed = canonical
            .rename_note(
                ctx.clone(),
                Mutation {
                    identity: command_identity(&ctx),
                    preconditions: Preconditions {
                        revision: Some(edit.value.revision),
                        ..Default::default()
                    },
                    input: RenameNote {
                        note: target.note.clone(),
                        slug: "renamed".into(),
                        title: Some("Renamed".into()),
                    },
                },
            )
            .await
            .unwrap();
        let r = renamed.receipt.seq();
        let current = apply::command_with_folders(
            &engine,
            &edited,
            CommandSeqRange::new(q.checked_next().unwrap(), r).unwrap(),
            &stop,
            &mut folders,
        )
        .await
        .unwrap()
        .cut;
        assert_eq!(derived.folder_page_reads.load(Ordering::Relaxed), 0);
        assert_eq!(derived.reverse_link_reads.load(Ordering::Relaxed), 1);
        let index = engine.open_index(&current).unwrap();
        let dense = index.dense_id(&source.value.note).unwrap();
        let target_dense = index.dense_id(&target.note).unwrap();
        let links = derived
            .link_page(
                &scope.space_id,
                crate::derived::LinkAddress::Source(dense),
                Some(&crate::derived::LinkPosition::from_key(dense, 499)),
                super::super::worker::page_limit(),
            )
            .await
            .unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].raw_target, "target");
        assert_eq!(links[0].resolved_dense_id, Some(target_dense));
        canonical_runtime.shutdown().await.unwrap();
    }
}
