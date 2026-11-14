//! A small HTTP API shared by the standalone and mixed-project examples.

use axum::{Json, Router, extract::Query, routing::get};
use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};

#[derive(Deserialize)]
struct GreetingQuery {
    name: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct Greeting {
    message: String,
}

#[derive(Serialize, ToSchema)]
struct Health {
    status: String,
}

/// Build a greeting from an optional human-provided name.
///
/// ```
/// assert_eq!(notarium_http::greeting(Some(" Ada ")), "Hello, Ada!");
/// assert_eq!(notarium_http::greeting(None), "Hello, world!");
/// ```
pub fn greeting(name: Option<&str>) -> String {
    let name = name.map(str::trim).filter(|value| !value.is_empty());
    format!("Hello, {}!", name.unwrap_or("world"))
}

/// Construct the API without binding a socket, so routing can be tested in process.
pub fn router() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/greeting", get(greet))
}

#[utoipa::path(get, path = "/health", responses((status = 200, body = Health)))]
async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".into(),
    })
}

#[utoipa::path(get, path = "/api/greeting", params(("name" = Option<String>, Query, description = "Starter greeting subject")), responses((status = 200, body = Greeting), (status = 400, description = "Invalid query")))]
async fn greet(Query(query): Query<GreetingQuery>) -> Json<Greeting> {
    Json(Greeting {
        message: greeting(query.name.as_deref()),
    })
}

#[cfg(test)]
mod tests {
    use super::greeting;

    #[test]
    fn defaults_missing_and_blank_names() {
        assert_eq!(greeting(None), "Hello, world!");
        assert_eq!(greeting(Some(" \t\n")), "Hello, world!");
    }

    #[test]
    fn trims_names_without_losing_unicode() {
        assert_eq!(greeting(Some("  世界  ")), "Hello, 世界!");
    }

    #[test]
    fn treats_name_as_literal_text() {
        assert_eq!(greeting(Some("<Ada & Bob>")), "Hello, <Ada & Bob>!");
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Notarium bootstrap API",
        version = "1.0.0-dev.0",
        description = "Infrastructure and starter examples only; product API is added in later waves."
    ),
    paths(health, greet),
    components(schemas(Health, Greeting))
)]
struct BootstrapApi;

/// Emit the code-first OpenAPI 3.1 bootstrap contract.
pub fn openapi() -> utoipa::openapi::OpenApi {
    BootstrapApi::openapi()
}
