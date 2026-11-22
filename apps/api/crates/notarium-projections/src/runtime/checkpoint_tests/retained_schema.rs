use super::*;
use crate::runtime::{PublishedCut, read::retained_bytes};
use notarium_canonical::UpdateSpaceSchema;
use notarium_core::query::{FieldSchema, FieldType, ScalarType};
use std::{mem::size_of, sync::Arc};

#[tokio::test]
async fn retained_bytes_charge_watermarks_per_cut_and_declarations_per_allocation() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, canonical_runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let ctx = owner(&canonical).await;
    let derived = DerivedStore::open_sqlite(&root, ProjectionGeneration::new(GENERATION).unwrap())
        .await
        .unwrap();
    let schema_note = NoteId::from_bytes(entropy());
    let write = |prefix: &str, expected_schema_revision| {
        let input = UpdateSpaceSchema {
            schema_note: schema_note.clone(),
            parent: None,
            slug: "schema".into(),
            carrier: "Schema".into(),
            schema: (0..128)
                .map(|i| {
                    (
                        format!("{prefix}_{i:04}"),
                        FieldSchema {
                            kind: FieldType::Scalar(ScalarType::String),
                            nullable: false,
                        },
                    )
                })
                .collect(),
            expected_schema_revision,
        };
        canonical.update_space_schema(
            ctx.clone(),
            Mutation {
                identity: command_identity(&ctx),
                preconditions: Preconditions::default(),
                input,
            },
        )
    };
    let initial = write("first", None).await.unwrap();
    let runtime = start(&canonical, &derived, &root).await;
    let engine = runtime.engine();
    let capture = async |seq| {
        engine
            .wait_for_projected(ctx.scope(), seq, &budget())
            .await
            .unwrap();
        engine.published_cut(ctx.scope()).unwrap()
    };
    let first = capture(initial.receipt.seq()).await;
    let edit = create(&canonical, &ctx, "plain", "Unrelated content".into()).await;
    let next = capture(edit.receipt.seq()).await;
    let schema_edit = write("replacement", Some(initial.value.schema_revision))
        .await
        .unwrap();
    let changed = capture(schema_edit.receipt.seq()).await;
    assert!(!Arc::ptr_eq(&first, &next));
    assert!(Arc::ptr_eq(&first.fields, &next.fields));
    assert!(!Arc::ptr_eq(&first.fields, &changed.fields));
    assert!(!Arc::ptr_eq(&next.delta, &changed.delta));

    let publication_size = |cut: &PublishedCut| {
        size_of::<PublishedCut>()
            + cut
                .watermark
                .schema
                .as_ref()
                .unwrap()
                .fields_msgpack
                .capacity()
    };
    let repeated = retained_bytes([(&first, 1000), (&first, 2000)]);
    assert_eq!(
        repeated,
        3000 + publication_size(&first) + first.fields.retained_bytes + first.delta.approx_bytes()
    );
    let mut expected = repeated + 3000 + publication_size(&next);
    if !Arc::ptr_eq(&first.delta, &next.delta) {
        expected += next.delta.approx_bytes();
    }
    assert_eq!(
        retained_bytes([(&first, 1000), (&first, 2000), (&next, 3000)]),
        expected
    );
    expected +=
        publication_size(&changed) + changed.fields.retained_bytes + changed.delta.approx_bytes();
    assert_eq!(
        retained_bytes([(&first, 1000), (&first, 2000), (&next, 3000), (&changed, 0)]),
        expected
    );
    for cut in [&first, &changed] {
        assert!(
            cut.fields.retained_bytes
                >= cut
                    .fields
                    .keys()
                    .map(|k| k.capacity() + size_of::<String>() + size_of::<FieldSchema>())
                    .sum::<usize>()
        );
    }
    runtime.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
}
