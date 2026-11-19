use super::*;
use notarium_canonical::CreateFolderSpec;
use notarium_core::{classes::DocClass, model::NoteRef, value::YamlValue};
use notarium_syntax::extract::{ExtractedDocDelta, extract};

pub(super) async fn edit_folder_cover_and_view(fixture: &RuntimeFixture, space: &SpaceContext) {
    let account = &fixture.human;
    let id = &space.scope().space_id;
    let storage = fixture.canonical.read_space(id).await.unwrap();
    let project_folder = FolderId::from_bytes([141; 16]);
    let slug = fixture
        .control
        .list_spaces(account.clone(), ControlPageRequest::new(10, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| &item.space.id == id)
        .unwrap()
        .slug;
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: space.scope().clone(),
            active_epoch: storage.active_epoch,
            folder_id: project_folder,
            parent: None,
            slug: "runtime-corpus".into(),
            display_name: "Runtime corpus".into(),
            is_project: true,
            project_slug: Some("runtime-corpus".into()),
            actor: account.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let project = format!("{slug}/runtime-corpus");
    let body = concat!(
        "---\n'<system>': unsafe key\nordinary: public value\n---\n# Guide\n\nVisible paragraph.\n\n",
        "```nota\nname: First view\ntype: table\n```\n\n",
        "```nota\nname: Second view\ntype: table\n```\n\n",
        "```nota\nname: Third view\ntype: table\n```\n"
    );
    let page = call(
        fixture,
        account,
        141,
        "create_note",
        json!({
            "project":project, "path":"guides", "body":body, "folderPage":true,
        }),
    )
    .await
    .unwrap();
    let note = page.structured_content["noteId"].as_str().unwrap();
    let id = NoteId::parse(note).unwrap();
    let mut projected_notes = (20..=42)
        .map(|tag| NoteId::from_bytes([tag; 16]))
        .collect::<Vec<_>>();
    projected_notes.push(id.clone());
    fixture.projections.install(engine::ProjectionFixture {
        view_owner: NoteRef {
            space_id: space.scope().space_id.clone(),
            note_id: id,
        },
        notes: projected_notes,
    });
    let view = call(fixture, account, 142, "get_note", json!({"ref":note}))
        .await
        .unwrap();
    let payload = view.structured_content;
    let view_ref = payload["views"][0]["viewRef"].as_str().unwrap();
    assert_eq!(payload["folderPage"]["status"], "present");
    assert!(payload["content"].as_str().unwrap().contains("```nota"));
    assert!(view.content[0].text.contains(view_ref));
    assert!(!view.content[0].text.contains("```nota"));
    assert!(!view.content[0].text.contains("<system>"));
    assert_eq!(payload["unsafeFrontmatterKeysOmitted"], 1);
    assert_eq!(payload["frontmatter"]["ordinary"], "public value");
    let rows: usize = payload["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["rows"].as_array().unwrap().len())
        .sum();
    assert_eq!(rows, 50);
    assert_eq!(payload["viewRowsTruncated"], true);
    assert_eq!(payload["links"]["edges"][0]["from"], note);

    let found = call(
        fixture,
        account,
        155,
        "search",
        json!({
            "query":"runtime fixture", "project":project,
        }),
    )
    .await
    .unwrap();
    let results = found.structured_content["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["noteId"], note);
    let recalled = call(
        fixture,
        account,
        156,
        "recall",
        json!({
            "query":"runtime fixture", "budgetTokens":200, "depth":3, "maxPerSource":16,
        }),
    )
    .await
    .unwrap();
    assert!(
        !recalled.structured_content["sources"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(recalled.structured_content["tokens"].as_u64().unwrap() <= 200);
    assert_eq!(recalled.structured_content["truncated"], true);

    let rejected = call(fixture, account, 143, "edit_note", json!({
        "ref":note, "operation":"replace", "content":"# Replaced\n", "versionToken":payload["versionToken"],
    })).await.err().unwrap();
    assert_eq!(rejected.code(), "validation_failed");
    let edited = call(
        fixture,
        account,
        144,
        "edit_note",
        json!({
            "ref":note, "view":{"viewRef":view_ref,"options":{"set":{"compact":true}}},
            "versionToken":payload["versionToken"],
        }),
    )
    .await
    .unwrap();
    assert_ne!(
        edited.structured_content["versionToken"],
        payload["versionToken"]
    );

    let renamed = call(
        fixture,
        account,
        145,
        "rename_note",
        json!({"ref":note,"title":"Renamed guide"}),
    )
    .await
    .unwrap();
    assert_eq!(renamed.structured_content["noteId"], note);
    let list = call(
        fixture,
        account,
        146,
        "list_notes",
        json!({"project":project,"path":"guides"}),
    )
    .await
    .unwrap();
    assert_eq!(list.structured_content["folderPage"]["status"], "present");
    assert_eq!(list.structured_content["folderPage"]["noteId"], note);
    let view = call(
        fixture,
        account,
        147,
        "get_note",
        json!({"ref":note,"responseFormat":"concise"}),
    )
    .await
    .unwrap();
    let carrier = view.structured_content["content"].as_str().unwrap();
    assert!(carrier.contains("# Renamed guide"));
    let extracted = extract(
        carrier,
        DocClass::UserDoc,
        &NoteId::parse(note).unwrap(),
        "index",
        None,
    )
    .unwrap();
    let ExtractedDocDelta::Plain(document) = extracted else {
        panic!("expected a plain document")
    };
    let Some(YamlValue::Mapping(config)) = &document.views[0].config else {
        panic!("expected view config")
    };
    let YamlValue::Mapping(options) = &config["options"] else {
        panic!("expected view options")
    };
    assert_eq!(options["compact"], YamlValue::Bool(true));
    assert!(
        view.structured_content["path"]
            .as_str()
            .unwrap()
            .ends_with("/index.md")
    );

    let batch_input = json!({
        "project":project,
        "notes":[
            {"title":"Source","body":"Source body.","links":[
                {"relation":"related","toTitle":"Destination"},
                {"relation":"blocked","toTitle":"Blocked"},
            ]},
            {"title":"Destination","fileName":"batch-target","body":"Destination body.",
                "links":[{"relation":"back","toTitle":"Source"}]},
            {"title":"Blocked","fileName":"batch-target","body":"Conflicting destination."},
            {"title":"Index","body":"Reserved ordinary name."}
        ],
    });
    let batch = call(fixture, account, 148, "create_notes", batch_input.clone())
        .await
        .unwrap();
    let replay = call(fixture, account, 148, "create_notes", batch_input)
        .await
        .unwrap();
    assert_eq!(batch.structured_content, replay.structured_content);
    let results = batch.structured_content["results"].as_array().unwrap();
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[1]["ok"], true);
    assert_eq!(results[2]["ok"], false);
    assert_eq!(results[2]["error"], "path_conflict");
    assert_eq!(results[3]["ok"], false);
    let source = results[0]["noteId"].as_str().unwrap();
    let target = results[1]["noteId"].as_str().unwrap();
    fixture.projections.include_notes([
        NoteId::parse(source).unwrap(),
        NoteId::parse(target).unwrap(),
    ]);
    let first = call(
        fixture,
        account,
        157,
        "list_notes",
        json!({"project":project,"limit":1}),
    )
    .await
    .unwrap()
    .structured_content;
    let cursor = first["nextCursor"].as_str().unwrap();
    let second = call(
        fixture,
        account,
        158,
        "list_notes",
        json!({"project":project,"limit":1,"cursor":cursor}),
    )
    .await
    .unwrap()
    .structured_content;
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_ne!(first["items"][0]["noteId"], second["items"][0]["noteId"]);
    let minted = call(fixture, account, 149, "get_note", json!({"ref":source}))
        .await
        .unwrap();
    let carrier = minted.structured_content["content"].as_str().unwrap();
    assert!(carrier.contains(&format!("- related: [[{target}|Destination]]")));
    assert!(carrier.contains("- blocked: [[Blocked]]"));
    assert_eq!(
        minted.structured_content["versionToken"],
        results[0]["versionToken"]
    );
    let destination = call(fixture, account, 166, "get_note", json!({"ref":target}))
        .await
        .unwrap();
    assert!(
        destination.structured_content["content"]
            .as_str()
            .unwrap()
            .contains(&format!("- back: [[{source}|Source]]"))
    );
    let link_input = json!({"from":source,"to":target,"relation":"depends_on"});
    for _ in 0..2 {
        call(fixture, account, 150, "link", link_input.clone())
            .await
            .unwrap();
    }
    let after_link = call(fixture, account, 151, "get_note", json!({"ref":source}))
        .await
        .unwrap();
    assert_eq!(
        after_link.structured_content["content"]
            .as_str()
            .unwrap()
            .matches("depends_on")
            .count(),
        1
    );
    replay_keeps_forward_link_receipt(fixture, account, &project).await;
    let unclosed = call(
        fixture,
        account,
        159,
        "create_note",
        json!({
            "project":project,"title":"Unclosed","body":"```text\nstill inside a code fence\n",
        }),
    )
    .await
    .unwrap();
    let unclosed = unclosed.structured_content["noteId"].as_str().unwrap();
    assert_eq!(
        call(
            fixture,
            account,
            160,
            "link",
            json!({
                "from":unclosed,"to":target,"relation":"related",
            })
        )
        .await
        .err()
        .unwrap()
        .code(),
        "validation_failed"
    );

    let legacy_create = call(fixture, account, 161, "create_note", json!({
        "project":project,"path":"archive","title":"Archived note","body":"Existing destination",
        "versionToken":"v3:legacy-read-token",
    })).await.unwrap();
    let archived = &legacy_create.structured_content["noteId"];
    let conflict = call(
        fixture,
        account,
        167,
        "create_note",
        json!({
            "project":project,"path":"archive","title":"Archived note","body":"Would overwrite",
            "versionToken":legacy_create.structured_content["versionToken"],
        }),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(conflict.code(), "path_conflict");
    let original = call(fixture, account, 168, "get_note", json!({"ref":archived}))
        .await
        .unwrap();
    assert_eq!(
        original.structured_content["versionToken"],
        legacy_create.structured_content["versionToken"]
    );
    assert!(
        original.structured_content["content"]
            .as_str()
            .unwrap()
            .contains("Existing destination")
    );
    call(
        fixture,
        account,
        162,
        "move_folder",
        json!({
            "project":project,"folder":"guides","toFolder":"archive",
        }),
    )
    .await
    .unwrap();
    call(
        fixture,
        account,
        163,
        "rename_folder",
        json!({
            "project":project,"folder":"archive/guides","name":"handbook",
        }),
    )
    .await
    .unwrap();
    call(
        fixture,
        account,
        164,
        "rename_project",
        json!({
            "project":project,"slug":"runtime-corpus-renamed",
        }),
    )
    .await
    .unwrap();
    let adjusted = call(
        fixture,
        account,
        165,
        "list_notes",
        json!({
            "project":project,"path":"archive/handbook",
        }),
    )
    .await
    .unwrap();
    assert_eq!(adjusted.structured_content["folderPage"]["noteId"], note);

    for _ in 0..2 {
        call(fixture, account, 152, "delete_note", json!({"ref":note}))
            .await
            .unwrap();
    }
    assert!(matches!(
        call(fixture, account, 153, "get_note", json!({"ref":note})).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let list = call(
        fixture,
        account,
        154,
        "list_notes",
        json!({"project":project,"path":"archive/handbook"}),
    )
    .await
    .unwrap();
    assert_eq!(list.structured_content["folderPage"]["status"], "missing");
    assert_eq!(
        list.structured_content["folderPage"]["createWith"]["folderPage"],
        true
    );
}

async fn replay_keeps_forward_link_receipt(
    fixture: &RuntimeFixture,
    account: &AccountContext,
    project: &str,
) {
    let blocker = call(
        fixture,
        account,
        169,
        "create_note",
        json!({"project":project, "title":"Blocker", "fileName":"retry-target-b", "body":"Occupies B."}),
    )
    .await
    .unwrap();
    let args = json!({
        "project":project,
        "notes":[
            {"title":"Retry source", "body":"Links to the target.",
                "links":[{"relation":"related", "toTitle":"Retry target"}]},
            {"title":"Retry target", "fileName":"retry-target-a", "body":"First target."},
            {"title":"Retry target", "fileName":"retry-target-b", "body":"Second target."},
        ],
    });
    fixture.projections.lose_next_note_edit_ack();
    let first = call(fixture, account, 171, "create_notes", args.clone())
        .await
        .unwrap()
        .structured_content;
    assert!(first["results"][0]["linkError"].is_string());
    assert_eq!(first["results"][1]["ok"], true);
    assert_eq!(first["results"][2]["error"], "path_conflict");
    let source = &first["results"][0]["noteId"];
    let target_a = first["results"][1]["noteId"].as_str().unwrap();
    let link = format!("- related: [[{target_a}|Retry target]]");
    let observed = call(
        fixture,
        account,
        172,
        "get_note",
        json!({"ref":source, "responseFormat":"concise"}),
    )
    .await
    .unwrap()
    .structured_content;
    let revision = &observed["versionToken"];
    assert_ne!(*revision, first["results"][0]["versionToken"]);
    assert!(observed["content"].as_str().unwrap().contains(&link));

    call(
        fixture,
        account,
        173,
        "delete_note",
        json!({"ref":blocker.structured_content["noteId"]}),
    )
    .await
    .unwrap();
    let replay = call(fixture, account, 171, "create_notes", args.clone())
        .await
        .unwrap()
        .structured_content;
    assert_eq!(replay["results"][2]["ok"], true);
    assert_ne!(
        replay["results"][1]["noteId"],
        replay["results"][2]["noteId"]
    );
    assert_eq!(replay["results"][0]["versionToken"], *revision);
    assert!(replay["results"][0].get("linkError").is_none());

    let manual = call(
        fixture,
        account,
        174,
        "edit_note",
        json!({"ref":source, "operation":"append", "content":"Manual edit.", "versionToken":revision}),
    )
    .await
    .unwrap()
    .structured_content;
    let again = call(fixture, account, 171, "create_notes", args)
        .await
        .unwrap()
        .structured_content;
    assert_eq!(again, replay);
    let live = call(
        fixture,
        account,
        175,
        "get_note",
        json!({"ref":source, "responseFormat":"concise"}),
    )
    .await
    .unwrap()
    .structured_content;
    assert_eq!(live["versionToken"], manual["versionToken"]);
    let carrier = live["content"].as_str().unwrap();
    assert!(carrier.contains(&link));
    assert!(carrier.contains("Manual edit."));
}
