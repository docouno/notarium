//! Materialize only the accepted schema and explicitly bound owned packages.

use std::{collections::BTreeMap, fmt::Write, path::PathBuf};

use notarium_canonical::{
    CanonicalStore,
    domain::packages::{ABILITY_ENTRYPOINT_KEY, MAX_ABILITY_PACKAGE_RAW_BYTES},
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    model::AbilityResourceName,
    ports::{
        AbilityPackageRevision, MAX_ABILITY_AUX_FILES, MAX_ABILITY_AUX_PATH_BYTES,
        ReadAbilityResource, SpaceContext,
    },
    query::{FieldSchema, FieldType, ScalarType},
};
use notarium_syntax::unicode::{PortableFilename, lookup_key};

mod publication;
use crate::filesystem::is_internal_name;
pub use publication::{MaterialError, ReservedConflict, ReservedConflictKind, ReservedMaterials};

pub const FIELDS_SCHEMA_PATH: &str = ".notarium/fields/schema.yaml";
pub const ABILITIES_DIRECTORY: &str = ".notarium/abilities";

fn scalar_name(scalar: ScalarType) -> &'static str {
    match scalar {
        ScalarType::String => "string",
        ScalarType::Bool => "bool",
        ScalarType::Number => "number",
        ScalarType::Date => "date",
        ScalarType::Timestamp => "timestamp",
    }
}

fn yaml_key(key: &str) -> String {
    let simple = key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && !matches!(
            key,
            "null" | "true" | "false" | "yes" | "no" | "on" | "off" | "y" | "n"
        );
    if simple {
        key.into()
    } else {
        // JSON supplies the double-quoted scalar syntax. Escape characters
        // that YAML reserves or older readers may treat as line breaks.
        let quoted = serde_json::to_string(key).expect("serializing a string cannot fail");
        let mut yaml = String::with_capacity(quoted.len());
        for ch in quoted.chars() {
            match ch {
                '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{fffe}' | '\u{ffff}' => {
                    write!(yaml, "\\u{:04x}", u32::from(ch)).unwrap();
                }
                _ => yaml.push(ch),
            }
        }
        yaml
    }
}

pub fn schema_yaml(fields: &BTreeMap<String, FieldSchema>) -> String {
    if fields.is_empty() {
        return "version: 1\nfields: {}\n".into();
    }
    let mut yaml = String::from("version: 1\nfields:\n");
    for (key, field) in fields {
        let (kind, items) = match field.kind {
            FieldType::Scalar(scalar) => (scalar_name(scalar), None),
            FieldType::List(scalar) => ("list", Some(scalar_name(scalar))),
            FieldType::Map => ("map", None),
        };
        writeln!(yaml, "  {}:\n    type: {kind}", yaml_key(key)).unwrap();
        if let Some(items) = items {
            writeln!(yaml, "    items: {items}").unwrap();
        }
        writeln!(yaml, "    nullable: {}", field.nullable).unwrap();
    }
    yaml
}

type ManifestPaths = BTreeMap<String, PathBuf>;

fn manifest_paths(package: &AbilityPackageRevision) -> Result<ManifestPaths, DomainError> {
    if !package.manifest.contains_key(ABILITY_ENTRYPOINT_KEY) {
        return Err(DomainError::validation(ValidationReason::InvalidState));
    }
    if package.manifest.len() > MAX_ABILITY_AUX_FILES + 1 {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded));
    }
    let mut paths = BTreeMap::new();
    let mut entries = BTreeMap::new();
    for path in package.manifest.keys() {
        if path.len() > MAX_ABILITY_AUX_PATH_BYTES {
            return Err(DomainError::validation(ValidationReason::FilenameTooLong));
        }
        let mut actual = PathBuf::new();
        let mut folded = String::new();
        let mut segments = path.split('/').peekable();
        while let Some(segment) = segments.next() {
            PortableFilename::parse(segment)?;
            if is_internal_name(segment.as_ref()) {
                return Err(DomainError::validation(
                    ValidationReason::InvalidPathComponent,
                ));
            }
            actual.push(segment);
            if !folded.is_empty() {
                folded.push('/');
            }
            folded.push_str(&lookup_key(segment));
            let directory = segments.peek().is_some();
            if let Some((previous, was_directory)) =
                entries.insert(folded.clone(), (actual.clone(), directory))
                && (previous != actual || !directory || !was_directory)
            {
                return Err(DomainError::validation(ValidationReason::DuplicateKey));
            }
        }
        paths.insert(path.clone(), actual);
    }
    Ok(paths)
}

fn no_access(error: &PortError) -> bool {
    matches!(
        error,
        PortError::Domain(DomainError::ResourceNotFound | DomainError::AccessDenied)
    )
}

async fn read_ability_files(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    revision: &AbilityPackageRevision,
) -> Result<Option<BTreeMap<PathBuf, Vec<u8>>>, MaterialError> {
    let mut files = BTreeMap::new();
    let mut total_bytes = 0;
    for (key, path) in manifest_paths(revision)? {
        let name = if key == ABILITY_ENTRYPOINT_KEY {
            AbilityResourceName::Entrypoint
        } else {
            AbilityResourceName::Auxiliary(key.clone())
        };
        let read = store
            .read_ability_resource(
                ctx.clone(),
                ReadAbilityResource {
                    ability: revision.ability.clone(),
                    package_revision: revision.revision.clone(),
                    resource: name,
                },
            )
            .await;
        let content = match read {
            Ok(value) => value,
            Err(error) if no_access(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let text = content.explicit_read(ctx.auth())?;
        let expected = revision.manifest[&key];
        if content.digest() != expected || notarium_syntax::content_digest(text) != expected {
            return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
        }
        total_bytes += text.len() as u64;
        if total_bytes > MAX_ABILITY_PACKAGE_RAW_BYTES {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        files.insert(path, text.as_bytes().to_vec());
    }
    Ok(Some(files))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::digest;
    use notarium_core::ids::{AbilityId, RevisionId};

    #[test]
    fn exports_the_typed_descriptor_in_stable_order() {
        let fields = BTreeMap::from([(
            "due".into(),
            FieldSchema {
                kind: FieldType::Scalar(ScalarType::Date),
                nullable: true,
            },
        )]);
        assert_eq!(
            schema_yaml(&fields),
            "version: 1\nfields:\n  due:\n    type: date\n    nullable: true\n"
        );
        let mut fields = fields;
        fields.insert(
            "owner:\n\"name\"".into(),
            FieldSchema {
                kind: FieldType::Map,
                nullable: false,
            },
        );
        fields.insert(
            "true".into(),
            FieldSchema {
                kind: FieldType::List(ScalarType::Timestamp),
                nullable: true,
            },
        );
        assert_eq!(
            schema_yaml(&fields),
            concat!(
                "version: 1\nfields:\n  due:\n    type: date\n    nullable: true\n",
                "  \"owner:\\n\\\"name\\\"\":\n    type: map\n    nullable: false\n",
                "  \"true\":\n    type: list\n    items: timestamp\n    nullable: true\n",
            )
        );
        assert_eq!(schema_yaml(&BTreeMap::new()), "version: 1\nfields: {}\n");
    }

    #[test]
    fn manifest_rejects_traversal_aliases_and_file_directory_shadowing() {
        let build = |aux: &[&str]| AbilityPackageRevision {
            ability: AbilityId::from_bytes([1; 16]),
            revision: RevisionId::from_bytes([2; 16]),
            manifest: std::iter::once(ABILITY_ENTRYPOINT_KEY)
                .chain(aux.iter().copied())
                .map(|key| (key.into(), digest(b"fixture")))
                .collect(),
        };
        for keys in [
            &["../outside"][..],
            &["skILL.md"],
            &["skill.md/a"],
            &["shared/File", "SHARED/another"],
            &["file", "file/child"],
            &["docs//file"],
            &["docs/.notarium-stage-f7fb31da8fef9d54"],
        ] {
            assert!(manifest_paths(&build(keys)).is_err(), "{keys:?}");
        }
        assert!(manifest_paths(&build(&["docs/readme", "docs/details"])).is_ok());
    }
}
