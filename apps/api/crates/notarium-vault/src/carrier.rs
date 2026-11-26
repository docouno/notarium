//! Untrusted Markdown carriers. A parsed identity is a hint for the vault
//! reconciler, and must be checked against the authorized canonical binding.

use notarium_core::{
    DomainResult,
    classes::DocClass,
    ids::{NoteId, RevisionId},
};
use notarium_syntax::{encrypted, frontmatter, patch, unicode::PortableFilename};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteCarrier {
    pub class: DocClass,
    pub asserted_id: Option<NoteId>,
}

pub fn inspect(source: &str) -> DomainResult<NoteCarrier> {
    let (class, asserted_id) = frontmatter::read_vault_identity(source)?;
    if class == DocClass::EncryptedNote {
        encrypted::validate(source)?;
    }
    Ok(NoteCarrier { class, asserted_id })
}

pub fn materialize(source: &str, class: DocClass, note: &NoteId) -> DomainResult<String> {
    let plan = frontmatter::patch_vault_identity(source, class, note)?;
    patch::apply(source, &plan)
}

pub fn for_observation(
    source: &str,
    canonical: &str,
    class: DocClass,
    note: &NoteId,
) -> DomainResult<String> {
    frontmatter::restore_vault_identity(source, canonical, class, note)
}

pub fn for_import(source: &str, class: DocClass) -> DomainResult<String> {
    frontmatter::strip_vault_identity(source, class)
}

pub fn conflict_filename(slug: &str, revision: &RevisionId) -> DomainResult<PortableFilename> {
    PortableFilename::conflict(slug, revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::{DomainError, error::ValidationReason, value::YamlValue};

    const ID_FIELD: &str = "notarium-id";

    #[test]
    fn rebinding_preserves_bom_crlf_inline_comment_and_body() {
        let old = NoteId::from_bytes([1; 16]);
        let new = NoteId::from_bytes([2; 16]);
        let original = format!(
            "\u{feff}---\r\n# comment\r\n{ID_FIELD}: '{old}' # retained\r\nvalues: [one, two]\r\n---\r\n# Body\r\n"
        );
        let expected = original.replace(old.as_str(), new.as_str());
        assert_eq!(inspect(&original).unwrap().asserted_id, Some(old));
        assert_eq!(
            materialize(&original, DocClass::UserDoc, &new).unwrap(),
            expected
        );
        assert_eq!(inspect(&expected).unwrap().asserted_id, Some(new));
    }

    #[test]
    fn metadata_is_created_at_the_bom_boundary() {
        let original = "\u{feff}# Body\r\n";
        let note = NoteId::from_bytes([9; 16]);
        let normalized = materialize(original, DocClass::UserDoc, &note).unwrap();
        assert_eq!(
            normalized,
            format!("\u{feff}---\r\n\"{ID_FIELD}\": \"{note}\"\r\n---\r\n# Body\r\n")
        );
    }

    #[test]
    fn malformed_id_and_protected_class_are_rejected() {
        let note = NoteId::from_bytes([7; 16]);
        let ambiguous = format!("---\n{ID_FIELD}: {note}\n{ID_FIELD}: false\n---\n");
        let malformed = format!("---\n{ID_FIELD}: false\n---\n# Authored\n");
        let protected = format!("---\nclass: skill\n{ID_FIELD}: {note}\n---\n# Authored\n");
        assert!(inspect(&ambiguous).is_err());
        assert!(inspect(&malformed).is_err());
        assert!(inspect(&protected).is_err());
        assert!(materialize(&protected, DocClass::UserDoc, &note).is_err());
        assert_eq!(
            frontmatter::set_field(
                "",
                DocClass::UserDoc,
                ID_FIELD,
                YamlValue::String(note.to_string())
            )
            .unwrap_err(),
            DomainError::validation(ValidationReason::ProtectedField)
        );
    }

    #[test]
    fn observation_reuses_the_canonical_header_for_body_only_edits() {
        let note = NoteId::from_bytes([6; 16]);
        for canonical in ["\u{feff}# Before\r\n", "---\namount: 42\n---\n# Before\n"] {
            let projected = materialize(canonical, DocClass::UserDoc, &note).unwrap();
            let edited = projected.replace("# Before", "# After");
            let observed = for_observation(&edited, canonical, DocClass::UserDoc, &note).unwrap();
            assert_eq!(observed, canonical.replace("# Before", "# After"));
        }
    }

    #[test]
    fn observation_preserves_unrelated_edits_and_canonical_identity() {
        let canonical_id = NoteId::from_bytes([1; 16]);
        let bound_id = NoteId::from_bytes([2; 16]);
        let canonical =
            format!("---\n{ID_FIELD}: '{canonical_id}' # keep\namount: 42\n---\n# Body");
        let projected = materialize(&canonical, DocClass::UserDoc, &bound_id).unwrap();
        let edited = projected.replace("amount: 42", "amount: 24");
        assert_eq!(
            for_observation(&edited, &canonical, DocClass::UserDoc, &bound_id).unwrap(),
            canonical.replace("amount: 42", "amount: 24")
        );
    }

    #[test]
    fn import_drops_the_disk_claim_before_admission() {
        let claimed = NoteId::from_bytes([5; 16]);
        let source = format!("---\n{ID_FIELD}: {claimed}\n---\n# Body\n");
        assert_eq!(inspect(&source).unwrap().asserted_id, Some(claimed));
        assert_eq!(for_import(&source, DocClass::UserDoc).unwrap(), "# Body\n");
    }

    #[test]
    fn encrypted_source_must_validate_even_when_only_identity_changes() {
        let note = NoteId::from_bytes([3; 16]);
        let source = "---\nclass: encrypted-note\n---\nplaintext\n```age\ninvalid\n```\n";
        assert_eq!(
            inspect(source).unwrap_err(),
            DomainError::UnsafePlaintextOutsideAgeFence
        );
        assert_eq!(
            materialize(source, DocClass::EncryptedNote, &note).unwrap_err(),
            DomainError::UnsafePlaintextOutsideAgeFence
        );
    }

    #[test]
    fn encrypted_identity_round_trips_without_modifying_the_age_carrier() {
        const ARMOR: &str = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
        let note = NoteId::from_bytes([3; 16]);
        let source = format!("---\nclass: encrypted-note\n---\n# Private\n```age\n{ARMOR}```\n");
        let projected = materialize(&source, DocClass::EncryptedNote, &note).unwrap();
        assert!(projected.contains(ARMOR));
        assert_eq!(inspect(&projected).unwrap().asserted_id, Some(note.clone()));
        assert_eq!(
            for_observation(&projected, &source, DocClass::EncryptedNote, &note).unwrap(),
            source
        );
    }

    #[test]
    fn conflict_filename_keeps_the_full_revision_within_the_portable_limit() {
        let revision = RevisionId::from_bytes([4; 16]);
        let name = conflict_filename(&"🪿".repeat(71), &revision).unwrap();
        assert!(name.as_str().ends_with(&format!(".conflict-{revision}.md")));
        assert!(name.as_str().len() <= 255);
    }
}
