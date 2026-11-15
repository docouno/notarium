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
