use super::super::{corpus, invalid};
use notarium_core::{
    error::{PortError, ValidationReason},
    query::{FieldFilterAstV1, FieldSchema, FieldType, Predicate, ScalarType},
    value::{Date, ExactNumber, ScalarValue, Timestamp},
};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Default, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Filters {
    pub field: Vec<String>,
    pub field_day: Vec<String>,
    pub field_any: Vec<String>,
    pub field_bad: Vec<String>,
}

impl Filters {
    pub(super) fn is_empty(&self) -> bool {
        self.field.is_empty()
            && self.field_day.is_empty()
            && self.field_any.is_empty()
            && self.field_bad.is_empty()
    }

    pub(super) fn compile(
        &self,
        schema: &BTreeMap<String, FieldSchema>,
    ) -> Result<FieldFilterAstV1, PortError> {
        let mut groups = BTreeMap::<String, Vec<Predicate>>::new();
        let input = [
            (self.field.as_slice(), Condition::Compare),
            (self.field_day.as_slice(), Condition::Day),
            (self.field_any.as_slice(), Condition::Present),
            (self.field_bad.as_slice(), Condition::Bad),
        ];
        for (values, condition) in input {
            for value in values {
                let (key, predicate) = condition.parse(value, schema)?;
                let group = groups.entry(key.to_owned()).or_default();
                if !group.contains(&predicate) {
                    group.push(predicate);
                }
            }
        }
        let filter = FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(groups.into_values().map(Predicate::Any).collect()),
        };
        filter.validate(schema)?;
        Ok(filter)
    }
}

pub(super) fn unrestricted() -> FieldFilterAstV1 {
    FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::All(Vec::new()),
    }
}

#[derive(Clone, Copy)]
enum Condition {
    Compare,
    Day,
    Present,
    Bad,
}

impl Condition {
    fn parse<'a>(
        self,
        input: &'a str,
        schema: &BTreeMap<String, FieldSchema>,
    ) -> Result<(&'a str, Predicate), PortError> {
        let bad = || invalid(ValidationReason::InvalidQuery);
        let address = input.strip_prefix("note.").ok_or_else(bad)?;
        let (key, raw) = match self {
            Self::Compare | Self::Day => address.split_once(':').ok_or_else(bad)?,
            Self::Present | Self::Bad => (address, ""),
        };
        if key.is_empty()
            || key
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '<' | '>' | ':'))
        {
            return Err(bad());
        }
        corpus::validate_field_key(key)?;
        let field = schema.get(key).ok_or_else(bad)?;
        let owned = key.to_owned();
        let predicate = match self {
            Self::Present => Predicate::Exists { key: owned },
            Self::Bad => Predicate::IsBad { key: owned },
            Self::Day if field.kind == FieldType::Scalar(ScalarType::Date) => Predicate::Eq {
                key: owned,
                value: ScalarValue::Date(Date::parse(raw)?),
            },
            Self::Day => return Err(bad()),
            Self::Compare => match field.kind {
                FieldType::Scalar(kind) => Predicate::Eq {
                    key: owned,
                    value: if field.nullable && kind != ScalarType::String && raw == "null" {
                        ScalarValue::Null
                    } else {
                        scalar(kind, raw)?
                    },
                },
                FieldType::List(kind) => Predicate::Contains {
                    key: owned,
                    value: scalar(kind, raw)?,
                },
                FieldType::Map => return Err(bad()),
            },
        };
        Ok((key, predicate))
    }
}

fn scalar(kind: ScalarType, value: &str) -> Result<ScalarValue, PortError> {
    let invalid_value = |_| invalid(ValidationReason::InvalidQuery);
    Ok(match kind {
        ScalarType::String => ScalarValue::String(value.to_owned()),
        ScalarType::Bool => ScalarValue::Bool(value.parse().map_err(invalid_value)?),
        ScalarType::Number => ScalarValue::Number(ExactNumber::new(
            value
                .parse::<serde_json::Number>()
                .map_err(|_| invalid(ValidationReason::InvalidNumber))?,
        )),
        ScalarType::Date => ScalarValue::Date(Date::parse(value)?),
        ScalarType::Timestamp => ScalarValue::Timestamp(Timestamp::parse(value)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::query::{FieldObservation, FieldValue};

    #[test]
    fn repeated_typed_conditions_group_by_key_and_preserve_exact_numbers() {
        let schema = BTreeMap::from([
            (
                "effort".to_owned(),
                FieldSchema {
                    kind: FieldType::Scalar(ScalarType::Number),
                    nullable: false,
                },
            ),
            (
                "estimateDays".to_owned(),
                FieldSchema {
                    kind: FieldType::List(ScalarType::Date),
                    nullable: false,
                },
            ),
        ]);
        let filters = Filters {
            field: vec![
                "note.effort:9007199254740993".into(),
                "note.estimateDays:2026-02-03".into(),
            ],
            field_any: vec!["note.estimateDays".into()],
            ..Default::default()
        };
        let filter = filters.compile(&schema).unwrap();
        let mut fields = BTreeMap::from([
            (
                "effort".into(),
                FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Number(
                    9007199254740993_u64.into(),
                ))),
            ),
            (
                "estimateDays".into(),
                FieldObservation::Ok(FieldValue::List(Vec::new())),
            ),
        ]);
        assert!(filter.matches(&fields, &schema).unwrap());
        fields.insert(
            "effort".into(),
            FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Number(
                9007199254740992_u64.into(),
            ))),
        );
        assert!(!filter.matches(&fields, &schema).unwrap());

        assert!(
            Filters {
                field_day: vec!["note.estimateDays:2026-02-03".into()],
                ..Default::default()
            }
            .compile(&schema)
            .is_err()
        );
    }
}
