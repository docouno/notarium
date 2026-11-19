use super::*;

async fn admissions(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let _network = crate::TEST_RESOURCE_LOCK.lock().await;
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let server = HttpsFixture::start(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        completion_reply(ProviderWireKind::OpenaiCompatible, 1)
    });
    let mut setup = Setup::new(
        pg,
        "dispatch_admission",
        ProviderWireKind::OpenaiCompatible,
        &server,
    )
    .await;
    let metadata = setup.document.metadata();
    let catalog = setup
        .fixture
        .catalog
        .space(budget(), setup.space.scope().space_id.clone())
        .await
        .unwrap();
    let encrypted = ClassifiedMetadata::from_canonical(
        metadata.reference().clone(),
        metadata.revision().clone(),
        ResourceFacts {
            space: catalog.space,
            class: DocClass::EncryptedNote,
            project: None,
            ancestor_folders: vec![],
            folder_write_locked: false,
            ability_package: None,
        },
        Lifecycle::Active,
        metadata.digest(),
    )
    .unwrap();
    *setup.egress.current.lock().unwrap() = vec![ProviderCurrentContent::Note(encrypted)];
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(40))
            .await
            .is_err()
    );
    *setup.egress.current.lock().unwrap() = vec![ProviderCurrentContent::Note(metadata)];
    for (deny, restore) in [
        (
            "UPDATE space_admission SET state='archived'",
            "UPDATE space_admission SET state='active'",
        ),
        (
            "UPDATE provider_attachments SET state='revoked'",
            "UPDATE provider_attachments SET state='approved'",
        ),
        (
            "UPDATE provider_attachments SET expires_at=1",
            "UPDATE provider_attachments SET expires_at=NULL",
        ),
        (
            "UPDATE credentials SET disabled_at=1",
            "UPDATE credentials SET disabled_at=NULL",
        ),
        (
            "UPDATE provider_resources SET disabled_at=1",
            "UPDATE provider_resources SET disabled_at=NULL",
        ),
    ] {
        // Inject current durable state after caller selection to prove that
        // neither its context nor its classified wrapper authorizes dispatch.
        setup.fixture.observer.execute(deny).await;
        assert!(
            complete(&setup.provider, setup.space.clone(), setup.completion(40))
                .await
                .is_err()
        );
        setup.fixture.observer.execute(restore).await;
    }
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert_eq!(
        setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_call_log")
            .await,
        0
    );
    // Independent service instances, pools and writer admissions share the SQL
    // budget. Unknown usage makes the reservation observable until window end.
    for provider in [&mut setup.provider, &mut setup.other] {
        provider.config.default_space_limits = ProviderLimits {
            requests_per_minute: Some(7),
            tokens_per_minute: Some(3 * 41),
        };
    }
    let mut tasks = tokio::task::JoinSet::new();
    for id in 50..90 {
        let provider = if id % 2 == 0 {
            setup.provider.clone()
        } else {
            setup.other.clone()
        };
        let request = setup.completion(id);
        let ctx = setup.space.clone();
        tasks.spawn(async move { complete(&provider, ctx, request).await });
    }
    let mut successful = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(events) => {
                successful += 1;
                assert!(matches!(
                    events[1],
                    CompletionEvent::Usage(ProviderUsage::Unknown)
                ));
            }
            Err(PortError::Domain(DomainError::RateLimited { .. })) => {}
            Err(error) => panic!("unexpected admission result: {error:?}"),
        }
    }
    assert_eq!(successful, 3);
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    assert_eq!(setup.fixture.observer.count("SELECT COUNT(*) FROM provider_budget_buckets WHERE rpm_used=3 AND tpm_reserved=123 AND tpm_exact=0").await,3);
    assert_eq!(setup.fixture.observer.count("SELECT COUNT(*) FROM provider_call_log WHERE delivery_state='settled' AND usage_source='unknown'").await,3);
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 0);
    setup.close().await;
}
#[tokio::test]
async fn sqlite_current_authority_and_shared_budget() {
    admissions(false).await;
}
#[tokio::test]
async fn postgres_current_authority_and_shared_budget() {
    admissions(true).await;
}
