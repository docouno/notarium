//! Stable domain errors and safe operational outcomes, independent of transports.
use crate::ids::{ContentDigest, LineageEpoch, RevisionId};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;
pub type DomainResult<T> = Result<T, DomainError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationReason {
    InvalidId,
    InvalidDigest,
    SequenceOverflow,
    ZeroReceipt,
    InvalidSpan,
    InvalidUtf8,
    InvalidUtf16,
    SourceMismatch,
    OverlappingEdits,
    OriginMismatch,
    HistoryIncarnationMismatch,
    CursorScopeMismatch,
    CursorStale,
    InvalidCutoff,
    PurgeResync,
    NotReady,
    ReceiptLimitExceeded,
    InvalidQuery,
    UnsupportedQueryVersion,
    UnsupportedSortType,
    InvalidRange,
    InvalidDate,
    InvalidTimestamp,
    InvalidNumber,
    InvalidLimit,
    InvalidAuthority,
    ClassMismatch,
    ClassEgressForbidden,
    ProviderConsentRequired,
    ProviderContentFiltered,
    ProtectedField,
    InvalidPathComponent,
    FilenameTooLong,
    DisallowedCodePoint,
    ForbiddenKey,
    InvalidYaml,
    FmNotWritable,
    UnterminatedFrontmatter,
    DuplicateKey,
    AmbiguousClass,
    InvalidView,
    DuplicateViewId,
    PendingView,
    AmbiguousSection,
    UnsupportedContainer,
    InvalidAgeCarrier,
    InvalidArmor,
    MissingModelProfile,
    TokenBudgetExceeded,
    InvalidState,
    BudgetExceeded,
    GenerationMismatch,
    ScopeMismatch,
}

/// Structured positions are facts, never source snippets or parser messages.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub reason: ValidationReason,
    pub location: Option<SourceLocation>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub byte_offset: u64,
    pub line: u64,
    pub column: u64,
    pub code_point: Option<char>,
}

#[derive(Clone, Debug, Eq, PartialEq, Error, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum DomainError {
    #[error("provider request rejected")]
    Provider {
        error: crate::ports::provider::ProviderErrorCode,
    },
    #[error("provider intent already admitted")]
    ProviderCallAlreadyStarted {
        call: crate::ids::RequestId,
        state: crate::ports::provider::ProviderDeliveryState,
    },
    #[error("OAuth request rejected")]
    OAuth {
        error: crate::ports::oauth::OAuthErrorCode,
    },
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("access denied")]
    AccessDenied,
    #[error("control revision conflict")]
    ControlRevisionConflict {
        current: crate::ids::ControlRevision,
    },
    #[error("resource not found")]
    ResourceNotFound,
    #[error("revision conflict")]
    RevisionConflict {
        current: RevisionId,
        lineage: Option<LineageEpoch>,
    },
    #[error("path conflict")]
    PathConflict { target: crate::model::PathTarget },
    #[error("unsafe plaintext outside the age fence")]
    UnsafePlaintextOutsideAgeFence,
    #[error("ability mutation forbidden")]
    AbilityWriteForbidden,
    #[error("cross-space read tainted this branch")]
    CrossSpaceTainted,
    #[error("role modification requires consent")]
    RoleModifiedReconsent {
        approved: RevisionId,
        current: RevisionId,
    },
    #[error("idempotency key reused")]
    IdempotencyKeyReused,
    #[error("rate limited")]
    RateLimited {
        retry_after_ms: u64,
        budget: BudgetKind,
    },
    #[error("migration in progress")]
    MigrationInProgress,
    #[error("validation failed")]
    ValidationFailed { diagnostic: Diagnostic },
    #[error("space is read-only")]
    SpaceReadOnly,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetKind {
    Requests,
    Tokens,
    Storage,
    Concurrency,
}
impl DomainError {
    pub const fn validation(reason: ValidationReason) -> Self {
        Self::ValidationFailed {
            diagnostic: Diagnostic {
                reason,
                location: None,
            },
        }
    }
    pub const fn at(reason: ValidationReason, location: SourceLocation) -> Self {
        Self::ValidationFailed {
            diagnostic: Diagnostic {
                reason,
                location: Some(location),
            },
        }
    }
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Provider { .. } => "provider_error",
            Self::ProviderCallAlreadyStarted { .. } => "provider_call_already_started",
            Self::OAuth { .. } => "oauth_error",
            Self::AuthenticationFailed => "authentication_failed",
            Self::AccessDenied => "access_denied",
            Self::ControlRevisionConflict { .. } => "control_revision_conflict",
            Self::ResourceNotFound => "resource_not_found",
            Self::RevisionConflict { .. } => "revision_conflict",
            Self::PathConflict { .. } => "path_conflict",
            Self::UnsafePlaintextOutsideAgeFence => "unsafe_plaintext_outside_age_fence",
            Self::AbilityWriteForbidden => "ability_write_forbidden",
            Self::CrossSpaceTainted => "cross_space_tainted",
            Self::RoleModifiedReconsent { .. } => "role_modified_reconsent",
            Self::IdempotencyKeyReused => "idempotency_key_reused",
            Self::RateLimited { .. } => "rate_limited",
            Self::MigrationInProgress => "migration_in_progress",
            Self::ValidationFailed { .. } => "validation_failed",
            Self::SpaceReadOnly => "space_read_only",
        }
    }
    pub const fn requires_resync(&self) -> bool {
        matches!(
            self,
            Self::ValidationFailed {
                diagnostic: Diagnostic {
                    reason: ValidationReason::HistoryIncarnationMismatch
                        | ValidationReason::CursorStale
                        | ValidationReason::PurgeResync,
                    ..
                }
            }
        )
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitEffect {
    NotCommitted,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryAdvice {
    Never,
    RetrySameCommand,
    After(Duration),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationalFailure {
    diagnostic_ref: ContentDigest,
    effect: CommitEffect,
    retry: RetryAdvice,
}
impl OperationalFailure {
    /// Only an owning adapter can assert a durable idempotency guarantee.
    pub fn new(
        diagnostic_ref: ContentDigest,
        effect: CommitEffect,
        retry: RetryAdvice,
        idempotent: bool,
    ) -> DomainResult<Self> {
        if !idempotent && retry != RetryAdvice::Never {
            return Err(DomainError::validation(ValidationReason::InvalidState));
        }
        Ok(Self {
            diagnostic_ref,
            effect,
            retry,
        })
    }
    pub const fn diagnostic_ref(self) -> ContentDigest {
        self.diagnostic_ref
    }
    pub const fn effect(self) -> CommitEffect {
        self.effect
    }
    pub const fn retry(self) -> RetryAdvice {
        self.retry
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum PortError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error("cancelled")]
    Cancelled(OperationalFailure),
    #[error("deadline exceeded")]
    DeadlineExceeded(OperationalFailure),
    #[error("dependency unavailable")]
    Unavailable(OperationalFailure),
    #[error("internal failure")]
    Internal(OperationalFailure),
}
impl PortError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Domain(e) => e.code(),
            Self::Cancelled(_) => "cancelled",
            Self::DeadlineExceeded(_) => "deadline_exceeded",
            Self::Unavailable(_) => "unavailable",
            Self::Internal(_) => "internal",
        }
    }
}
