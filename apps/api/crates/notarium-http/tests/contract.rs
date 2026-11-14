#[test]
fn checked_in_contract_matches_code_first_openapi() {
    let first = notarium_http::openapi().to_pretty_json().unwrap();
    assert_eq!(first, notarium_http::openapi().to_pretty_json().unwrap());
    let document: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(document["openapi"], "3.1.0");
    assert!(document["paths"]["/health"]["get"].is_object());
    assert!(document["paths"]["/api/greeting"]["get"].is_object());
    assert!(document["components"]["schemas"]["Greeting"].is_object());
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../packages/api-contract/openapi.v1.json");
    let checked_in: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("run make contract-sync"))
            .unwrap();
    assert_eq!(
        document, checked_in,
        "run make contract-sync after changing API declarations"
    );
}
