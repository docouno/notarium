//! Versioned target rows used by offline migration and backup. No source-version parsing.
use crate::{
    error::{database, invalid},
    store::Transaction,
};
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::*,
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

pub const TARGET_SCHEMA_VERSION: u32 = 1;

fn default_model_kind() -> String {
    "completion".into()
}

fn text_bytes(value: &str) -> Result<usize, PortError> {
    if value.len() > 1048576 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    if value.contains('\0') {
        return Err(invalid(ValidationReason::DisallowedCodePoint));
    }
    Ok(value.len())
}

fn blob_bytes(value: &[u8]) -> Result<usize, PortError> {
    if value.len() > 1048576 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(value.len())
}

pub(crate) fn validate_index(bytes: usize) -> Result<(), PortError> {
    if bytes > 2048 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(())
}

fn hex12(value: &str) -> Result<usize, PortError> {
    let bytes = text_bytes(value)?;
    if value.len() != 12
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid(ValidationReason::InvalidId));
    }
    Ok(bytes)
}

fn key_hash(value: &str) -> Result<usize, PortError> {
    let bytes = text_bytes(value)?;
    if !value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(bytes)
}

trait ParseBrand {
    fn check(value: &str) -> Result<(), PortError>;
}

macro_rules! impl_parse_brand {
    ($($ty:ty),* $(,)?) => {
        $(impl ParseBrand for $ty {
            fn check(value: &str) -> Result<(), PortError> {
                <$ty>::parse(value).map(|_| ()).map_err(Into::into)
            }
        })*
    };
}

impl_parse_brand!(
    InstallationId,
    PrincipalId,
    SpaceId,
    AuthSessionId,
    OAuthGrantId,
    OAuthFamilyId,
    KeyId,
    CredentialId,
    ProviderResourceId,
    ModelProfileId,
    FolderId,
    AgentRunId,
    AbilityId,
    NoteId,
    ScheduleId,
    EpisodeId,
);

macro_rules! check_col {
    (num, $val:expr) => {{
        let _ = $val;
        Ok::<usize, PortError>(0)
    }};
    (text, $val:expr) => {
        text_bytes($val)
    };
    (opt_text, $val:expr) => {
        $val.as_deref().map_or(Ok(0), text_bytes)
    };
    (blob, $val:expr) => {
        blob_bytes($val)
    };
    (opt_blob, $val:expr) => {
        $val.as_deref().map_or(Ok(0), blob_bytes)
    };
    (hex12, $val:expr) => {
        hex12($val)
    };
    (key_hash, $val:expr) => {
        key_hash($val)
    };
    (opt_f64, $val:expr) => {{
        if $val.is_some_and(|n| !n.is_finite()) {
            Err(invalid(ValidationReason::InvalidNumber))
        } else {
            Ok(0)
        }
    }};
    (id($brand:ty), $val:expr) => {{
        let b = text_bytes($val)?;
        <$brand as ParseBrand>::check($val)?;
        Ok::<usize, PortError>(b)
    }};
    (opt_id($brand:ty), $val:expr) => {{
        if let Some(inner) = $val.as_deref() {
            let b = text_bytes(inner)?;
            <$brand as ParseBrand>::check(inner)?;
            Ok::<usize, PortError>(b)
        } else {
            Ok(0)
        }
    }};
}

/// The typed payload of `AbilityPlacementTrailRow::manifest_ref`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AbilityTrailPayload {
    pub(crate) source: notarium_core::ports::control::AbilityRef,
    pub(crate) destination: notarium_core::ports::control::AbilityRef,
}

pub struct TargetPage {
    pub records: Vec<TargetRecord>,
    pub continuation: Option<TargetPosition>,
}

macro_rules! target_tables {
    ($(
        $variant:ident ($row_ty:ident, $table_str:literal) {
            cols($cols_sql:literal, $placeholders:literal): [
                $( $(#[$col_meta:meta])* $col:ident : $col_ty:ty => $kind:tt $(($brand:ty))? ),+ $(,)?
            ]
            pk(
                sqlite_order: $sq_order:literal,
                pg_order: $pg_order:literal,
                sqlite_gt: $sq_gt:literal,
                pg_gt: $pg_gt:literal,
                limit_param: $limit_param:literal
            ): [
                $( $(#[$pk_meta:meta])* $pk_col:ident : $pk_ty:ty ),+ $(,)?
            ]
            indexes(|$idx_row:ident| $idx_body:block)
        }
    ),+ $(,)?) => {
        $(
            #[derive(Clone, Serialize, FromRow)]
            pub(crate) struct $row_ty {
                $(pub(crate) $col: $col_ty,)+
            }

            impl From<$row_ty> for TargetRecord {
                fn from(row: $row_ty) -> Self {
                    Self::$variant {
                        $($col: row.$col,)+
                    }
                }
            }
        )+

        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum TargetTable {
            $($variant,)+
        }

        impl TargetTable {
            pub const ALL: &'static [Self] = &[
                $(Self::$variant,)+
            ];

            pub fn name(self) -> &'static str {
                match self {
                    $(Self::$variant => $table_str,)+
                }
            }
        }

        #[derive(Clone, Serialize, Deserialize)]
        #[serde(
            tag = "table",
            content = "row",
            rename_all = "snake_case",
            deny_unknown_fields
        )]
        pub enum TargetRecord {
            $(
                $variant {
                    $( $(#[$col_meta])* $col: $col_ty, )+
                },
            )+
        }

        impl std::fmt::Debug for TargetRecord {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.debug_struct("TargetRecord")
                    .field("table", &self.table())
                    .finish_non_exhaustive()
            }
        }

        #[derive(Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
        #[serde(tag = "table", content = "key", rename_all = "snake_case")]
        pub enum TargetPosition {
            $(
                $variant {
                    $( $(#[$pk_meta])* $pk_col: $pk_ty, )+
                },
            )+
        }

        impl TargetRecord {
            pub fn table(&self) -> TargetTable {
                match self {
                    $(Self::$variant { .. } => TargetTable::$variant,)+
                }
            }

            /// One named logical column for offline relational validation.
            pub fn relational_value(&self, name: &str) -> Result<serde_json::Value, PortError> {
                match self {
                    $(Self::$variant { $($col,)+ } => match name {
                        $(stringify!($col) => serde_json::to_value($col)
                            .map_err(|_| invalid(ValidationReason::InvalidState)),)+
                        _ => Err(invalid(ValidationReason::InvalidState)),
                    },)+
                }
            }

            /// Canonical byte-ordered primary key used by the backup stream.
            pub(crate) fn position(&self) -> TargetPosition {
                match self {
                    $(
                        Self::$variant { $($pk_col,)+ .. } => TargetPosition::$variant {
                            $($pk_col: $pk_col.clone(),)+
                        },
                    )+
                }
            }

            pub(crate) fn validate(&self) -> Result<usize, PortError> {
                super::state_validation::validate(self)?;
                let mut bytes = 0usize;
                match self {
                    $(
                        Self::$variant { $($col,)+ } => {
                            $(
                                bytes = bytes.saturating_add(check_col!($kind $(($brand))?, $col)?);
                            )+
                            let $idx_row = $row_ty {
                                $($col: $col.clone(),)+
                            };
                            let () = $idx_body;
                        }
                    )+
                }
                Ok(bytes)
            }

            fn insert_raw<'a>(
                &'a self,
                tx: &'a mut Transaction,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>,
            > {
                match self {
                    $(
                        Self::$variant { $($col,)+ } => Box::pin(async move {
                            match tx {
                                Transaction::Sqlite(tx) => {
                                    sqlx::query(concat!(
                                        "INSERT INTO ",
                                        $table_str,
                                        "(",
                                        $cols_sql,
                                        ") VALUES(",
                                        $placeholders,
                                        ")"
                                    ))
                                    $(.bind($col))+
                                    .execute(&mut **tx)
                                    .await?;
                                }
                                Transaction::Postgres(tx) => {
                                    sqlx::query(concat!(
                                        "INSERT INTO v1_control.",
                                        $table_str,
                                        "(",
                                        $cols_sql,
                                        ") VALUES(",
                                        $placeholders,
                                        ")"
                                    ))
                                    $(.bind($col))+
                                    .execute(&mut **tx)
                                    .await?;
                                }
                            }
                            Ok(())
                        }),
                    )+
                }
            }

            pub(crate) async fn insert(&self, tx: &mut Transaction) -> Result<(), PortError> {
                self.insert_raw(tx).await.map_err(database)
            }

            pub(crate) async fn insert_or_conflict(
                &self,
                tx: &mut Transaction,
            ) -> Result<(), PortError> {
                self.insert_raw(tx)
                    .await
                    .map_err(crate::error::database_or_conflict)
            }
        }

        pub(crate) fn read_page<'a>(
            tx: &'a mut Transaction,
            table: TargetTable,
            after: Option<TargetPosition>,
            limit: u16,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<TargetPage, PortError>> + Send + 'a>,
        > {
            if !(1..=200).contains(&limit) {
                return Box::pin(async { Err(invalid(ValidationReason::InvalidLimit)) });
            }
            match table {
                $(
                    TargetTable::$variant => Box::pin(async move {
                        let chunk: super::RowChunk<$row_ty> = match after {
                            None => match tx {
                                Transaction::Sqlite(tx) => super::collect_rows(
                                    sqlx::query_as(concat!(
                                        "SELECT ",
                                        $cols_sql,
                                        " FROM ",
                                        $table_str,
                                        " ORDER BY ",
                                        $sq_order,
                                        " LIMIT $1"
                                    ))
                                    .bind(i64::from(limit) + 1)
                                    .fetch(&mut **tx),
                                    limit,
                                    table,
                                )
                                .await?,
                                Transaction::Postgres(tx) => super::collect_rows(
                                    sqlx::query_as(concat!(
                                        "SELECT ",
                                        $cols_sql,
                                        " FROM v1_control.",
                                        $table_str,
                                        " ORDER BY ",
                                        $pg_order,
                                        " LIMIT $1"
                                    ))
                                    .bind(i64::from(limit) + 1)
                                    .fetch(&mut **tx),
                                    limit,
                                    table,
                                )
                                .await?,
                            },
                            Some(TargetPosition::$variant { $($pk_col,)+ }) => match tx {
                                Transaction::Sqlite(tx) => super::collect_rows(
                                    sqlx::query_as(concat!(
                                        "SELECT ",
                                        $cols_sql,
                                        " FROM ",
                                        $table_str,
                                        " WHERE ",
                                        $sq_gt,
                                        " ORDER BY ",
                                        $sq_order,
                                        " LIMIT ",
                                        $limit_param
                                    ))
                                    $(.bind($pk_col))+
                                    .bind(i64::from(limit) + 1)
                                    .fetch(&mut **tx),
                                    limit,
                                    table,
                                )
                                .await?,
                                Transaction::Postgres(tx) => super::collect_rows(
                                    sqlx::query_as(concat!(
                                        "SELECT ",
                                        $cols_sql,
                                        " FROM v1_control.",
                                        $table_str,
                                        " WHERE ",
                                        $pg_gt,
                                        " ORDER BY ",
                                        $pg_order,
                                        " LIMIT ",
                                        $limit_param
                                    ))
                                    $(.bind($pk_col))+
                                    .bind(i64::from(limit) + 1)
                                    .fetch(&mut **tx),
                                    limit,
                                    table,
                                )
                                .await?,
                            },
                            _ => return Err(invalid(ValidationReason::ScopeMismatch)),
                        };
                        let super::RowChunk { rows, has_more } = chunk;
                        let records: Vec<TargetRecord> =
                            rows.into_iter().map(TargetRecord::from).collect();
                        let continuation = if has_more {
                            records.last().map(TargetRecord::position)
                        } else {
                            None
                        };
                        Ok(TargetPage {
                            records,
                            continuation,
                        })
                    }),
                )+
            }
        }
    };
}

target_tables! {
    V1StorageEpoch (V1StorageEpochRow, "v1_storage_epoch") {
        cols("singleton,epoch_version,state,installation_id,receipt_sha256,receipt_json", "$1,$2,$3,$4,$5,$6"): [
            singleton: i64 => num,
            epoch_version: i64 => num,
            state: String => text,
            installation_id: String => id(InstallationId),
            receipt_sha256: Option<Vec<u8>> => opt_blob,
            receipt_json: Option<String> => opt_text,
        ]
        pk(sqlite_order: "singleton", pg_order: "singleton", sqlite_gt: "singleton > $1", pg_gt: "singleton > $1", limit_param: "$2"): [
            singleton: i64,
        ]
        indexes(|_r| { validate_index(8)?; })
    },
    Users (UsersRow, "users") {
        cols("user_id,username,email,display_name,password_hash,is_admin,disabled_at,personal_space_id,revision,metadata_revision,auth_version,created_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12"): [
            user_id: String => id(PrincipalId),
            username: String => text,
            email: Option<String> => opt_text,
            display_name: String => text,
            password_hash: Option<String> => opt_text,
            is_admin: i64 => num,
            disabled_at: Option<i64> => num,
            personal_space_id: Option<String> => opt_text,
            revision: i64 => num,
            metadata_revision: i64 => num,
            auth_version: i64 => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "user_id", pg_order: "user_id COLLATE \"C\"", sqlite_gt: "user_id > $1", pg_gt: "user_id COLLATE \"C\" > $1", limit_param: "$2"): [
            user_id: String,
        ]
        indexes(|r| {
            validate_index(r.user_id.len())?;
            validate_index(r.username.len())?;
            validate_index(r.email.as_ref().map_or(0, String::len))?;
            validate_index(r.personal_space_id.as_ref().map_or(0, String::len))?;
        })
    },
    UserOidcIdentities (UserOidcIdentitiesRow, "user_oidc_identities") {
        cols("issuer,subject,user_id,created_at", "$1,$2,$3,$4"): [
            issuer: String => text,
            subject: String => text,
            user_id: String => id(PrincipalId),
            created_at: i64 => num,
        ]
        pk(sqlite_order: "issuer,subject", pg_order: "issuer COLLATE \"C\",subject COLLATE \"C\"", sqlite_gt: "(issuer,subject) > ($1,$2)", pg_gt: "(issuer COLLATE \"C\",subject COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            issuer: String,
            subject: String,
        ]
        indexes(|r| {
            validate_index(r.issuer.len() + r.subject.len())?;
            validate_index(r.user_id.len())?;
        })
    },
    SpaceAdmission (SpaceAdmissionRow, "space_admission") {
        cols("space_id,state,admission_epoch,revision", "$1,$2,$3,$4"): [
            space_id: String => id(SpaceId),
            state: String => text,
            admission_epoch: i64 => num,
            revision: i64 => num,
        ]
        pk(sqlite_order: "space_id", pg_order: "space_id COLLATE \"C\"", sqlite_gt: "space_id > $1", pg_gt: "space_id COLLATE \"C\" > $1", limit_param: "$2"): [
            space_id: String,
        ]
        indexes(|r| { validate_index(r.space_id.len())?; })
    },
    SpaceMembers (SpaceMembersRow, "space_members") {
        cols("space_id,user_id,role,admission,revision,created_at", "$1,$2,$3,$4,$5,$6"): [
            space_id: String => id(SpaceId),
            user_id: String => id(PrincipalId),
            role: String => text,
            admission: String => text,
            revision: i64 => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "space_id,user_id", pg_order: "space_id COLLATE \"C\",user_id COLLATE \"C\"", sqlite_gt: "(space_id,user_id) > ($1,$2)", pg_gt: "(space_id COLLATE \"C\",user_id COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            space_id: String,
            user_id: String,
        ]
        indexes(|r| { validate_index(r.space_id.len() + r.user_id.len())?; })
    },
    Sessions (SessionsRow, "sessions") {
        cols("session_id,token_hash,user_id,created_at,expires_at,last_used_at,revoked_at,auth_version", "$1,$2,$3,$4,$5,$6,$7,$8"): [
            session_id: String => id(AuthSessionId),
            token_hash: Vec<u8> => blob,
            user_id: String => id(PrincipalId),
            created_at: i64 => num,
            expires_at: i64 => num,
            last_used_at: i64 => num,
            revoked_at: Option<i64> => num,
            auth_version: i64 => num,
        ]
        pk(sqlite_order: "session_id", pg_order: "session_id COLLATE \"C\"", sqlite_gt: "session_id > $1", pg_gt: "session_id COLLATE \"C\" > $1", limit_param: "$2"): [
            session_id: String,
        ]
        indexes(|r| {
            validate_index(r.session_id.len() + 8)?;
            validate_index(r.token_hash.len())?;
            validate_index(r.user_id.len() + 8)?;
        })
    },
    OneTimeTokens (OneTimeTokensRow, "one_time_tokens") {
        cols("token_hash,user_id,purpose,expires_at,used_at,created_at", "$1,$2,$3,$4,$5,$6"): [
            token_hash: Vec<u8> => blob,
            user_id: String => id(PrincipalId),
            purpose: String => text,
            expires_at: i64 => num,
            used_at: Option<i64> => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "token_hash", pg_order: "token_hash", sqlite_gt: "token_hash > $1", pg_gt: "token_hash > $1", limit_param: "$2"): [
            token_hash: Vec<u8>,
        ]
        indexes(|r| {
            validate_index(r.token_hash.len())?;
            validate_index(r.user_id.len() + r.purpose.len() + 8)?;
        })
    },
    Pats (PatsRow, "pats") {
        cols("token_id,secret_hash,user_id,name,scope,selected_spaces,expires_at,last_used_at,revoked_at,created_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10"): [
            token_id: String => hex12,
            secret_hash: Vec<u8> => blob,
            user_id: String => id(PrincipalId),
            name: String => text,
            scope: String => text,
            selected_spaces: Option<String> => opt_text,
            expires_at: Option<i64> => num,
            last_used_at: Option<i64> => num,
            revoked_at: Option<i64> => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "token_id", pg_order: "token_id COLLATE \"C\"", sqlite_gt: "token_id > $1", pg_gt: "token_id COLLATE \"C\" > $1", limit_param: "$2"): [
            token_id: String,
        ]
        indexes(|r| {
            validate_index(r.token_id.len())?;
            validate_index(r.user_id.len() + r.token_id.len())?;
        })
    },
    OauthClients (OauthClientsRow, "oauth_clients") {
        cols("client_id,kind,redirect_uris,client_name,metadata_uri,metadata_digest,cache_expires_at,activated_at,created_at,last_seen_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10"): [
            client_id: String => text,
            kind: String => text,
            redirect_uris: String => text,
            client_name: String => text,
            metadata_uri: Option<String> => opt_text,
            metadata_digest: Option<Vec<u8>> => opt_blob,
            cache_expires_at: Option<i64> => num,
            activated_at: Option<i64> => num,
            created_at: i64 => num,
            last_seen_at: Option<i64> => num,
        ]
        pk(sqlite_order: "client_id", pg_order: "client_id COLLATE \"C\"", sqlite_gt: "client_id > $1", pg_gt: "client_id COLLATE \"C\" > $1", limit_param: "$2"): [
            client_id: String,
        ]
        indexes(|r| {
            validate_index(r.client_id.len())?;
            validate_index(r.kind.len() + 16)?;
        })
    },
    OauthGrants (OauthGrantsRow, "oauth_grants") {
        cols("grant_id,user_id,client_id,resource_uri,scope,selected_spaces,revoked_at,revision,created_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9"): [
            grant_id: String => id(OAuthGrantId),
            user_id: String => id(PrincipalId),
            client_id: String => text,
            resource_uri: String => text,
            scope: String => text,
            selected_spaces: Option<String> => opt_text,
            revoked_at: Option<i64> => num,
            revision: i64 => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "grant_id", pg_order: "grant_id COLLATE \"C\"", sqlite_gt: "grant_id > $1", pg_gt: "grant_id COLLATE \"C\" > $1", limit_param: "$2"): [
            grant_id: String,
        ]
        indexes(|r| {
            validate_index(r.grant_id.len())?;
            validate_index(r.user_id.len() + r.client_id.len())?;
            validate_index(r.client_id.len())?;
        })
    },
    OauthAuthCodes (OauthAuthCodesRow, "oauth_auth_codes") {
        cols("code_hash,grant_id,client_id,redirect_uri,resource_uri,code_challenge,method,offline_access,expires_at,used_at,created_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11"): [
            code_hash: Vec<u8> => blob,
            grant_id: String => id(OAuthGrantId),
            client_id: String => text,
            redirect_uri: String => text,
            resource_uri: String => text,
            code_challenge: String => text,
            method: String => text,
            offline_access: i64 => num,
            expires_at: i64 => num,
            used_at: Option<i64> => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "code_hash", pg_order: "code_hash", sqlite_gt: "code_hash > $1", pg_gt: "code_hash > $1", limit_param: "$2"): [
            code_hash: Vec<u8>,
        ]
        indexes(|r| {
            validate_index(r.code_hash.len())?;
            validate_index(r.client_id.len())?;
        })
    },
    OauthRefreshFamilies (OauthRefreshFamiliesRow, "oauth_refresh_families") {
        cols("family_id,grant_id,revoked_at,reason_code,created_at", "$1,$2,$3,$4,$5"): [
            family_id: String => id(OAuthFamilyId),
            grant_id: String => id(OAuthGrantId),
            revoked_at: Option<i64> => num,
            reason_code: Option<String> => opt_text,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "family_id", pg_order: "family_id COLLATE \"C\"", sqlite_gt: "family_id > $1", pg_gt: "family_id COLLATE \"C\" > $1", limit_param: "$2"): [
            family_id: String,
        ]
        indexes(|r| {
            validate_index(r.family_id.len() + 8)?;
            validate_index(r.grant_id.len())?;
        })
    },
    OauthRefreshTokens (OauthRefreshTokensRow, "oauth_refresh_tokens") {
        cols("token_id,token_hash,family_id,client_id,issued_at,expires_at,used_at,revoked_at,rotated_to", "$1,$2,$3,$4,$5,$6,$7,$8,$9"): [
            token_id: String => hex12,
            token_hash: Vec<u8> => blob,
            family_id: String => id(OAuthFamilyId),
            client_id: String => text,
            issued_at: i64 => num,
            expires_at: i64 => num,
            used_at: Option<i64> => num,
            revoked_at: Option<i64> => num,
            rotated_to: Option<String> => opt_text,
        ]
        pk(sqlite_order: "token_id", pg_order: "token_id COLLATE \"C\"", sqlite_gt: "token_id > $1", pg_gt: "token_id COLLATE \"C\" > $1", limit_param: "$2"): [
            token_id: String,
        ]
        indexes(|r| {
            validate_index(r.token_id.len())?;
            validate_index(r.family_id.len())?;
            validate_index(r.client_id.len())?;
            validate_index(r.rotated_to.as_ref().map_or(0, String::len))?;
        })
    },
    OauthAccessTokens (OauthAccessTokensRow, "oauth_access_tokens") {
        cols("token_id,token_hash,grant_id,family_id,refresh_id,resource_uri,scope,selected_spaces,issued_at,expires_at,revoked_at,last_used_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12"): [
            token_id: String => hex12,
            token_hash: Vec<u8> => blob,
            grant_id: String => id(OAuthGrantId),
            family_id: Option<String> => opt_id(OAuthFamilyId),
            refresh_id: Option<String> => opt_text,
            resource_uri: String => text,
            scope: String => text,
            selected_spaces: Option<String> => opt_text,
            issued_at: i64 => num,
            expires_at: i64 => num,
            revoked_at: Option<i64> => num,
            last_used_at: Option<i64> => num,
        ]
        pk(sqlite_order: "token_id", pg_order: "token_id COLLATE \"C\"", sqlite_gt: "token_id > $1", pg_gt: "token_id COLLATE \"C\" > $1", limit_param: "$2"): [
            token_id: String,
        ]
        indexes(|r| {
            validate_index(r.token_id.len())?;
            validate_index(r.grant_id.len())?;
            validate_index(r.family_id.as_ref().map_or(0, String::len))?;
            validate_index(r.refresh_id.as_ref().map_or(0, String::len))?;
        })
    },
    SecretKeyring (SecretKeyringRow, "secret_keyring") {
        cols("key_id,key_hash,generation,state,canary,created_at,retired_at", "$1,$2,$3,$4,$5,$6,$7"): [
            key_id: String => id(KeyId),
            key_hash: String => key_hash,
            generation: i64 => num,
            state: String => text,
            canary: String => text,
            created_at: i64 => num,
            retired_at: Option<i64> => num,
        ]
        pk(sqlite_order: "key_id", pg_order: "key_id COLLATE \"C\"", sqlite_gt: "key_id > $1", pg_gt: "key_id COLLATE \"C\" > $1", limit_param: "$2"): [
            key_id: String,
        ]
        indexes(|r| {
            validate_index(r.key_id.len())?;
            validate_index(r.state.len())?;
        })
    },
    OidcTransactions (OidcTransactionsRow, "oidc_transactions") {
        cols("transaction_id,state_hash,nonce_hash,flow_context_hash,key_id,issuer,client_id,redirect_uri,purpose,bound_user,browser_binding_hash,expires_at,consumed_at,created_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14"): [
            transaction_id: String => text,
            state_hash: Vec<u8> => blob,
            nonce_hash: Vec<u8> => blob,
            flow_context_hash: Vec<u8> => blob,
            key_id: String => id(KeyId),
            issuer: String => text,
            client_id: String => text,
            redirect_uri: String => text,
            purpose: String => text,
            bound_user: Option<String> => opt_text,
            browser_binding_hash: Vec<u8> => blob,
            expires_at: i64 => num,
            consumed_at: Option<i64> => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "transaction_id", pg_order: "transaction_id COLLATE \"C\"", sqlite_gt: "transaction_id > $1", pg_gt: "transaction_id COLLATE \"C\" > $1", limit_param: "$2"): [
            transaction_id: String,
        ]
        indexes(|r| {
            validate_index(r.transaction_id.len())?;
            validate_index(r.state_hash.len())?;
        })
    },
    Credentials (CredentialsRow, "credentials") {
        cols("id,owner_id,name,kind,secret,injection,disabled_at,rpm,tpm,consent_epoch,runtime_epoch,revision,created_at,updated_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14"): [
            id: String => text,
            owner_id: String => id(PrincipalId),
            name: String => text,
            kind: String => text,
            secret: String => text,
            injection: String => text,
            disabled_at: Option<i64> => num,
            rpm: Option<i64> => num,
            tpm: Option<i64> => num,
            consent_epoch: i64 => num,
            runtime_epoch: i64 => num,
            revision: i64 => num,
            created_at: i64 => num,
            updated_at: i64 => num,
        ]
        pk(sqlite_order: "id", pg_order: "id COLLATE \"C\"", sqlite_gt: "id > $1", pg_gt: "id COLLATE \"C\" > $1", limit_param: "$2"): [
            id: String,
        ]
        indexes(|r| {
            validate_index(r.id.len())?;
            validate_index(r.owner_id.len() + r.name.len())?;
        })
    },
    ProviderResources (ProviderResourcesRow, "provider_resources") {
        cols("id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,default_model,timeouts,rpm,tpm,disabled_at,revision", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15"): [
            id: String => text,
            owner_id: String => id(PrincipalId),
            name: String => text,
            wire: String => text,
            base_url: String => text,
            headers: String => text,
            credential_id: Option<String> => opt_id(CredentialId),
            consent_epoch: i64 => num,
            runtime_epoch: i64 => num,
            default_model: Option<String> => opt_text,
            timeouts: String => text,
            rpm: Option<i64> => num,
            tpm: Option<i64> => num,
            disabled_at: Option<i64> => num,
            revision: i64 => num,
        ]
        pk(sqlite_order: "id", pg_order: "id COLLATE \"C\"", sqlite_gt: "id > $1", pg_gt: "id COLLATE \"C\" > $1", limit_param: "$2"): [
            id: String,
        ]
        indexes(|r| {
            validate_index(r.id.len())?;
            validate_index(r.owner_id.len() + r.name.len())?;
            validate_index(r.credential_id.as_ref().map_or(0, String::len))?;
        })
    },
    ProviderModels (ProviderModelsRow, "provider_models") {
        cols("resource_id,model_id,wire_model_name,kind,tokenizer_profile,max_input,max_output,dimension,capabilities,revision", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10"): [
            resource_id: String => id(ProviderResourceId),
            model_id: String => id(ModelProfileId),
            wire_model_name: String => text,
            kind: String => text,
            tokenizer_profile: String => text,
            max_input: i64 => num,
            max_output: i64 => num,
            dimension: Option<i64> => num,
            capabilities: String => text,
            revision: i64 => num,
        ]
        pk(sqlite_order: "resource_id,model_id", pg_order: "resource_id COLLATE \"C\",model_id COLLATE \"C\"", sqlite_gt: "(resource_id,model_id) > ($1,$2)", pg_gt: "(resource_id COLLATE \"C\",model_id COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            resource_id: String,
            model_id: String,
        ]
        indexes(|r| { validate_index(r.resource_id.len() + r.model_id.len())?; })
    },
    ProviderAttachments (ProviderAttachmentsRow, "provider_attachments") {
        cols("id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12"): [
            id: String => text,
            resource_id: String => id(ProviderResourceId),
            target_kind: String => text,
            target_owner: Option<String> => opt_id(PrincipalId),
            target_space: String => id(SpaceId),
            target_project: Option<String> => opt_id(FolderId),
            resource_epoch: i64 => num,
            credential_epoch: Option<i64> => num,
            state: String => text,
            disclosure: String => text,
            expires_at: Option<i64> => num,
            revision: i64 => num,
        ]
        pk(sqlite_order: "id", pg_order: "id COLLATE \"C\"", sqlite_gt: "id > $1", pg_gt: "id COLLATE \"C\" > $1", limit_param: "$2"): [
            id: String,
        ]
        indexes(|r| {
            validate_index(r.id.len())?;
            validate_index(r.resource_id.len() + r.id.len())?;
            validate_index(r.resource_id.len() + r.target_owner.as_ref().map_or(0, String::len) + r.target_space.len())?;
            validate_index(r.resource_id.len() + r.target_space.len())?;
            validate_index(r.resource_id.len() + r.target_space.len() + r.target_project.as_ref().map_or(0, String::len))?;
            validate_index(r.target_space.len() + r.state.len() + r.resource_id.len())?;
        })
    },
    ProviderPreferences (ProviderPreferencesRow, "provider_preferences") {
        cols("owner_id,scope_kind,scope_id,model_kind,resource_id,model_id,revision", "$1,$2,$3,$4,$5,$6,$7"): [
            owner_id: String => id(PrincipalId),
            scope_kind: String => text,
            scope_id: String => text,
            #[serde(default = "default_model_kind")]
            model_kind: String => text,
            resource_id: String => id(ProviderResourceId),
            model_id: String => id(ModelProfileId),
            revision: i64 => num,
        ]
        pk(
            sqlite_order: "owner_id,scope_kind,scope_id,model_kind",
            pg_order: "owner_id COLLATE \"C\",scope_kind COLLATE \"C\",scope_id COLLATE \"C\",model_kind COLLATE \"C\"",
            sqlite_gt: "(owner_id,scope_kind,scope_id,model_kind) > ($1,$2,$3,$4)",
            pg_gt: "(owner_id COLLATE \"C\",scope_kind COLLATE \"C\",scope_id COLLATE \"C\",model_kind COLLATE \"C\") > ($1,$2,$3,$4)",
            limit_param: "$5"
        ): [
            owner_id: String,
            scope_kind: String,
            scope_id: String,
            #[serde(default = "default_model_kind")]
            model_kind: String,
        ]
        indexes(|r| {
            validate_index(r.owner_id.len() + r.scope_kind.len() + r.scope_id.len() + r.model_kind.len())?;
            validate_index(r.resource_id.len() + r.model_id.len())?;
        })
    },
    ProviderBudgetBuckets (ProviderBudgetBucketsRow, "provider_budget_buckets") {
        cols("budget_kind,budget_owner,window_start_ms,window_end_ms,rpm_used,tpm_reserved,tpm_exact", "$1,$2,$3,$4,$5,$6,$7"): [
            budget_kind: String => text,
            budget_owner: String => text,
            window_start_ms: i64 => num,
            window_end_ms: i64 => num,
            rpm_used: i64 => num,
            tpm_reserved: i64 => num,
            tpm_exact: i64 => num,
        ]
        pk(sqlite_order: "budget_kind,budget_owner,window_start_ms", pg_order: "budget_kind COLLATE \"C\",budget_owner COLLATE \"C\",window_start_ms", sqlite_gt: "(budget_kind,budget_owner,window_start_ms) > ($1,$2,$3)", pg_gt: "(budget_kind COLLATE \"C\",budget_owner COLLATE \"C\",window_start_ms) > ($1,$2,$3)", limit_param: "$4"): [
            budget_kind: String,
            budget_owner: String,
            window_start_ms: i64,
        ]
        indexes(|r| { validate_index(r.budget_kind.len() + r.budget_owner.len() + 8)?; })
    },
    ProviderCallLog (ProviderCallLogRow, "provider_call_log") {
        cols("call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23"): [
            call_id: String => text,
            owner_id: String => id(PrincipalId),
            principal: String => text,
            run_id: Option<String> => opt_id(AgentRunId),
            scope_id: String => text,
            intent_key: String => text,
            request_hash: Vec<u8> => blob,
            resource_id: String => id(ProviderResourceId),
            credential_id: Option<String> => opt_id(CredentialId),
            policy_epochs: String => text,
            participating_spaces: String => text,
            model_id: Option<String> => opt_id(ModelProfileId),
            reserved_tokens: i64 => num,
            bucket_keys: String => text,
            delivery_state: String => text,
            outcome: Option<String> => opt_text,
            usage_source: String => text,
            input_tokens: Option<i64> => num,
            output_tokens: Option<i64> => num,
            diagnostic: Option<String> => opt_text,
            dispatch_owner: Option<String> => opt_text,
            created_at: i64 => num,
            settled_at: Option<i64> => num,
        ]
        pk(sqlite_order: "call_id", pg_order: "call_id COLLATE \"C\"", sqlite_gt: "call_id > $1", pg_gt: "call_id COLLATE \"C\" > $1", limit_param: "$2"): [
            call_id: String,
        ]
        indexes(|r| {
            validate_index(r.call_id.len())?;
            validate_index(r.principal.len() + r.scope_id.len() + r.intent_key.len())?;
            validate_index(r.owner_id.len() + 8 + r.call_id.len())?;
            validate_index(r.delivery_state.len() + 8 + r.call_id.len())?;
        })
    },
    AbilityAvailability (AbilityAvailabilityRow, "ability_availability") {
        cols("placement,ability_id,mode,enabled,revision", "$1,$2,$3,$4,$5"): [
            placement: String => text,
            ability_id: String => id(AbilityId),
            mode: String => text,
            enabled: i64 => num,
            revision: i64 => num,
        ]
        pk(sqlite_order: "placement,ability_id", pg_order: "placement COLLATE \"C\",ability_id COLLATE \"C\"", sqlite_gt: "(placement,ability_id) > ($1,$2)", pg_gt: "(placement COLLATE \"C\",ability_id COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            placement: String,
            ability_id: String,
        ]
        indexes(|r| { validate_index(r.placement.len() + r.ability_id.len())?; })
    },
    AbilityProjectBindings (AbilityProjectBindingsRow, "ability_project_bindings") {
        cols("placement,ability_id,target_space,project_id", "$1,$2,$3,$4"): [
            placement: String => text,
            ability_id: String => id(AbilityId),
            target_space: String => id(SpaceId),
            project_id: String => id(FolderId),
        ]
        pk(
            sqlite_order: "placement,ability_id,target_space,project_id",
            pg_order: "placement COLLATE \"C\",ability_id COLLATE \"C\",target_space COLLATE \"C\",project_id COLLATE \"C\"",
            sqlite_gt: "(placement,ability_id,target_space,project_id) > ($1,$2,$3,$4)",
            pg_gt: "(placement COLLATE \"C\",ability_id COLLATE \"C\",target_space COLLATE \"C\",project_id COLLATE \"C\") > ($1,$2,$3,$4)",
            limit_param: "$5"
        ): [
            placement: String,
            ability_id: String,
            target_space: String,
            project_id: String,
        ]
        indexes(|r| {
            validate_index(r.placement.len() + r.ability_id.len() + r.target_space.len() + r.project_id.len())?;
            validate_index(r.target_space.len() + r.project_id.len())?;
        })
    },
    AbilityPreferences (AbilityPreferencesRow, "ability_preferences") {
        cols("owner_id,ability_id,placement,enabled,revision", "$1,$2,$3,$4,$5"): [
            owner_id: String => id(PrincipalId),
            ability_id: String => id(AbilityId),
            placement: String => text,
            enabled: i64 => num,
            revision: i64 => num,
        ]
        pk(sqlite_order: "owner_id,ability_id,placement", pg_order: "owner_id COLLATE \"C\",ability_id COLLATE \"C\",placement COLLATE \"C\"", sqlite_gt: "(owner_id,ability_id,placement) > ($1,$2,$3)", pg_gt: "(owner_id COLLATE \"C\",ability_id COLLATE \"C\",placement COLLATE \"C\") > ($1,$2,$3)", limit_param: "$4"): [
            owner_id: String,
            ability_id: String,
            placement: String,
        ]
        indexes(|r| { validate_index(r.owner_id.len() + r.ability_id.len() + r.placement.len())?; })
    },
    AbilityPlacementTrail (AbilityPlacementTrailRow, "ability_placement_trail") {
        cols("source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at", "$1,$2,$3,$4,$5,$6"): [
            source_placement: String => text,
            ability_id: String => id(AbilityId),
            destination_placement: String => text,
            destination_id: String => text,
            manifest_ref: String => text,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "source_placement,ability_id", pg_order: "source_placement COLLATE \"C\",ability_id COLLATE \"C\"", sqlite_gt: "(source_placement,ability_id) > ($1,$2)", pg_gt: "(source_placement COLLATE \"C\",ability_id COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            source_placement: String,
            ability_id: String,
        ]
        indexes(|r| { validate_index(r.source_placement.len() + r.ability_id.len())?; })
    },
    Favorites (FavoritesRow, "favorites") {
        cols("owner_id,space_id,entity_kind,entity_id,rank,created_at", "$1,$2,$3,$4,$5,$6"): [
            owner_id: String => id(PrincipalId),
            space_id: String => id(SpaceId),
            entity_kind: String => text,
            entity_id: String => text,
            rank: i64 => num,
            created_at: i64 => num,
        ]
        pk(
            sqlite_order: "owner_id,space_id,entity_kind,entity_id",
            pg_order: "owner_id COLLATE \"C\",space_id COLLATE \"C\",entity_kind COLLATE \"C\",entity_id COLLATE \"C\"",
            sqlite_gt: "(owner_id,space_id,entity_kind,entity_id) > ($1,$2,$3,$4)",
            pg_gt: "(owner_id COLLATE \"C\",space_id COLLATE \"C\",entity_kind COLLATE \"C\",entity_id COLLATE \"C\") > ($1,$2,$3,$4)",
            limit_param: "$5"
        ): [
            owner_id: String,
            space_id: String,
            entity_kind: String,
            entity_id: String,
        ]
        indexes(|r| {
            validate_index(r.owner_id.len() + r.space_id.len() + r.entity_kind.len() + r.entity_id.len())?;
            validate_index(r.owner_id.len() + r.space_id.len() + 8 + r.entity_id.len())?;
        })
    },
    ContextSets (ContextSetsRow, "context_sets") {
        cols("set_id,owner_id,home_space,name,note_refs,revision,created_at", "$1,$2,$3,$4,$5,$6,$7"): [
            set_id: String => text,
            owner_id: String => id(PrincipalId),
            home_space: String => id(SpaceId),
            name: String => text,
            note_refs: String => text,
            revision: i64 => num,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "set_id", pg_order: "set_id COLLATE \"C\"", sqlite_gt: "set_id > $1", pg_gt: "set_id COLLATE \"C\" > $1", limit_param: "$2"): [
            set_id: String,
        ]
        indexes(|r| {
            validate_index(r.set_id.len())?;
            validate_index(r.home_space.len() + r.set_id.len())?;
        })
    },
    ContextSetAttachments (ContextSetAttachmentsRow, "context_set_attachments") {
        cols("set_id,target_kind,target_id,target_space,owner_id,revision", "$1,$2,$3,$4,$5,$6"): [
            set_id: String => text,
            target_kind: String => text,
            target_id: String => text,
            target_space: String => id(SpaceId),
            owner_id: String => id(PrincipalId),
            revision: i64 => num,
        ]
        pk(sqlite_order: "set_id,target_kind,target_id", pg_order: "set_id COLLATE \"C\",target_kind COLLATE \"C\",target_id COLLATE \"C\"", sqlite_gt: "(set_id,target_kind,target_id) > ($1,$2,$3)", pg_gt: "(set_id COLLATE \"C\",target_kind COLLATE \"C\",target_id COLLATE \"C\") > ($1,$2,$3)", limit_param: "$4"): [
            set_id: String,
            target_kind: String,
            target_id: String,
        ]
        indexes(|r| {
            validate_index(r.set_id.len() + r.target_kind.len() + r.target_id.len())?;
            validate_index(r.owner_id.len() + r.target_kind.len() + r.target_id.len() + r.set_id.len())?;
        })
    },
    ContextScopePins (ContextScopePinsRow, "context_scope_pins") {
        cols("owner_id,target_kind,target_id,target_space,note_space,note_id,revision,created_at", "$1,$2,$3,$4,$5,$6,$7,$8"): [
            owner_id: String => id(PrincipalId),
            target_kind: String => text,
            target_id: String => text,
            target_space: String => id(SpaceId),
            note_space: String => id(SpaceId),
            note_id: String => id(NoteId),
            revision: i64 => num,
            created_at: i64 => num,
        ]
        pk(
            sqlite_order: "owner_id,target_kind,target_id,note_space,note_id",
            pg_order: "owner_id COLLATE \"C\",target_kind COLLATE \"C\",target_id COLLATE \"C\",note_space COLLATE \"C\",note_id COLLATE \"C\"",
            sqlite_gt: "(owner_id,target_kind,target_id,note_space,note_id) > ($1,$2,$3,$4,$5)",
            pg_gt: "(owner_id COLLATE \"C\",target_kind COLLATE \"C\",target_id COLLATE \"C\",note_space COLLATE \"C\",note_id COLLATE \"C\") > ($1,$2,$3,$4,$5)",
            limit_param: "$6"
        ): [
            owner_id: String,
            target_kind: String,
            target_id: String,
            note_space: String,
            note_id: String,
        ]
        indexes(|r| {
            validate_index(r.owner_id.len() + r.target_kind.len() + r.target_id.len() + r.note_space.len() + r.note_id.len())?;
            validate_index(r.target_space.len() + r.note_space.len())?;
        })
    },
    ContextOrder (ContextOrderRow, "context_order") {
        cols("owner_id,target_kind,target_id,target_space,entry_kind,entry_ref,rank,revision", "$1,$2,$3,$4,$5,$6,$7,$8"): [
            owner_id: String => id(PrincipalId),
            target_kind: String => text,
            target_id: String => text,
            target_space: String => id(SpaceId),
            entry_kind: String => text,
            entry_ref: String => text,
            rank: i64 => num,
            revision: i64 => num,
        ]
        pk(
            sqlite_order: "owner_id,target_kind,target_id,entry_kind,entry_ref",
            pg_order: "owner_id COLLATE \"C\",target_kind COLLATE \"C\",target_id COLLATE \"C\",entry_kind COLLATE \"C\",entry_ref COLLATE \"C\"",
            sqlite_gt: "(owner_id,target_kind,target_id,entry_kind,entry_ref) > ($1,$2,$3,$4,$5)",
            pg_gt: "(owner_id COLLATE \"C\",target_kind COLLATE \"C\",target_id COLLATE \"C\",entry_kind COLLATE \"C\",entry_ref COLLATE \"C\") > ($1,$2,$3,$4,$5)",
            limit_param: "$6"
        ): [
            owner_id: String,
            target_kind: String,
            target_id: String,
            entry_kind: String,
            entry_ref: String,
        ]
        indexes(|r| {
            validate_index(r.owner_id.len() + r.target_kind.len() + r.target_id.len() + r.entry_kind.len() + r.entry_ref.len())?;
            validate_index(r.owner_id.len() + r.target_kind.len() + r.target_id.len() + 8 + r.entry_ref.len())?;
        })
    },
    AgentEpisodes (AgentEpisodesRow, "agent_episodes") {
        cols("episode_id,owner_id,name,parent_id,active_role,project_space,project_folder,lifecycle,revision,created_at,last_seen_at,closed_at,calls", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13"): [
            episode_id: String => id(EpisodeId),
            owner_id: String => id(PrincipalId),
            name: Option<String> => opt_text,
            parent_id: Option<String> => opt_text,
            active_role: Option<String> => opt_text,
            project_space: Option<String> => opt_id(SpaceId),
            project_folder: Option<String> => opt_id(FolderId),
            lifecycle: String => text,
            revision: i64 => num,
            created_at: i64 => num,
            last_seen_at: i64 => num,
            closed_at: Option<i64> => num,
            calls: i64 => num,
        ]
        pk(sqlite_order: "episode_id", pg_order: "episode_id COLLATE \"C\"", sqlite_gt: "episode_id > $1", pg_gt: "episode_id COLLATE \"C\" > $1", limit_param: "$2"): [
            episode_id: String,
        ]
        indexes(|r| {
            validate_index(r.episode_id.len())?;
            validate_index(r.owner_id.len() + r.name.as_ref().map_or(0, String::len) + r.lifecycle.len() + 8 + r.episode_id.len())?;
        })
    },
    McpDeltaOwnerCursors (McpDeltaOwnerCursorsRow, "mcp_delta_owner_cursors") {
        cols("owner_id,space_id,history_incarnation,acked_space_seq,updated_at", "$1,$2,$3,$4,$5"): [
            owner_id: String => id(PrincipalId),
            space_id: String => id(SpaceId),
            history_incarnation: Vec<u8> => blob,
            acked_space_seq: i64 => num,
            updated_at: i64 => num,
        ]
        pk(sqlite_order: "owner_id,space_id", pg_order: "owner_id COLLATE \"C\",space_id COLLATE \"C\"", sqlite_gt: "(owner_id,space_id) > ($1,$2)", pg_gt: "(owner_id COLLATE \"C\",space_id COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            owner_id: String,
            space_id: String,
        ]
        indexes(|r| {
            validate_index(r.owner_id.len() + r.space_id.len())?;
            validate_index(r.space_id.len())?;
        })
    },
    McpDeltaSessionCursors (McpDeltaSessionCursorsRow, "mcp_delta_session_cursors") {
        cols("episode_id,space_id,history_incarnation,acked_space_seq,updated_at", "$1,$2,$3,$4,$5"): [
            episode_id: String => id(EpisodeId),
            space_id: String => id(SpaceId),
            history_incarnation: Vec<u8> => blob,
            acked_space_seq: i64 => num,
            updated_at: i64 => num,
        ]
        pk(sqlite_order: "episode_id,space_id", pg_order: "episode_id COLLATE \"C\",space_id COLLATE \"C\"", sqlite_gt: "(episode_id,space_id) > ($1,$2)", pg_gt: "(episode_id COLLATE \"C\",space_id COLLATE \"C\") > ($1,$2)", limit_param: "$3"): [
            episode_id: String,
            space_id: String,
        ]
        indexes(|r| {
            validate_index(r.episode_id.len() + r.space_id.len())?;
            validate_index(r.space_id.len())?;
        })
    },
    AgentTelemetryConfig (AgentTelemetryConfigRow, "agent_telemetry_config") {
        cols("singleton,detailed_enabled,compact_retention_days,detailed_retention_days,version,updated_at", "$1,$2,$3,$4,$5,$6"): [
            singleton: i64 => num,
            detailed_enabled: i64 => num,
            compact_retention_days: i64 => num,
            detailed_retention_days: i64 => num,
            version: i64 => num,
            updated_at: i64 => num,
        ]
        pk(sqlite_order: "singleton", pg_order: "singleton", sqlite_gt: "singleton > $1", pg_gt: "singleton > $1", limit_param: "$2"): [
            singleton: i64,
        ]
        indexes(|_r| { validate_index(8)?; })
    },
    AgentCalls (AgentCallsRow, "agent_calls") {
        cols("call_id,owner_id,principal,agent,transport,request_id,episode_id,tool,effect,domain,started_at,finished_at,duration_ms,outcome,reason,input_bytes,output_bytes,summaries,fingerprint,projection_version,redacted,truncated,detail_capture_failed", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23"): [
            call_id: String => text,
            owner_id: String => id(PrincipalId),
            principal: String => text,
            agent: Option<String> => opt_text,
            transport: String => text,
            request_id: String => text,
            episode_id: Option<String> => opt_id(EpisodeId),
            tool: String => text,
            effect: String => text,
            domain: String => text,
            started_at: i64 => num,
            finished_at: Option<i64> => num,
            duration_ms: Option<i64> => num,
            outcome: Option<String> => opt_text,
            reason: Option<String> => opt_text,
            input_bytes: i64 => num,
            output_bytes: Option<i64> => num,
            summaries: String => text,
            fingerprint: Vec<u8> => blob,
            projection_version: i64 => num,
            redacted: i64 => num,
            truncated: i64 => num,
            detail_capture_failed: i64 => num,
        ]
        pk(sqlite_order: "call_id", pg_order: "call_id COLLATE \"C\"", sqlite_gt: "call_id > $1", pg_gt: "call_id COLLATE \"C\" > $1", limit_param: "$2"): [
            call_id: String,
        ]
        indexes(|r| {
            validate_index(r.call_id.len())?;
            validate_index(r.owner_id.len() + 8 + r.call_id.len())?;
            validate_index(r.owner_id.len() + r.episode_id.as_ref().map_or(0, String::len) + 8 + r.call_id.len())?;
        })
    },
    AgentCallDetails (AgentCallDetailsRow, "agent_call_details") {
        cols("call_id,payload,created_at,expires_at", "$1,$2,$3,$4"): [
            call_id: String => text,
            payload: String => text,
            created_at: i64 => num,
            expires_at: i64 => num,
        ]
        pk(sqlite_order: "call_id", pg_order: "call_id COLLATE \"C\"", sqlite_gt: "call_id > $1", pg_gt: "call_id COLLATE \"C\" > $1", limit_param: "$2"): [
            call_id: String,
        ]
        indexes(|r| { validate_index(r.call_id.len())?; })
    },
    AgentRetrievals (AgentRetrievalsRow, "agent_retrievals") {
        cols("retrieval_id,owner_id,principal,agent,call_id,tool,query_summary,filters,hit_refs,result_count,top_score,created_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12"): [
            retrieval_id: String => text,
            owner_id: String => id(PrincipalId),
            principal: String => text,
            agent: Option<String> => opt_text,
            call_id: Option<String> => opt_text,
            tool: String => text,
            query_summary: String => text,
            filters: String => text,
            hit_refs: String => text,
            result_count: i64 => num,
            top_score: Option<f64> => opt_f64,
            created_at: i64 => num,
        ]
        pk(sqlite_order: "retrieval_id", pg_order: "retrieval_id COLLATE \"C\"", sqlite_gt: "retrieval_id > $1", pg_gt: "retrieval_id COLLATE \"C\" > $1", limit_param: "$2"): [
            retrieval_id: String,
        ]
        indexes(|r| {
            validate_index(r.retrieval_id.len())?;
            validate_index(r.owner_id.len() + 8 + r.retrieval_id.len())?;
            validate_index(r.call_id.as_ref().map_or(0, String::len))?;
        })
    },
    McpDedup (McpDedupRow, "mcp_dedup") {
        cols("owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at", "$1,$2,$3,$4,$5,$6,$7,$8"): [
            owner: String => id(PrincipalId),
            actor: String => text,
            request_key: String => text,
            request_hash: Vec<u8> => blob,
            operation: String => text,
            safe_result: String => text,
            effect: String => text,
            expires_at: i64 => num,
        ]
        pk(sqlite_order: "owner,actor,request_key", pg_order: "owner COLLATE \"C\",actor COLLATE \"C\",request_key COLLATE \"C\"", sqlite_gt: "(owner,actor,request_key) > ($1,$2,$3)", pg_gt: "(owner COLLATE \"C\",actor COLLATE \"C\",request_key COLLATE \"C\") > ($1,$2,$3)", limit_param: "$4"): [
            owner: String,
            actor: String,
            request_key: String,
        ]
        indexes(|r| { validate_index(r.owner.len() + r.actor.len() + r.request_key.len())?; })
    },
    AgentSchedules (AgentSchedulesRow, "agent_schedules") {
        cols("schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,config_revision,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,revision,created_at,updated_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19"): [
            schedule_id: String => id(ScheduleId),
            owner_id: String => id(PrincipalId),
            space_id: String => id(SpaceId),
            project_folder_id: Option<String> => opt_id(FolderId),
            title: String => text,
            init_prompt: String => text,
            config_revision: i64 => num,
            cron_expr: String => text,
            timezone: String => text,
            approved_role: String => text,
            paused_reason: Option<String> => opt_text,
            write_class_mask: i64 => num,
            budgets: String => text,
            misfire_policy: String => text,
            next_slot_utc_ms: i64 => num,
            deleted_at: Option<i64> => num,
            revision: i64 => num,
            created_at: i64 => num,
            updated_at: i64 => num,
        ]
        pk(sqlite_order: "schedule_id", pg_order: "schedule_id COLLATE \"C\"", sqlite_gt: "schedule_id > $1", pg_gt: "schedule_id COLLATE \"C\" > $1", limit_param: "$2"): [
            schedule_id: String,
        ]
        indexes(|r| {
            validate_index(r.schedule_id.len())?;
            validate_index(8 + r.paused_reason.as_ref().map_or(0, String::len) + 8 + r.schedule_id.len())?;
            validate_index(r.owner_id.len() + r.space_id.len() + r.schedule_id.len())?;
        })
    },
    AgentScheduleRuns (AgentScheduleRunsRow, "agent_schedule_runs") {
        cols("run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16"): [
            run_id: String => id(AgentRunId),
            schedule_id: String => id(ScheduleId),
            slot_utc_ms: i64 => num,
            lease_epoch: i64 => num,
            claim_request_hash: Vec<u8> => blob,
            owner_auth_version: i64 => num,
            config_revision: i64 => num,
            admission_epoch: i64 => num,
            history_scope: String => text,
            expires_at: i64 => num,
            claimed_schedule_revision: i64 => num,
            reserved_next_slot: i64 => num,
            status: String => text,
            started_at: i64 => num,
            finished_at: Option<i64> => num,
            safe_result: Option<String> => opt_text,
        ]
        pk(sqlite_order: "run_id", pg_order: "run_id COLLATE \"C\"", sqlite_gt: "run_id > $1", pg_gt: "run_id COLLATE \"C\" > $1", limit_param: "$2"): [
            run_id: String,
        ]
        indexes(|r| {
            validate_index(r.run_id.len())?;
            validate_index(r.schedule_id.len() + 8)?;
            validate_index(r.schedule_id.len() + r.status.len() + 8 + r.run_id.len())?;
        })
    },
    ControlCommands (ControlCommandsRow, "control_commands") {
        cols("owner,actor,command_key,request_hash,target,expected,result_revision,state,safe_result,expires_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10"): [
            owner: String => id(PrincipalId),
            actor: String => text,
            command_key: String => text,
            request_hash: Vec<u8> => blob,
            target: String => text,
            expected: i64 => num,
            result_revision: Option<i64> => num,
            state: String => text,
            safe_result: Option<String> => opt_text,
            expires_at: i64 => num,
        ]
        pk(sqlite_order: "owner,actor,command_key", pg_order: "owner COLLATE \"C\",actor COLLATE \"C\",command_key COLLATE \"C\"", sqlite_gt: "(owner,actor,command_key) > ($1,$2,$3)", pg_gt: "(owner COLLATE \"C\",actor COLLATE \"C\",command_key COLLATE \"C\") > ($1,$2,$3)", limit_param: "$4"): [
            owner: String,
            actor: String,
            command_key: String,
        ]
        indexes(|r| {
            validate_index(r.owner.len() + r.actor.len() + r.command_key.len())?;
            validate_index(r.state.len() + 8)?;
        })
    },
    ControlOperations (ControlOperationsRow, "control_operations") {
        cols("operation_id,command_key,kind,target_space,state,payload_hash,payload,canonical_receipt,next_action,updated_at", "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10"): [
            operation_id: String => text,
            command_key: String => text,
            kind: String => text,
            target_space: String => id(SpaceId),
            state: String => text,
            payload_hash: Vec<u8> => blob,
            payload: String => text,
            canonical_receipt: Option<String> => opt_text,
            next_action: String => text,
            updated_at: i64 => num,
        ]
        pk(sqlite_order: "operation_id", pg_order: "operation_id COLLATE \"C\"", sqlite_gt: "operation_id > $1", pg_gt: "operation_id COLLATE \"C\" > $1", limit_param: "$2"): [
            operation_id: String,
        ]
        indexes(|r| {
            validate_index(r.operation_id.len())?;
            validate_index(r.command_key.len())?;
            validate_index(r.state.len() + 8)?;
        })
    },
    RevocationEvents (RevocationEventsRow, "revocation_events") {
        cols("event_id,selector,reason,authority_version,committed_at,delivered_at,attempts", "$1,$2,$3,$4,$5,$6,$7"): [
            event_id: String => text,
            selector: String => text,
            reason: String => text,
            authority_version: i64 => num,
            committed_at: i64 => num,
            delivered_at: Option<i64> => num,
            attempts: i64 => num,
        ]
        pk(sqlite_order: "event_id", pg_order: "event_id COLLATE \"C\"", sqlite_gt: "event_id > $1", pg_gt: "event_id COLLATE \"C\" > $1", limit_param: "$2"): [
            event_id: String,
        ]
        indexes(|r| {
            validate_index(r.event_id.len())?;
            validate_index(8 + 8 + r.event_id.len())?;
        })
    },
}
