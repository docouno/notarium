use caseless::Caseless;
use notarium_core::{
    DomainError, DomainResult,
    error::{SourceLocation, ValidationReason},
    ids::RevisionId,
};
use unicode_normalization::UnicodeNormalization;

pub const CASEFOLD_UNICODE_VERSION: (u64, u64, u64) = caseless::UNICODE_VERSION;
pub const NORMALIZATION_UNICODE_VERSION: (u8, u8, u8) = unicode_normalization::UNICODE_VERSION;
pub fn lookup_key(input: &str) -> String {
    input.nfd().default_case_fold().nfc().collect()
}
/// Normalize the spelling of a relative archive entry without folding its case.
pub fn portable_archive_path(path: &str, max_depth: usize) -> DomainResult<String> {
    let normalized: String = path.nfc().collect();
    for (depth, component) in normalized.split('/').enumerate() {
        if depth >= max_depth {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded));
        }
        PortableFilename::parse(component)?;
    }
    Ok(normalized)
}
pub(crate) fn source_location(source: &str, offset: usize) -> SourceLocation {
    let prefix = &source[..offset];
    let mut line = 1;
    let mut column = 1;
    for part in crate::lines::with_endings(prefix) {
        if crate::lines::ending(part).is_some() {
            line += 1;
            column = 1;
        } else {
            column = part.chars().count() as u64 + 1;
        }
    }
    SourceLocation {
        byte_offset: offset as u64,
        line,
        column,
        code_point: source[offset..].chars().next(),
    }
}
pub fn validate_content(source: &str) -> DomainResult<()> {
    for (offset, ch) in source.char_indices() {
        if (ch.is_control() && !matches!(ch, '\t' | '\n' | '\r')) || ch == '\u{7f}' {
            return Err(DomainError::at(
                ValidationReason::DisallowedCodePoint,
                source_location(source, offset),
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortableFilename(String);
impl PortableFilename {
    pub fn parse(value: &str) -> DomainResult<Self> {
        validate_component(value)?;
        if value.len() > 255 || value.encode_utf16().count() > 255 {
            return Err(DomainError::validation(ValidationReason::FilenameTooLong));
        }
        Ok(Self(value.to_owned()))
    }
    pub fn note_slug(slug: &str) -> DomainResult<Self> {
        validate_component(slug)?;
        Self::parse(&format!("{slug}.md"))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn conflict(human_prefix: &str, revision: &RevisionId) -> DomainResult<Self> {
        let suffix = format!(".conflict-{revision}.md");
        let prefix = if human_prefix.is_empty() {
            "note"
        } else {
            human_prefix
        };
        validate_component(prefix)?;
        let budget = 255 - suffix.len();
        let mut end = prefix.len().min(budget);
        while !prefix.is_char_boundary(end) {
            end -= 1;
        }
        let shortened = prefix[..end].trim_end_matches(['.', ' ']);
        let shortened = if shortened.is_empty() {
            "note"
        } else {
            shortened
        };
        Self::parse(&format!("{shortened}{suffix}"))
    }
}
pub fn validate_component(value: &str) -> DomainResult<()> {
    let invalid = || DomainError::validation(ValidationReason::InvalidPathComponent);
    if value.is_empty() || value == "." || value == ".." || value.ends_with(['.', ' ']) {
        return Err(invalid());
    }
    for (offset, ch) in value.char_indices() {
        if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
            return Err(DomainError::at(
                ValidationReason::InvalidPathComponent,
                source_location(value, offset),
            ));
        }
    }
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(
                &stem[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
    {
        return Err(invalid());
    }
    Ok(())
}
