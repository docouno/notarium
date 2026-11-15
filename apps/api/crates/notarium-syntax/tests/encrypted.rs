use notarium_core::{DomainError, classes::DocClass, ids::NoteId, value::YamlValue};
use notarium_syntax::{
    encrypted,
    extract::{self, ExtractedDocDelta},
    frontmatter::FieldEdit,
    patch,
};
use std::io::{Read, Write};

// Public age testkit known-answer vector, also shipped by age 0.12.1 at
// tests/testdata/testkit/armor. The identity below is public test data only.
const ARMOR: &str = include_str!("fixtures/age-v1.asc");
fn document() -> String {
    format!("---\nclass: encrypted-note\ntitle: Private\n---\n# Private\n\n```age\n{ARMOR}```\n")
}
#[test]
fn independent_known_answer_authenticates_the_standard_age_payload() {
    let identity: age::x25519::Identity =
        "AGE-SECRET-KEY-1EGTZVFFV20835NWYV6270LXYVK2VKNX2MMDKWYKLMGR48UAWX40Q2P2LM0"
            .parse()
            .unwrap();
    let reader = age::armor::ArmoredReader::new(ARMOR.as_bytes());
    let decryptor = age::Decryptor::new(reader).unwrap();
    let mut cleartext = Vec::new();
    decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .unwrap()
        .read_to_end(&mut cleartext)
        .unwrap();
    assert_eq!(cleartext, b"age");
    encrypted::validate_armor(ARMOR).unwrap();
}
#[test]
fn encrypted_dispatch_has_no_secondary_payload_and_metadata_preserves_armor() {
    let note = NoteId::from_bytes([1; 16]);
    for source in [document(), document().replace('\n', "\r\n")] {
        let ExtractedDocDelta::Encrypted(validated) =
            extract::extract(&source, DocClass::EncryptedNote, &note, "Private", None).unwrap()
        else {
            panic!("encrypted content reached secondary extraction")
        };
        assert!(validated.title.is_some());
        let plan = extract::finalize_document(
            &source,
            DocClass::EncryptedNote,
            &note,
            &[FieldEdit::Set {
                key: "title".into(),
                value: YamlValue::String("Renamed".into()),
            }],
        )
        .unwrap();
        assert_eq!(
            patch::apply(&source, &plan).unwrap(),
            source.replacen("title: Private", "title: Renamed", 1)
        );
        assert!(extract::extract(&source, DocClass::UserDoc, &note, "Private", None).is_err());
    }
}
#[test]
fn raw_outside_bytes_are_checked_even_when_markdown_hides_them() {
    for outside in [
        "secret\n",
        "<!-- hidden -->\n",
        "[hidden]: https://example.test\n",
        "# Second\n",
        "`secret`\n",
        "```text\nsecret\n```\n",
        "[[hidden]] #tag\n",
        "\u{200b}\n",
    ] {
        let source = format!("{}{outside}", document());
        assert_eq!(
            encrypted::validate(&source).unwrap_err(),
            DomainError::UnsafePlaintextOutsideAgeFence
        );
    }
    for title in [
        "# *Private*",
        "# [[Private]]",
        "# <b>Private</b>",
        "# `Private`",
        "# _Private_",
    ] {
        assert_eq!(
            encrypted::validate(&document().replace("# Private", title)).unwrap_err(),
            DomainError::UnsafePlaintextOutsideAgeFence
        );
    }
}
#[test]
fn armor_requires_a_complete_header_nonce_and_payload_and_one_closed_fence() {
    let source = document();
    for bad in [
        source.replace("```\n", ""),
        format!("{source}```age\n{ARMOR}```\n"),
        source.replace("yPC8DpksHoMx+2Y=", "!"),
        source.replace(
            ARMOR,
            "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n",
        ),
    ] {
        assert!(encrypted::validate(&bad).is_err());
    }
    let mut decoded = Vec::new();
    age::armor::ArmoredReader::new(ARMOR.as_bytes())
        .read_to_end(&mut decoded)
        .unwrap();
    let mut remainder = decoded.as_slice();
    let _ = age::Decryptor::new(&mut remainder).unwrap();
    assert_eq!(remainder.len(), 19);
    let header_len = decoded.len() - remainder.len();
    for payload_len in [0, 1, 15] {
        let mut armor = Vec::new();
        let mut writer =
            age::armor::ArmoredWriter::wrap_output(&mut armor, age::armor::Format::AsciiArmor)
                .unwrap();
        writer
            .write_all(&decoded[..header_len + payload_len])
            .unwrap();
        writer.finish().unwrap();
        assert!(encrypted::validate_armor(std::str::from_utf8(&armor).unwrap()).is_err());
    }
}

#[test]
fn metadata_helpers_also_reject_an_unsafe_existing_encrypted_carrier() {
    let source = format!("{}<!-- hidden -->\n", document());
    assert_eq!(
        notarium_syntax::frontmatter::set_field(
            &source,
            DocClass::EncryptedNote,
            "title",
            YamlValue::String("Renamed".into())
        )
        .unwrap_err(),
        DomainError::UnsafePlaintextOutsideAgeFence
    );
    assert!(encrypted::validate(&document().replace("\n```\n", "\n    ```\n")).is_err());
}

#[test]
fn every_line_ending_separates_plaintext_from_the_permitted_title() {
    let note = NoteId::from_bytes([1; 16]);
    for separator in ["\r", "\r\n", "\n", "\r\r\n"] {
        let source = document().replace("# Private", &format!("# Private{separator}secret"));
        assert_eq!(
            encrypted::validate(&source).unwrap_err(),
            DomainError::UnsafePlaintextOutsideAgeFence
        );
        assert!(
            extract::extract(&source, DocClass::EncryptedNote, &note, "Private", None).is_err()
        );
        assert!(extract::finalize_document(&source, DocClass::EncryptedNote, &note, &[]).is_err());
    }
}

#[test]
fn opaque_headers_cannot_hide_protected_class_declarations() {
    let note = NoteId::from_bytes([1; 16]);
    for header in [
        "? class\n: encrypted-note\nx: 1\nx: 2",
        "?\n  class\n: encrypted-note\nx: 1\nx: 2",
        "{? class: encrypted-note, x: 1, x: 2}",
        "class: &kind encrypted-note\nx: *kind",
        "kind: &kind encrypted-note\nclass: *kind",
        "class: user-doc\n? class\n: encrypted-note",
        "base: &base {class: encrypted-note}\n<<: *base",
    ] {
        let source = format!("---\n{header}\n---\n# Secret\ntext\n");
        assert!(
            extract::extract(&source, DocClass::UserDoc, &note, "Secret", None).is_err(),
            "{header}"
        );
        assert!(extract::finalize_document(&source, DocClass::UserDoc, &note, &[]).is_err());
        assert!(
            notarium_syntax::live::raw_header_plan(
                "# Secret\ntext\n",
                &source,
                DocClass::UserDoc,
                notarium_core::ids::HeaderIdentity::from_bytes([1; 16])
            )
            .is_err()
        );
    }
}
