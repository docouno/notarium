use notarium_core::{
    DomainError,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::ContentDigest,
};

pub(crate) fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

/// Diagnostics identify a stable failure class, never SQL, credentials or paths.
pub(crate) fn unavailable(label: &'static str, effect: CommitEffect) -> PortError {
    let digest = ContentDigest::from_bytes(*blake3::hash(label.as_bytes()).as_bytes());
    PortError::Unavailable(
        OperationalFailure::new(digest, effect, RetryAdvice::Never, false)
            .expect("non-retryable failure is valid"),
    )
}

pub(crate) fn database(_: sqlx::Error) -> PortError {
    unavailable("control database operation", CommitEffect::Unknown)
}

pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db) = error else {
        return false;
    };
    db.is_unique_violation() || matches!(db.code().as_deref(), Some("23505" | "1555" | "2067"))
}

pub(crate) fn database_or_conflict(error: sqlx::Error) -> PortError {
    if is_unique_violation(&error) {
        invalid(ValidationReason::DuplicateKey)
    } else {
        database(error)
    }
}
