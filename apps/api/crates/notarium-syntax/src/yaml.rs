use notarium_core::{
    DomainError, DomainResult,
    error::ValidationReason,
    value::{ExactNumber, YamlValue},
};
use saphyr::{Scalar, ScalarStyle, Yaml, YamlLoader};
use saphyr_parser::{BufferedInput, Event, Parser, Span, SpannedEventReceiver};
use std::collections::BTreeMap;

struct Receiver<'a> {
    loader: YamlLoader<'a, Yaml<'a>>,
    anchors: bool,
    depth: usize,
    too_deep: bool,
}
impl<'a> SpannedEventReceiver<'a> for Receiver<'a> {
    fn on_event(&mut self, event: Event<'a>, span: Span) {
        if self.too_deep {
            return;
        }
        match &event {
            Event::MappingStart(..) | Event::SequenceStart(..) => self.depth += 1,
            Event::MappingEnd | Event::SequenceEnd => self.depth = self.depth.saturating_sub(1),
            _ => {}
        }
        // Stop building the tree before nested allocation/drop can exhaust the
        // stack. A check during conversion alone would leave a deep tree to drop.
        if self.depth > 64 {
            self.too_deep = true;
            return;
        }
        self.anchors |= match &event {
            Event::Alias(_) => true,
            Event::Scalar(_, _, id, _)
            | Event::SequenceStart(id, _)
            | Event::MappingStart(id, _) => *id != 0,
            _ => false,
        };
        self.loader.on_event(event, span);
    }
}
pub fn parse(source: &str) -> DomainResult<YamlValue> {
    if source.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let mut receiver = Receiver {
        loader: YamlLoader::default(),
        anchors: false,
        depth: 0,
        too_deep: false,
    };
    receiver.loader.early_parse(false);
    receiver.loader.alias_limit(0);
    Parser::new(BufferedInput::new(source.chars()))
        .load(&mut receiver, true)
        .map_err(|_| invalid())?;
    if receiver.too_deep {
        return Err(invalid());
    }
    if receiver.anchors {
        return Err(DomainError::validation(ValidationReason::FmNotWritable));
    }
    if receiver.loader.error().is_some() {
        return Err(DomainError::validation(ValidationReason::DuplicateKey));
    }
    let docs = receiver.loader.into_documents();
    if docs.is_empty() {
        return Ok(YamlValue::Null);
    }
    if docs.len() != 1 {
        return Err(invalid());
    }
    convert(&docs[0], 0)
}
fn invalid() -> DomainError {
    DomainError::validation(ValidationReason::InvalidYaml)
}
fn convert(node: &Yaml<'_>, depth: usize) -> DomainResult<YamlValue> {
    if depth > 64 {
        return Err(invalid());
    }
    match node {
        Yaml::Representation(text, style, tag) => {
            if *style == ScalarStyle::Plain && tag.is_none() {
                if let Ok(n) = text.parse::<i64>() {
                    return Ok(YamlValue::Number(n.into()));
                }
                if let Ok(n) = text.parse::<u64>() {
                    return Ok(YamlValue::Number(n.into()));
                }
            }
            let scalar = Scalar::parse_from_cow_and_metadata(text.clone(), *style, tag.as_ref())
                .ok_or_else(invalid)?;
            scalar_value(&scalar)
        }
        Yaml::Value(value) => scalar_value(value),
        Yaml::Sequence(items) => Ok(YamlValue::Sequence(
            items
                .iter()
                .map(|v| convert(v, depth + 1))
                .collect::<DomainResult<_>>()?,
        )),
        Yaml::Mapping(items) => {
            let mut values = BTreeMap::new();
            for (key, value) in items {
                let YamlValue::String(key) = convert(key, depth + 1)? else {
                    return Err(invalid());
                };
                if key == "__proto__" {
                    return Err(DomainError::validation(ValidationReason::ForbiddenKey));
                }
                if values.insert(key, convert(value, depth + 1)?).is_some() {
                    return Err(DomainError::validation(ValidationReason::DuplicateKey));
                }
            }
            Ok(YamlValue::Mapping(values))
        }
        _ => Err(invalid()),
    }
}
fn scalar_value(value: &Scalar<'_>) -> DomainResult<YamlValue> {
    Ok(match value {
        Scalar::Null => YamlValue::Null,
        Scalar::Boolean(v) => YamlValue::Bool(*v),
        Scalar::Integer(v) => YamlValue::Number((*v).into()),
        Scalar::FloatingPoint(v) => YamlValue::Number(ExactNumber::from_f64(v.0)?),
        Scalar::String(v) => YamlValue::String(v.to_string()),
    })
}
pub fn encode(value: &YamlValue, original: Option<&str>) -> DomainResult<String> {
    value.validate_keys()?;
    if let YamlValue::String(text) = value
        && let Some(original) = original
    {
        if original.starts_with('\'') && !text.contains(['\r', '\n']) {
            return Ok(format!("'{}'", text.replace('\'', "''")));
        }
        if !original.starts_with('"')
            && !text.contains(['\r', '\n'])
            && parse(text).as_ref() == Ok(value)
        {
            return Ok(text.clone());
        }
    }
    fn json(value: &YamlValue) -> serde_json::Value {
        match value {
            YamlValue::Null => serde_json::Value::Null,
            YamlValue::Bool(v) => (*v).into(),
            YamlValue::String(v) => v.clone().into(),
            YamlValue::Number(v) => serde_json::Value::Number(v.as_json().clone()),
            YamlValue::Sequence(items) => items.iter().map(json).collect(),
            YamlValue::Mapping(items) => {
                serde_json::Value::Object(items.iter().map(|(k, v)| (k.clone(), json(v))).collect())
            }
        }
    }
    serde_json::to_string(&json(value)).map_err(|_| invalid())
}
