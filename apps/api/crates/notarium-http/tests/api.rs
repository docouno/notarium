use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn get_json(uri: &str) -> (StatusCode, Value) {
    let response = notarium_http::router()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let status = response.status();
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn health_is_json_and_successful() {
    assert_eq!(
        get_json("/health").await,
        (StatusCode::OK, json!({ "status": "ok" }))
    );
}

#[tokio::test]
async fn greeting_uses_default_and_decodes_names() {
    assert_eq!(
        get_json("/api/greeting").await,
        (StatusCode::OK, json!({ "message": "Hello, world!" }))
    );
    assert_eq!(
        get_json("/api/greeting?name=%20Ada%20%26%20Bob%20").await,
        (StatusCode::OK, json!({ "message": "Hello, Ada & Bob!" }))
    );
    assert_eq!(
        get_json("/api/greeting?name=%E4%B8%96%E7%95%8C").await,
        (StatusCode::OK, json!({ "message": "Hello, 世界!" }))
    );
    assert_eq!(
        get_json("/api/greeting?name=%20%20").await,
        (StatusCode::OK, json!({ "message": "Hello, world!" }))
    );
}

#[tokio::test]
async fn rejects_duplicate_name_parameters() {
    let response = notarium_http::router()
        .oneshot(
            Request::builder()
                .uri("/api/greeting?name=Ada&name=Bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rejects_unknown_routes_and_unsupported_methods() {
    let not_found = notarium_http::router()
        .oneshot(
            Request::builder()
                .uri("/missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(not_found.status(), StatusCode::NOT_FOUND);

    let method = notarium_http::router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/greeting")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(method.status(), StatusCode::METHOD_NOT_ALLOWED);
}
