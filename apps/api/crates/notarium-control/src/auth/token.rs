use crate::error::{invalid, unavailable};
use notarium_core::error::{CommitEffect, PortError, ValidationReason};
use sha2::{Digest, Sha256};
use std::fmt;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TokenKind {
    Session,
    OneTime,
    AuthorizationCode,
    Pat,
    Access,
    Refresh,
}
impl TokenKind {
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Session => "nts_",
            Self::OneTime => "nti_",
            Self::AuthorizationCode => "ntac_",
            Self::Pat => "ntp_",
            Self::Access => "nto_",
            Self::Refresh => "ntr_",
        }
    }
    fn split(self) -> bool {
        matches!(self, Self::Pat | Self::Access | Self::Refresh)
    }
}

/// The verifier is the digest of the full token or just its secret segment,
/// according to the persisted token grammar. The raw bearer is returned once.
pub struct MintedToken {
    pub secret: Secret,
    pub id: Option<String>,
    pub digest: [u8; 32],
}
impl fmt::Debug for MintedToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MintedToken")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut value, "{byte:02x}").expect("writing a String");
    }
    value
}
pub(crate) fn random<const N: usize>() -> Result<[u8; N], PortError> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| unavailable("control entropy", CommitEffect::NotCommitted))?;
    Ok(bytes)
}
pub fn digest(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}
pub fn verify(expected: &[u8; 32], actual: &[u8; 32]) -> bool {
    bool::from(expected.ct_eq(actual))
}

pub fn mint(kind: TokenKind) -> Result<MintedToken, PortError> {
    let id = if kind.split() {
        Some(hex(&random::<6>()?))
    } else {
        None
    };
    let tail = if kind == TokenKind::Session {
        hex(&random::<32>()?)
    } else {
        hex(&random::<24>()?)
    };
    let value = if let Some(id) = &id {
        format!("{}{id}_{tail}", kind.prefix())
    } else {
        format!("{}{tail}", kind.prefix())
    };
    let verifier = digest(if kind.split() {
        tail.as_bytes()
    } else {
        value.as_bytes()
    });
    Ok(MintedToken {
        secret: Secret::new(value),
        id,
        digest: verifier,
    })
}

pub fn parse(kind: TokenKind, value: &str) -> Result<(Option<&str>, [u8; 32]), PortError> {
    let invalid = || invalid(ValidationReason::InvalidAuthority);
    let body = value.strip_prefix(kind.prefix()).ok_or_else(invalid)?;
    let valid_hex = |text: &str, len| {
        text.len() == len
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if kind.split() {
        let (id, secret) = body.split_once('_').ok_or_else(invalid)?;
        if !valid_hex(id, 12) || !valid_hex(secret, 48) {
            return Err(invalid());
        }
        Ok((Some(id), digest(secret.as_bytes())))
    } else {
        if !valid_hex(body, if kind == TokenKind::Session { 64 } else { 48 }) {
            return Err(invalid());
        }
        Ok((None, digest(value.as_bytes())))
    }
}
