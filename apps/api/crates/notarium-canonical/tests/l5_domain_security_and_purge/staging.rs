use super::*;

pub(super) async fn verify_write_admission(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    entry: &NoteId,
    ability: &AbilityId,
    gate: Option<&PausedObjectRead>,
    local: Option<&TempDataRoot>,
) {
    let restricted = make_human_ctx(
        scope,
        owner.clone(),
        SpaceGrant {
            role: SpaceRole::Owner,
            read_classes: DocClass::all(),
            write_classes: BTreeSet::new(),
            project_root: None,
        },
        true,
        true,
    );
    let put_count = || gate.map_or(0, |gate| gate.data_puts.load(Ordering::SeqCst));
    let before = put_count();
    let create = |seed: u8| CreateNote {
        note: sample_note_id(seed),
        parent: None,
        slug: format!("admission-{seed}"),
        class: DocClass::UserDoc,
        carrier: format!("# Admission {seed}\n"),
    };
    let file = |name: &str| AbilityFile {
        path: format!("{name}.txt"),
        content: name.to_owned(),
        digest: notarium_syntax::content_digest(name),
    };
    let package = || PublishAbilityPackage {
        ability: ability.clone(),
        kind: AbilityKind::Skill,
        entrypoint: entry.clone(),
        files: vec![file("first-auxiliary"), file("second-auxiliary")],
        expected_package_revision: None,
    };
    let denied = store
        .create_note(
            restricted.clone(),
            next_mutation(scope, owner, create(0xbd)),
        )
        .await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    let denied = store
        .accept_batch(
            restricted.clone(),
            AcceptBatch {
                items: vec![next_mutation(scope, owner, BatchItem::Create(create(0xbe)))],
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        denied.items.as_slice(),
        [Err(DomainError::SpaceReadOnly)]
    ));
    let denied = store
        .publish_ability_package(restricted, next_mutation(scope, owner, package()))
        .await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(put_count(), before);
    if let Some(root) = local {
        for text in [
            create(0xbd).carrier,
            create(0xbe).carrier,
            file("first-auxiliary").content,
            file("second-auxiliary").content,
        ] {
            assert!(
                !root
                    .data_root()
                    .blob(&scope.space_id, notarium_syntax::content_digest(&text))
                    .exists()
            );
        }
    }
    if let Some(gate) = gate {
        // An accepted first upload followed by an unavailable second upload discards both private publications.
        gate.fail_put.store(before + 2, Ordering::SeqCst);
        let result = store
            .publish_ability_package(
                owner_ctx(scope, owner.clone(), true, true),
                next_mutation(scope, owner, package()),
            )
            .await;
        assert!(matches!(result, Err(PortError::Unavailable(_))));
        assert_eq!(put_count(), before + 2);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if store
                    .execute_diagnostic_read_sql_for_test(
                        None,
                        "SELECT COUNT(*) FROM blob_retirements WHERE status='pending'",
                    )
                    .await
                    .unwrap()
                    == 0
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        })
        .await
        .unwrap();
        let files = package().files;
        for f in files {
            let hex = f.digest.to_hex();
            let sql = format!(
                "SELECT COUNT(*) FROM blob_publications WHERE encode(content_blake3,'hex')='{hex}' AND state='retired'"
            );
            assert_eq!(
                store
                    .execute_diagnostic_read_sql_for_test(None, &sql)
                    .await
                    .unwrap(),
                1
            );
        }
    }
}
