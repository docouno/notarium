use notarium_core::{
    ids::EpisodeId,
    ports::{AgentOperation, ProviderToolDefinition, ProviderToolSchema},
};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::invalid;
use notarium_core::error::{PortError, ValidationReason};

macro_rules! tools {
    ($($variant:ident ($name:literal, $description:literal, $operation:ident, $write:expr)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub(super) enum ToolName { $($variant),+ }

        impl ToolName {
            pub(super) const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub(super) fn parse(name: &str) -> Option<Self> {
                match name {
                    $($name => Some(Self::$variant),)+
                    _ => None,
                }
            }
            pub(super) const fn name(self) -> &'static str {
                match self { $(Self::$variant => $name),+ }
            }
            const fn description(self) -> &'static str {
                match self { $(Self::$variant => $description),+ }
            }
            pub(super) const fn operation(self) -> AgentOperation {
                match self { $(Self::$variant => AgentOperation::$operation),+ }
            }
            pub(super) const fn writes(self) -> bool {
                match self { $(Self::$variant => $write),+ }
            }
        }
    };
}

tools! {
    StartSession("start_session", "Start or resume an episode and read its workspace delta.", Context, false),
    ListAbilities("list_abilities", "List visible roles and skills.", Ability, false),
    UseRole("use_role", "Activate a role and load its instructions and skills.", Ability, false),
    UseSkill("use_skill", "Load instructions from an effective skill.", Ability, false),
    Whoami("whoami", "Inspect your current workspace access.", Context, false),
    GetMyProjects("get_my_projects", "List the projects you can access.", List, false),
    ListNotes("list_notes", "List notes and folders at a workspace path.", List, false),
    RecentActivity("recent_activity", "Read recent visible changes.", List, false),
    Search("search", "Search visible notes.", Search, false),
    GetNote("get_note", "Read a note and its current revision.", Read, false),
    Recall("recall", "Collect related note context within a token budget.", Search, false),
    GetAbility("get_ability", "Read a visible role or skill package.", Ability, false),
    CreateAbility("create_ability", "Publish a new role or skill.", Ability, true),
    EditAbility("edit_ability", "Update an owned role or skill.", Ability, true),
    DeleteAbility("delete_ability", "Trash an owned role or skill.", Ability, true),
    CreateNote("create_note", "Create one Markdown note.", Mutation, true),
    CreateNotes("create_notes", "Create a batch of Markdown notes and resolve links between them.", Mutation, true),
    EditNote("edit_note", "Edit a note or one of its views.", Mutation, true),
    RememberAboutUser("remember_about_user", "Append an observation to your personal memory.", Memory, true),
    RememberAboutProject("remember_about_project", "Append an observation to project memory.", Memory, true),
    Link("link", "Add one typed note link.", Mutation, true),
    LinkMany("link_many", "Add a batch of typed note links.", Mutation, true),
    DeleteNote("delete_note", "Move a note to the trash.", Mutation, true),
    MoveNote("move_note", "Move a note to another folder in its Space.", Mutation, true),
    RenameNote("rename_note", "Change the title of a note.", Mutation, true),
    MoveFolder("move_folder", "Move a folder within its Space.", Mutation, true),
    RenameFolder("rename_folder", "Rename a workspace folder.", Mutation, true),
    RenameProject("rename_project", "Rename a project and update its handle.", Mutation, true),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub annotations: ToolAnnotations,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    pub open_world_hint: bool,
    pub read_only_hint: bool,
}

impl ToolName {
    pub(super) fn descriptor(self) -> ToolDescriptor {
        let mut input_schema = self.input().json_schema();
        input_schema["$schema"] = json!("https://json-schema.org/draft/2020-12/schema");
        ToolDescriptor {
            name: self.name(),
            description: self.description(),
            input_schema,
            annotations: ToolAnnotations {
                open_world_hint: false,
                read_only_hint: !self.writes(),
            },
        }
    }

    pub(super) fn provider_definition(self) -> ProviderToolDefinition {
        ProviderToolDefinition {
            name: self.name().into(),
            description: self.description().into(),
            parameters: self.input().provider_schema(),
        }
    }

    pub(super) fn validate(self, args: &mut Value) -> Result<(), PortError> {
        if self.input().validate(args) {
            Ok(())
        } else {
            Err(invalid(ValidationReason::InvalidQuery))
        }
    }

    pub(super) const fn ability_write(self) -> bool {
        matches!(
            self,
            Self::CreateAbility | Self::EditAbility | Self::DeleteAbility
        )
    }

    fn input(self) -> Input {
        use ToolName::*;

        let fields = match self {
            Whoami | GetMyProjects => vec![],
            StartSession => {
                return object(vec![
                    opt("project", key()),
                    opt("role", key()),
                    opt("task", string(0, 4096)),
                    opt(
                        "session",
                        object(vec![opt("id", Input::Episode), opt("name", string(1, 128))]),
                    ),
                    opt("continuation", cursor()),
                    opt("deliveryReceipt", cursor()),
                    opt("acknowledge", Input::Boolean),
                    opt("responseFormat", response_format()),
                ]);
            }
            ListAbilities => vec![
                req("view", choice(&["runtime", "authoring"])),
                opt("kind", ability_kind()),
                opt("source", choice(&["system", "owned"])),
                opt("project", key()),
                opt("q", string(1, 256)),
                opt("cursor", cursor()),
                opt("limit", integer(1, 50)),
            ],
            UseRole | UseSkill => vec![
                opt(if self == UseRole { "role" } else { "skill" }, key()),
                opt("name", key()),
                opt("project", key()),
                opt("budgetTokens", integer(100, 16000)),
            ],
            GetAbility | DeleteAbility | DeleteNote => vec![req("ref", key())],
            CreateAbility => vec![
                req("kind", ability_kind()),
                req("name", string(1, 128)),
                req("description", string(1, 4096)),
                req("instructions", string(1, 262_144)),
                req(
                    "placement",
                    any_of(vec![
                        object(vec![req("home", choice(&["personal"]))]),
                        object(vec![req("home", choice(&["space"])), req("space", key())]),
                        object(vec![
                            req("home", choice(&["project"])),
                            req("project", key()),
                        ]),
                    ]),
                ),
                opt("attachments", attachments()),
                opt("availability", availability()),
                opt("idempotencyKey", key()),
            ],
            EditAbility => vec![
                req("ref", key()),
                opt("versionToken", cursor()),
                opt("description", string(1, 4096)),
                opt("instructions", string(1, 262_144)),
                opt("attachments", attachments()),
                opt("availability", availability()),
                opt("enabled", Input::Boolean),
                opt("home", object(vec![req("home", choice(&["space"]))])),
            ],
            ListNotes => vec![
                opt("project", key()),
                opt("path", path()),
                opt("tag", key()),
                opt("field", array(key(), 0, 64)),
                opt("fieldDay", array(key(), 0, 64)),
                opt("fieldAny", array(key(), 0, 64)),
                opt("fieldBad", array(key(), 0, 64)),
                opt("cursor", cursor()),
                opt("limit", integer(1, 100)),
            ],
            GetNote => vec![req("ref", key()), opt("responseFormat", response_format())],
            RecentActivity => vec![opt("project", key()), opt("limit", integer(1, 100))],
            Search => vec![
                req("query", string(1, 8192)),
                opt("project", key()),
                opt("class", key()),
                opt("responseFormat", response_format()),
                opt("limit", integer(1, 100)),
            ],
            Recall => vec![
                req("query", string(1, 8192)),
                opt("project", key()),
                opt("budgetTokens", integer(200, 32000)),
                opt("depth", integer(0, 3)),
                opt("maxPerSource", integer(1, 200)),
            ],
            CreateNote => {
                let mut fields = note_input();
                fields.extend([
                    req("project", key()),
                    opt("folderPage", Input::True),
                    opt("versionToken", cursor()),
                ]);
                fields
            }
            CreateNotes => vec![
                req("project", key()),
                req("notes", array(object(note_input()), 1, 50)),
            ],
            EditNote => vec![
                req("ref", key()),
                opt(
                    "operation",
                    choice(&[
                        "append",
                        "prepend",
                        "replace",
                        "replaceSection",
                        "findReplace",
                    ]),
                ),
                opt("content", content()),
                opt("section", key()),
                opt("find", string(1, 65_536)),
                opt(
                    "fields",
                    map(any_of(vec![
                        content(),
                        array(content(), 0, 256),
                        Input::Null,
                    ])),
                ),
                opt(
                    "view",
                    object(vec![
                        req("viewRef", key()),
                        opt("source", view_patch()),
                        opt("common", view_patch()),
                        opt("options", view_patch()),
                    ]),
                ),
                opt("versionToken", cursor()),
                opt("idempotencyKey", key()),
            ],
            RememberAboutUser | RememberAboutProject => {
                let mut fields = vec![
                    req("observation", string(1, 262_144)),
                    opt("category", string(1, 64)),
                    opt("summary", string(0, 262_144)),
                    opt("versionToken", cursor()),
                    opt("idempotencyKey", key()),
                ];
                if self == RememberAboutProject {
                    fields.push(req("project", key()));
                }
                fields
            }
            MoveNote => vec![req("ref", key()), req("toFolder", path())],
            RenameNote => vec![req("ref", key()), req("title", key())],
            MoveFolder => vec![
                req("folder", key()),
                req("toFolder", path()),
                opt("project", key()),
            ],
            RenameFolder => vec![
                req("folder", key()),
                req("name", key()),
                opt("project", key()),
            ],
            RenameProject => vec![
                req("project", key()),
                req("slug", key()),
                opt("displayName", key()),
            ],
            Link => link_tool_fields(),
            LinkMany => vec![req("links", array(object(link_tool_fields()), 1, 100))],
        };
        let mut fields = fields;
        fields.push(opt("session", Input::Episode));
        object(fields)
    }
}

enum Input {
    Text {
        min: usize,
        max: usize,
    },
    Episode,
    Choice(&'static [&'static str]),
    Integer {
        min: i64,
        max: i64,
    },
    Number,
    Boolean,
    True,
    Null,
    Array {
        item: Box<Input>,
        min: usize,
        max: usize,
    },
    Object(Vec<Field>),
    Map(Box<Input>),
    AnyOf(Vec<Input>),
}

struct Field {
    name: &'static str,
    input: Input,
    required: bool,
}

impl Input {
    fn validate(&self, value: &mut Value) -> bool {
        match self {
            Self::Text { min, max } => value.as_str().is_some_and(|text| {
                // Bound UTF-8 accounting before scanning multibyte strings.
                text.len() <= max.saturating_mul(4) && (*min..=*max).contains(&text.chars().count())
            }),
            Self::Episode => value
                .as_str()
                .is_some_and(|id| EpisodeId::parse(id).is_ok()),
            Self::Choice(choices) => value.as_str().is_some_and(|text| choices.contains(&text)),
            Self::Integer { min, max } => {
                let Some(number) = value.as_i64().or_else(|| {
                    value.as_f64().and_then(|n| {
                        (n.fract() == 0.0 && n >= *min as f64 && n <= *max as f64)
                            .then_some(n as i64)
                    })
                }) else {
                    return false;
                };
                if !(*min..=*max).contains(&number) {
                    return false;
                }
                *value = Value::from(number);
                true
            }
            Self::Number => value.is_number(),
            Self::Boolean => value.is_boolean(),
            Self::True => value.as_bool() == Some(true),
            Self::Null => value.is_null(),
            Self::Array { item, min, max } => value.as_array_mut().is_some_and(|items| {
                (*min..=*max).contains(&items.len())
                    && items.iter_mut().all(|value| item.validate(value))
            }),
            Self::Object(fields) => value.as_object_mut().is_some_and(|object| {
                if object.len() > fields.len()
                    || !object
                        .keys()
                        .all(|name| fields.iter().any(|field| field.name == name))
                {
                    return false;
                }
                fields.iter().all(|field| match object.get_mut(field.name) {
                    Some(value) => field.input.validate(value),
                    None => !field.required,
                })
            }),
            Self::Map(rule) => value.as_object_mut().is_some_and(|object| {
                object.len() <= 128 && object.values_mut().all(|value| rule.validate(value))
            }),
            Self::AnyOf(choices) => choices.iter().any(|input| {
                let mut candidate = value.clone();
                if input.validate(&mut candidate) {
                    *value = candidate;
                    true
                } else {
                    false
                }
            }),
        }
    }

    fn json_schema(&self) -> Value {
        match self {
            Self::Text { min, max } => json!({"type":"string","minLength":min,"maxLength":max}),
            Self::Episode => json!({
                "type":"string",
                "pattern":"^(ses_[0-9a-f]{32}|ses_[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{12}|[0-9a-fA-F]{16})$"
            }),
            Self::Choice(values) => json!({"type":"string","enum":values}),
            Self::Integer { min, max } => json!({"type":"integer","minimum":min,"maximum":max}),
            Self::Number => json!({"type":"number"}),
            Self::Boolean => json!({"type":"boolean"}),
            Self::True => json!({"type":"boolean","const":true}),
            Self::Null => json!({"type":"null"}),
            Self::Array { item, min, max } => {
                json!({"type":"array","items":item.json_schema(),"minItems":min,"maxItems":max})
            }
            Self::Object(fields) => {
                let properties: Map<_, _> = fields
                    .iter()
                    .map(|field| (field.name.to_owned(), field.input.json_schema()))
                    .collect();
                let required: Vec<_> = fields
                    .iter()
                    .filter(|field| field.required)
                    .map(|field| field.name)
                    .collect();
                json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
            }
            Self::Map(rule) => {
                json!({"type":"object","additionalProperties":rule.json_schema(),"maxProperties":128})
            }
            Self::AnyOf(choices) => {
                json!({"anyOf":choices.iter().map(Self::json_schema).collect::<Vec<_>>()})
            }
        }
    }

    fn provider_schema(&self) -> ProviderToolSchema {
        match self {
            Self::Text { .. } | Self::Episode => ProviderToolSchema::String { choices: vec![] },
            Self::Choice(values) => ProviderToolSchema::String {
                choices: values.iter().map(|value| (*value).to_owned()).collect(),
            },
            Self::Integer { .. } => ProviderToolSchema::Integer,
            Self::Number => ProviderToolSchema::Number,
            Self::Boolean | Self::True => ProviderToolSchema::Boolean,
            Self::Null => ProviderToolSchema::Null,
            Self::Array { item, max, .. } => ProviderToolSchema::Array {
                items: Box::new(item.provider_schema()),
                maximum: *max as u32,
            },
            Self::Object(fields) => ProviderToolSchema::Object {
                properties: fields
                    .iter()
                    .map(|field| (field.name.to_owned(), field.input.provider_schema()))
                    .collect(),
                required: fields
                    .iter()
                    .filter(|field| field.required)
                    .map(|field| field.name.to_owned())
                    .collect(),
            },
            Self::Map(rule) => ProviderToolSchema::Map {
                values: Box::new(rule.provider_schema()),
            },
            Self::AnyOf(choices) => {
                ProviderToolSchema::AnyOf(choices.iter().map(Self::provider_schema).collect())
            }
        }
    }
}

fn req(name: &'static str, input: Input) -> Field {
    Field {
        name,
        input,
        required: true,
    }
}
fn opt(name: &'static str, input: Input) -> Field {
    Field {
        name,
        input,
        required: false,
    }
}
fn object(fields: Vec<Field>) -> Input {
    Input::Object(fields)
}
fn map(rule: Input) -> Input {
    Input::Map(Box::new(rule))
}
fn any_of(choices: Vec<Input>) -> Input {
    Input::AnyOf(choices)
}
fn array(item: Input, min: usize, max: usize) -> Input {
    Input::Array {
        item: Box::new(item),
        min,
        max,
    }
}
fn choice(values: &'static [&'static str]) -> Input {
    Input::Choice(values)
}
fn string(min: usize, max: usize) -> Input {
    Input::Text { min, max }
}
fn integer(min: i64, max: i64) -> Input {
    Input::Integer { min, max }
}
fn key() -> Input {
    string(1, 1024)
}
fn path() -> Input {
    string(0, 4096)
}
fn cursor() -> Input {
    string(1, 4096)
}
fn content() -> Input {
    string(0, 524_288)
}
fn ability_kind() -> Input {
    choice(&["role", "skill"])
}
fn response_format() -> Input {
    choice(&["concise", "detailed"])
}
fn attachments() -> Input {
    array(object(vec![req("ref", key()), opt("label", key())]), 0, 16)
}
fn availability() -> Input {
    any_of(vec![
        object(vec![req("mode", choice(&["all-projects"]))]),
        object(vec![
            req("mode", choice(&["selected-projects"])),
            req("projects", array(key(), 1, 128)),
        ]),
    ])
}
fn link_fields() -> Vec<Field> {
    vec![
        req("relation", key()),
        opt("to", key()),
        opt("toTitle", key()),
    ]
}
fn link_tool_fields() -> Vec<Field> {
    let mut fields = link_fields();
    fields.push(req("from", key()));
    fields
}
fn note_input() -> Vec<Field> {
    vec![
        req("body", content()),
        opt("title", key()),
        opt("path", path()),
        opt("type", key()),
        opt("tags", array(key(), 0, 128)),
        opt("links", array(object(link_fields()), 0, 100)),
        opt("createdAt", any_of(vec![string(1, 128), Input::Null])),
        opt("fileName", key()),
        opt("idempotencyKey", key()),
    ]
}
fn view_scalar() -> Input {
    any_of(vec![content(), Input::Number, Input::Boolean, Input::Null])
}
fn view_patch() -> Input {
    let item = any_of(vec![view_scalar(), map(view_scalar())]);
    let value = any_of(vec![view_scalar(), map(view_scalar()), array(item, 0, 256)]);
    object(vec![
        opt("set", map(value)),
        opt("remove", array(key(), 0, 128)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_carries_exact_closed_world_descriptors() {
        let names: std::collections::BTreeSet<_> =
            ToolName::ALL.iter().map(|tool| tool.name()).collect();
        assert_eq!(names.len(), 28);
        assert_eq!(
            ToolName::ALL.iter().filter(|tool| !tool.writes()).count(),
            12
        );
        for &tool in ToolName::ALL {
            assert_eq!(ToolName::parse(tool.name()), Some(tool));
            let descriptor = tool.descriptor();
            assert!(!descriptor.annotations.open_world_hint);
            assert_eq!(descriptor.input_schema["additionalProperties"], false);
        }
    }

    #[test]
    fn names_and_structures_keep_legacy_identity_and_reject_other_fields() {
        let mut args = json!({"ref":"ABCDEF012345", "title":"New", "session":"ses_A0b1C2d3E4_-"});
        ToolName::RenameNote.validate(&mut args).unwrap();
        args["fileName"] = json!("new");
        assert!(ToolName::RenameNote.validate(&mut args).is_err());
        assert!(
            ToolName::GetAbility
                .validate(&mut json!({"ref":"ab12","session":"ses_A0b1C2d3E4_+"}))
                .is_err()
        );
        assert!(
            ToolName::CreateNote
                .validate(&mut json!({"project":"a/b","body":"","folderPage":false}))
                .is_err()
        );
        ToolName::EditNote
            .validate(&mut json!({
                "ref":"abc", "fields":{"tag":["a", "b"], "owner":null},
                "view":{"viewRef":"v_old","options":{"set":{"enabled":true}}}
            }))
            .unwrap();
    }
}
