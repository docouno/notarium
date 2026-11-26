//! Concrete byte ranges are independent of the semantic YAML parser's character offsets.
use crate::{
    carrier::{BlockScalar, Carrier},
    patch, yaml,
};
use notarium_core::{
    DomainError, DomainResult,
    classes::{DocClass, VAULT_IDENTITY_FIELD, authorize_field_key},
    error::ValidationReason,
    ids::NoteId,
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    span::ByteSpan,
    value::YamlValue,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub enum FieldEdit {
    Set { key: String, value: YamlValue },
    Unset { key: String },
}
impl FieldEdit {
    pub fn key(&self) -> &str {
        match self {
            Self::Set { key, .. } | Self::Unset { key } => key,
        }
    }
}
#[derive(Clone, Debug)]
pub struct HeaderAnalysis {
    pub carrier: Carrier,
    pub fields: Option<BTreeMap<String, YamlValue>>,
    pub writable: bool,
    pub diagnostic: Option<ValidationReason>,
}
#[derive(Clone, Debug)]
struct Entry {
    key: String,
    prefix: ByteSpan,
    values: Vec<ByteSpan>,
    /// Deletable syntax nodes; comments/whitespace between them remain authored
    /// trivia. Block-scalar tails include value data, including literal '#'.
    erase: Vec<ByteSpan>,
}
#[derive(Clone, Debug)]
struct MappingCst {
    entries: Vec<Entry>,
    commas: Vec<ByteSpan>,
    flow_close: Option<usize>,
    indent: usize,
    has_tokens: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
    Scalar,
    Indicator,
    Property,
    Colon,
    Open,
    Close,
    Comma,
}
#[derive(Clone, Debug)]
struct Token {
    kind: Kind,
    span: ByteSpan,
    depth: usize,
    tail: Option<ByteSpan>,
}

fn failure(reason: ValidationReason) -> DomainError {
    DomainError::validation(reason)
}
fn span(a: usize, b: usize) -> DomainResult<ByteSpan> {
    ByteSpan::new(a, b)
}
fn line_start(source: &str, offset: usize) -> usize {
    source[..offset].rfind(['\r', '\n']).map_or(0, |i| i + 1)
}
fn leading(source: &str, offset: usize) -> Option<usize> {
    let start = line_start(source, offset);
    source[start..offset]
        .bytes()
        .all(|b| b == b' ')
        .then_some(offset - start)
}

/// A block scalar belongs to the preceding mapping key or sequence entry. Its
/// marker may be on a later line, so the marker's own column is not the parent
/// indentation. Properties such as `!!str` do not change that relationship.
fn scalar_parent_indent(source: &str, tokens: &[Token]) -> usize {
    let Some(index) = tokens.iter().rposition(|t| t.kind != Kind::Property) else {
        return 0;
    };
    let token = &tokens[index];
    let owner = if token.kind == Kind::Colon && index > 0 {
        &tokens[index - 1]
    } else {
        token
    };
    owner.span.start() - line_start(source, owner.span.start())
}

/// Scan only value-data lines. A dedented comment ends a scalar even when it is
/// still indented farther than the parent node. Empty lines belong to the scalar;
/// semantic validation has already checked their indentation and chomping rules.
fn scalar_tail_end(source: &str, start: usize, marker: &str, parent: usize) -> usize {
    let mut scalar = BlockScalar::new(parent, marker);
    let mut end = start;
    for line in crate::lines::with_endings(&source[start..]) {
        if !scalar.contains_line(line) {
            break;
        }
        end += line.len();
    }
    end
}

/// Token boundaries only, not a second YAML value parser. Byte scanning never uses
/// saphyr markers. Comments are trivia, while block-scalar contents are value data.
fn tokens(source: &str) -> DomainResult<Vec<Token>> {
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut depth = 0usize;
    let mut result = Vec::new();
    let mut plain_parent = None;
    let mut flow_plain = false;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b == b'#' {
            while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                i += 1;
            }
            continue;
        }
        let start = i;
        let continuing = depth > 0 && flow_plain
            || depth == 0
                && plain_parent.is_some_and(|parent| {
                    leading(source, start).is_some_and(|indent| indent > parent)
                });
        if depth == 0 && leading(source, start).is_some() && !continuing {
            plain_parent = None;
        }
        let mut plain_token = false;
        let kind = match b {
            b'-' | b'?'
                if !continuing
                    && depth == 0
                    && bytes.get(i + 1).is_none_or(u8::is_ascii_whitespace) =>
            {
                i += 1;
                Kind::Indicator
            }
            b'!' if !continuing => {
                // Tags are node properties, not part of a plain scalar. The YAML
                // parser validates their spelling; retain their concrete bytes.
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                Kind::Property
            }
            b'{' | b'[' if !continuing || depth > 0 => {
                depth += 1;
                i += 1;
                Kind::Open
            }
            b'}' | b']' if !continuing || depth > 0 => {
                if depth == 0 {
                    return Err(failure(ValidationReason::InvalidYaml));
                }
                depth -= 1;
                i += 1;
                Kind::Close
            }
            b',' if !continuing || depth > 0 => {
                i += 1;
                Kind::Comma
            }
            b':' if !continuing
                || bytes.get(i + 1).is_none_or(|b| {
                    b.is_ascii_whitespace()
                        || depth > 0 && matches!(b, b',' | b'[' | b']' | b'{' | b'}')
                }) =>
            {
                i += 1;
                Kind::Colon
            }
            b'\'' | b'"' if !continuing => {
                let quote = b;
                i += 1;
                let mut closed = false;
                while i < bytes.len() {
                    if quote == b'"' && bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                        continue;
                    }
                    if bytes[i] == quote {
                        if quote == b'\'' && bytes.get(i + 1) == Some(&quote) {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    return Err(failure(ValidationReason::InvalidYaml));
                }
                Kind::Scalar
            }
            b'|' | b'>' if depth == 0 && !continuing => {
                let end_line = i + crate::lines::with_endings(&source[i..])
                    .next()
                    .map_or(0, str::len);
                while i < end_line && !bytes[i].is_ascii_whitespace() && bytes[i] != b'#' {
                    i += 1;
                }
                let marker_end = i;
                let parent_indent = scalar_parent_indent(source, &result);
                let end =
                    scalar_tail_end(source, end_line, &source[start..marker_end], parent_indent);
                result.push(Token {
                    kind: Kind::Scalar,
                    span: span(start, marker_end)?,
                    depth,
                    tail: Some(span(end_line, end)?),
                });
                plain_parent = None;
                i = end;
                continue;
            }
            _ => {
                plain_token = true;
                while i < bytes.len() {
                    let ch = bytes[i];
                    if matches!(ch, b'\n' | b'\r')
                        || (depth > 0 && matches!(ch, b',' | b'[' | b']' | b'{' | b'}'))
                        || ch == b':'
                            && bytes.get(i + 1).is_none_or(|b| {
                                b.is_ascii_whitespace()
                                    || depth > 0 && matches!(b, b',' | b'[' | b']' | b'{' | b'}')
                            })
                        || ch == b'#' && (i == start || bytes[i - 1].is_ascii_whitespace())
                    {
                        break;
                    }
                    i += 1;
                }
                if i == start {
                    return Err(failure(ValidationReason::InvalidYaml));
                }
                Kind::Scalar
            }
        };
        let mut end = i;
        if kind == Kind::Scalar {
            while end > start && bytes[end - 1].is_ascii_whitespace() {
                end -= 1;
            }
        }
        if plain_token && depth == 0 {
            if !continuing {
                plain_parent = Some(scalar_parent_indent(source, &result));
            }
        } else if kind != Kind::Property {
            plain_parent = None;
        }
        flow_plain = depth > 0 && plain_token;
        result.push(Token {
            kind,
            span: span(start, end)?,
            depth: if kind == Kind::Open { depth - 1 } else { depth },
            tail: None,
        });
    }
    if depth != 0 {
        return Err(failure(ValidationReason::InvalidYaml));
    }
    Ok(result)
}

fn cst(source: &str) -> DomainResult<MappingCst> {
    let ts = tokens(source)?;
    if ts.is_empty() {
        return Ok(MappingCst {
            entries: vec![],
            commas: vec![],
            flow_close: None,
            indent: 0,
            has_tokens: false,
        });
    }
    if ts[0].kind == Kind::Property {
        return Err(failure(ValidationReason::FmNotWritable));
    }
    let flow = ts[0].kind == Kind::Open && ts[0].span.slice(source)? == "{";
    let indent = ts
        .iter()
        .filter(|t| t.depth == 0 && t.kind == Kind::Scalar)
        .filter_map(|t| leading(source, t.span.start()))
        .min()
        .unwrap_or(0);
    let level = usize::from(flow);
    let mut starts = Vec::new();
    for (index, pair) in ts.windows(2).enumerate() {
        if pair[0].kind == Kind::Scalar
            && pair[0].depth == level
            && pair[1].kind == Kind::Colon
            && pair[1].depth == level
            && (flow || leading(source, pair[0].span.start()) == Some(indent))
        {
            let raw = pair[0].span.slice(source)?;
            if !flow && (raw.starts_with("- ") || raw.starts_with("? ")) {
                continue;
            }
            let YamlValue::String(key) = yaml::parse(raw)? else {
                return Err(failure(ValidationReason::FmNotWritable));
            };
            starts.push((index, key));
        }
    }
    let commas: Vec<_> = ts
        .iter()
        .filter(|t| flow && t.kind == Kind::Comma && t.depth == level)
        .map(|t| t.span)
        .collect();
    let flow_close = if flow {
        ts.iter()
            .rev()
            .find(|t| t.kind == Kind::Close && t.depth == 0)
            .map(|t| t.span.start())
    } else {
        None
    };
    if flow && flow_close.is_none() {
        return Err(failure(ValidationReason::InvalidYaml));
    }
    let mut entries = Vec::new();
    for (position, (index, key)) in starts.iter().enumerate() {
        let key_token = &ts[*index];
        let colon = &ts[index + 1];
        let stop = starts.get(position + 1).map_or(ts.len(), |(i, _)| *i);
        let value_tokens: Vec<_> = ts[index + 2..stop]
            .iter()
            .take_while(|t| {
                !(flow && t.depth < level) && !(flow && t.kind == Kind::Comma && t.depth == level)
            })
            .collect();
        let value_start = value_tokens
            .first()
            .map_or(colon.span.end(), |t| t.span.start());
        let mut values = Vec::new();
        if let Some(first) = value_tokens.first() {
            let direct_scalar = value_tokens
                .iter()
                .take_while(|t| t.kind == Kind::Property)
                .count();
            if let Some(scalar) = value_tokens.get(direct_scalar).filter(|t| t.tail.is_some()) {
                // Scalar properties and marker comments are authored separately.
                // Replace the first syntax token and erase the remaining nodes,
                // leaving all intervening comment/whitespace trivia untouched.
                values.extend(value_tokens[..=direct_scalar].iter().map(|t| t.span));
                let tail = scalar.tail.expect("block scalar");
                if !tail.is_empty() {
                    values.push(tail);
                }
            } else {
                let last = value_tokens.last().expect("nonempty values");
                let mut end = last.tail.map_or(last.span.end(), ByteSpan::end);
                // The final line break also separates this subtree from the next
                // key or the closing carrier fence. Keep that separator when a
                // collection (or tagged scalar) is replaced with a single token.
                if last.tail.is_some() {
                    end -= crate::lines::ending(&source[..end]).map_or(0, str::len);
                }
                values.push(span(first.span.start(), end)?);
            }
        } else {
            values.push(span(value_start, value_start)?);
        }
        entries.push(Entry {
            key: key.clone(),
            prefix: span(key_token.span.start(), colon.span.end())?,
            values,
            erase: value_tokens
                .iter()
                .flat_map(|token| std::iter::once(token.span).chain(token.tail))
                .collect(),
        });
    }
    Ok(MappingCst {
        entries,
        commas,
        flow_close,
        indent,
        has_tokens: true,
    })
}

pub fn analyze(source: &str, expected: DocClass) -> DomainResult<HeaderAnalysis> {
    crate::unicode::validate_content(source)?;
    let carrier = Carrier::scan(source)?;
    let Some(range) = carrier.yaml else {
        if expected == DocClass::EncryptedNote {
            return Err(failure(ValidationReason::ClassMismatch));
        }
        return Ok(HeaderAnalysis {
            carrier,
            fields: Some(BTreeMap::new()),
            writable: true,
            diagnostic: None,
        });
    };
    let raw = range.slice(source)?;
    let tree = yaml::parse(raw);
    if matches!(&tree, Err(DomainError::ValidationFailed { diagnostic }) if diagnostic.reason == ValidationReason::ForbiddenKey)
    {
        return Err(failure(ValidationReason::ForbiddenKey));
    }
    let fields = match &tree {
        Ok(YamlValue::Mapping(fields)) => Some(fields.clone()),
        Ok(YamlValue::Null) => Some(BTreeMap::new()),
        _ => None,
    };
    if let Some(fields) = &fields {
        check_class(fields.get("class"), expected)?;
    } else {
        // Opaque ordinary headers remain editable in their body only. Class evidence
        // must still be unambiguous, independently of unrelated field diagnostics.
        let class = yaml::class_declaration(raw)?;
        check_class(class.as_ref(), expected)?;
    }
    let writable = fields.is_some();
    let diagnostic = if writable {
        None
    } else {
        Some(match tree.err() {
            Some(DomainError::ValidationFailed { diagnostic }) => diagnostic.reason,
            _ => ValidationReason::FmNotWritable,
        })
    };
    Ok(HeaderAnalysis {
        carrier,
        fields,
        writable,
        diagnostic,
    })
}
fn check_class(value: Option<&YamlValue>, expected: DocClass) -> DomainResult<()> {
    match declared_class(value)? {
        Some(declared) if declared == expected => Ok(()),
        None if expected != DocClass::EncryptedNote => Ok(()),
        _ => Err(failure(ValidationReason::ClassMismatch)),
    }
}

fn declared_class(value: Option<&YamlValue>) -> DomainResult<Option<DocClass>> {
    Ok(Some(match value {
        None => return Ok(None),
        Some(YamlValue::String(name)) => match name.as_str() {
            "user-doc" => DocClass::UserDoc,
            "encrypted-note" => DocClass::EncryptedNote,
            "agent-memory" => DocClass::AgentMemory,
            "skill" => DocClass::Skill,
            "profile" => DocClass::Profile,
            _ => return Err(failure(ValidationReason::ClassMismatch)),
        },
        _ => return Err(failure(ValidationReason::AmbiguousClass)),
    }))
}

fn vault_class(class: DocClass) -> DomainResult<DocClass> {
    match class {
        DocClass::UserDoc | DocClass::EncryptedNote => Ok(class),
        _ => Err(failure(ValidationReason::ClassMismatch)),
    }
}

/// Read the asserted identity of an untrusted file. It carries no authority
/// until an authenticated vault reconciler validates the current binding.
pub fn read_vault_identity(source: &str) -> DomainResult<(DocClass, Option<NoteId>)> {
    crate::unicode::validate_content(source)?;
    let carrier = Carrier::scan(source)?;
    let Some(range) = carrier.yaml else {
        return Ok((DocClass::UserDoc, None));
    };
    let fields = match yaml::parse(range.slice(source)?)? {
        YamlValue::Null => return Ok((DocClass::UserDoc, None)),
        YamlValue::Mapping(fields) => fields,
        _ => return Err(failure(ValidationReason::FmNotWritable)),
    };
    let class = vault_class(declared_class(fields.get("class"))?.unwrap_or(DocClass::UserDoc))?;
    let identity = match fields.get(VAULT_IDENTITY_FIELD) {
        Some(YamlValue::String(value)) => Some(NoteId::parse(value)?),
        Some(_) => return Err(failure(ValidationReason::InvalidId)),
        None => None,
    };
    Ok((class, identity))
}

/// Update the filesystem identity only. All unrelated source bytes are reused.
pub fn patch_vault_identity(
    source: &str,
    class: DocClass,
    note: &NoteId,
) -> DomainResult<CarrierPatchPlan> {
    patch_frontmatter_impl(
        source,
        vault_class(class)?,
        &[FieldEdit::Set {
            key: VAULT_IDENTITY_FIELD.into(),
            value: YamlValue::String(note.as_str().into()),
        }],
        true,
    )
}

/// A bound edit uses the on-disk identity for routing. Restore the dedicated
/// field to its previous canonical value without rewriting other fields.
pub fn restore_vault_identity(
    source: &str,
    canonical: &str,
    class: DocClass,
    note: &NoteId,
) -> DomainResult<String> {
    let class = vault_class(class)?;
    let canonical_header = analyze(canonical, class)?;
    let observed_header = analyze(source, class)?;
    if canonical_header.fields.as_ref().is_some_and(|fields| {
        fields.get(VAULT_IDENTITY_FIELD) != Some(&YamlValue::String(note.as_str().into()))
    }) {
        // Reuse the exact canonical header when the editor kept the projected
        // header, including a header that exists only to carry the disk ID.
        let plan = patch_vault_identity(canonical, class, note)?;
        let projected = patch::apply(canonical, &plan)?;
        let projected_header = Carrier::scan(&projected)?;
        if projected[..projected_header.body.start()]
            == source[..observed_header.carrier.body.start()]
        {
            let mut restored = canonical[..canonical_header.carrier.body.start()].to_owned();
            restored.push_str(observed_header.carrier.body.slice(source)?);
            if class == DocClass::EncryptedNote {
                crate::encrypted::validate(&restored)?;
            }
            return Ok(restored);
        }
    }
    let canonical_fields = canonical_header
        .fields
        .as_ref()
        .ok_or_else(|| failure(ValidationReason::FmNotWritable))?;
    rewrite_vault_identity(
        source,
        class,
        canonical_fields.get(VAULT_IDENTITY_FIELD),
        canonical_header.carrier.header.is_none(),
    )
}

/// The writer receives the claimed identity separately from the imported data.
pub fn strip_vault_identity(source: &str, class: DocClass) -> DomainResult<String> {
    rewrite_vault_identity(source, vault_class(class)?, None, true)
}

fn rewrite_vault_identity(
    source: &str,
    class: DocClass,
    value: Option<&YamlValue>,
    drop_empty_header: bool,
) -> DomainResult<String> {
    let edit = match value {
        Some(value) => FieldEdit::Set {
            key: VAULT_IDENTITY_FIELD.into(),
            value: value.clone(),
        },
        None => FieldEdit::Unset {
            key: VAULT_IDENTITY_FIELD.into(),
        },
    };
    let plan = patch_frontmatter_impl(source, class, &[edit], true)?;
    if plan.edits.is_empty() {
        return Ok(source.to_owned());
    }
    let changed = patch::apply(source, &plan)?;
    if drop_empty_header {
        let carrier = Carrier::scan(&changed)?;
        if let Some(yaml) = carrier.yaml
            && yaml.slice(&changed)?.trim().is_empty()
        {
            let mut headerless = changed[..carrier.bom_end].to_owned();
            headerless.push_str(carrier.body.slice(&changed)?);
            return Ok(headerless);
        }
    }
    Ok(changed)
}

/// Used for frontmatter and closed nota mappings. Returns original-source coordinates.
pub(crate) fn edit_mapping(
    source: &str,
    edits: &[FieldEdit],
    eol: &str,
) -> DomainResult<Vec<(ByteSpan, String)>> {
    let parsed = yaml::parse(source)?;
    let is_null_root = matches!(parsed, YamlValue::Null);
    let mut desired = match parsed {
        YamlValue::Mapping(fields) => fields,
        YamlValue::Null => BTreeMap::new(),
        _ => return Err(failure(ValidationReason::FmNotWritable)),
    };
    let concrete = cst(source)?;
    if is_null_root && concrete.has_tokens {
        return Err(failure(ValidationReason::FmNotWritable));
    }
    let keys: BTreeSet<_> = concrete.entries.iter().map(|e| e.key.clone()).collect();
    if keys.len() != concrete.entries.len() || keys != desired.keys().cloned().collect() {
        return Err(failure(ValidationReason::FmNotWritable));
    }
    let mut seen = BTreeSet::new();
    let entries: BTreeMap<_, _> = concrete
        .entries
        .iter()
        .map(|entry| (entry.key.as_str(), entry))
        .collect();
    let mut result = Vec::new();
    let mut removed = BTreeSet::new();
    let mut insertions = Vec::new();
    for edit in edits {
        if !seen.insert(edit.key()) {
            return Err(failure(ValidationReason::InvalidQuery));
        }
        let entry = entries.get(edit.key()).copied();
        match edit {
            FieldEdit::Set { key, value } => {
                value.validate_keys()?;
                if desired.get(key) == Some(value) {
                    continue;
                }
                desired.insert(key.clone(), value.clone());
                if let Some(entry) = entry {
                    let first = entry.values[0];
                    let mut encoded = yaml::encode(
                        value,
                        Some(first.slice(source)?),
                        concrete.flow_close.is_some(),
                    )?;
                    if first.is_empty()
                        && source.as_bytes().get(first.start().wrapping_sub(1)) == Some(&b':')
                    {
                        encoded.insert(0, ' ');
                    }
                    if concrete.flow_close.is_none()
                        && let Some(indent) = leading(source, first.start())
                        && indent <= concrete.indent
                    {
                        // Block sequences may start at their key's indentation;
                        // the scalar/flow value replacing them may not.
                        encoded.insert_str(0, &" ".repeat(concrete.indent + 2 - indent));
                    }
                    result.push((first, encoded));
                    for tail in &entry.values[1..] {
                        result.push((*tail, String::new()));
                    }
                } else {
                    insertions.push(format!(
                        "{}: {}",
                        yaml::encode(
                            &YamlValue::String(key.clone()),
                            None,
                            concrete.flow_close.is_some()
                        )?,
                        yaml::encode(value, None, concrete.flow_close.is_some())?
                    ));
                }
            }
            FieldEdit::Unset { key } => {
                desired.remove(key);
                if let Some(entry) = entry {
                    removed.insert(key.clone());
                    result.push((entry.prefix, String::new()));
                    for value in &entry.erase {
                        if !value.is_empty() {
                            result.push((*value, String::new()));
                        }
                    }
                }
            }
        }
    }
    if let Some(close) = concrete.flow_close {
        let remaining: Vec<_> = concrete
            .entries
            .iter()
            .filter(|e| !removed.contains(&e.key))
            .collect();
        if !removed.is_empty() {
            let mut commas = concrete.commas.iter().peekable();
            let mut keep_commas = BTreeSet::new();
            for pair in remaining.windows(2) {
                let left = pair[0].values.last().unwrap().end();
                while commas.peek().is_some_and(|c| c.start() < left) {
                    commas.next();
                }
                if let Some(comma) = commas.peek()
                    && comma.start() < pair[1].prefix.start()
                {
                    keep_commas.insert(comma.start());
                }
            }
            for comma in &concrete.commas {
                if !keep_commas.contains(&comma.start()) {
                    result.push((*comma, String::new()));
                }
            }
        }
        if !insertions.is_empty() {
            result.push((
                span(close, close)?,
                format!(
                    "{}{}",
                    if remaining.is_empty() {
                        ""
                    } else if removed.is_empty()
                        && concrete
                            .commas
                            .last()
                            .is_some_and(|c| c.start()
                                >= remaining.last().unwrap().values.last().unwrap().end())
                    {
                        " "
                    } else {
                        ", "
                    },
                    insertions.join(", ")
                ),
            ));
        }
    } else if !insertions.is_empty() {
        let mut text = String::new();
        if !source.is_empty() && !source.ends_with(['\r', '\n']) {
            text.push_str(eol);
        }
        for insertion in insertions {
            text.push_str(&" ".repeat(concrete.indent));
            text.push_str(&insertion);
            text.push_str(eol);
        }
        result.push((span(source.len(), source.len())?, text));
    }
    result.sort_by_key(|(span, _)| (span.start(), span.end()));
    // Independent field intents can share a concrete boundary: an absent value
    // precedes a newly inserted key or a comma removed with its next entry.
    // Compose only producer-owned, non-overlapping splices; the public patch
    // validator continues to reject ambiguous coordinates.
    let mut composed: Vec<(ByteSpan, String)> = Vec::with_capacity(result.len());
    for (bytes, text) in result {
        if let Some((previous, replacement)) = composed.last_mut()
            && previous.end() == bytes.start()
        {
            *previous = span(previous.start(), bytes.end())?;
            replacement.push_str(&text);
        } else {
            composed.push((bytes, text));
        }
    }
    let result = composed;
    let test_plan = patch::plan(
        source,
        span(0, source.len())?,
        result
            .iter()
            .map(|(s, v)| (CarrierEditOrigin::Body, *s, v.clone()))
            .collect(),
    )?;
    let changed = patch::apply(source, &test_plan)?;
    let actual = yaml::parse(&changed)?;
    let actual = if actual == YamlValue::Null {
        YamlValue::Mapping(BTreeMap::new())
    } else {
        actual
    };
    if actual != YamlValue::Mapping(desired) {
        return Err(failure(ValidationReason::FmNotWritable));
    }
    Ok(result)
}

pub fn patch_frontmatter(
    source: &str,
    expected: DocClass,
    edits: &[FieldEdit],
) -> DomainResult<CarrierPatchPlan> {
    patch_frontmatter_impl(source, expected, edits, false)
}

fn patch_frontmatter_impl(
    source: &str,
    expected: DocClass,
    edits: &[FieldEdit],
    vault_identity: bool,
) -> DomainResult<CarrierPatchPlan> {
    if expected == DocClass::EncryptedNote {
        crate::encrypted::validate(source)?;
    }
    let analysis = analyze(source, expected)?;
    if !analysis.writable {
        return Err(failure(ValidationReason::FmNotWritable));
    }
    for edit in edits {
        if !vault_identity || edit.key() != VAULT_IDENTITY_FIELD {
            authorize_field_key(edit.key())?;
        }
    }
    let carrier = analysis.carrier;
    let splices = if let Some(range) = carrier.yaml {
        edit_mapping(range.slice(source)?, edits, carrier.eol)?
            .into_iter()
            .map(|(s, v)| {
                Ok((
                    CarrierEditOrigin::Header,
                    span(range.start() + s.start(), range.start() + s.end())?,
                    v,
                ))
            })
            .collect::<DomainResult<Vec<_>>>()?
    } else {
        let body = edit_mapping("", edits, carrier.eol)?;
        if body.is_empty() {
            vec![]
        } else {
            let inserted = body.into_iter().map(|(_, v)| v).collect::<String>();
            vec![(
                CarrierEditOrigin::Header,
                span(carrier.bom_end, carrier.bom_end)?,
                format!("---{}{inserted}---{}", carrier.eol, carrier.eol),
            )]
        }
    };
    let plan = patch::plan(source, carrier.body, splices)?;
    let changed = patch::apply(source, &plan)?;
    let after = analyze(&changed, expected)?;
    if !after.writable || after.carrier.body.slice(&changed)? != carrier.body.slice(source)? {
        return Err(failure(ValidationReason::FmNotWritable));
    }
    if expected == DocClass::EncryptedNote {
        crate::encrypted::validate(&changed)?;
    }
    Ok(plan)
}
pub fn set_field(
    source: &str,
    expected: DocClass,
    key: &str,
    value: YamlValue,
) -> DomainResult<CarrierPatchPlan> {
    patch_frontmatter(
        source,
        expected,
        &[FieldEdit::Set {
            key: key.into(),
            value,
        }],
    )
}
pub fn unset_field(source: &str, expected: DocClass, key: &str) -> DomainResult<CarrierPatchPlan> {
    patch_frontmatter(source, expected, &[FieldEdit::Unset { key: key.into() }])
}

#[cfg(test)]
mod root_writeability_tests {
    use super::*;

    #[test]
    fn explicit_null_tilde_and_tagged_roots_are_not_writable() {
        for opaque in [
            "---\nnull\n---\nbody\n",
            "---\n~\n---\nbody\n",
            "---\n!!map {}\n---\nbody\n",
            "---\n!!map\nstatus: todo\n---\nbody\n",
        ] {
            let err = patch_frontmatter(
                opaque,
                DocClass::UserDoc,
                &[FieldEdit::Set {
                    key: "status".into(),
                    value: YamlValue::String("done".into()),
                }],
            )
            .unwrap_err();
            assert_eq!(
                err,
                DomainError::validation(ValidationReason::FmNotWritable),
                "expected FmNotWritable for {opaque:?}"
            );
            assert_eq!(
                patch_frontmatter(opaque, DocClass::UserDoc, &[]).unwrap_err(),
                DomainError::validation(ValidationReason::FmNotWritable),
                "empty edit probe must also reject {opaque:?}"
            );
        }
        for writable in [
            "---\n# comment only\n---\nbody\n",
            "---\n{}\n---\nbody\n",
            "---\n---\nbody\n",
        ] {
            assert!(
                patch_frontmatter(
                    writable,
                    DocClass::UserDoc,
                    &[FieldEdit::Set {
                        key: "status".into(),
                        value: YamlValue::String("done".into()),
                    }],
                )
                .is_ok(),
                "expected writable header for {writable:?}"
            );
        }
    }
}
