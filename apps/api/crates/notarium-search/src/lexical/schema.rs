use super::analysis::{EXACT, PROSE};
use crate::layout::FolderOrd;
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{DocClass, SearchContent},
    ids::{ChatThreadId, NoteId, ThreadEntrySeq},
    ports::ChatThreadKind,
};
use tantivy::{
    TantivyDocument, Term,
    schema::{
        FAST, Field, INDEXED, IndexRecordOption, STRING, Schema, TextFieldIndexing, TextOptions,
    },
};

pub(super) const NOTE: u64 = 1;
pub(super) const CHAT: u64 = 2;

pub(super) struct Fields {
    pub schema: Schema,
    pub(super) key: Field,
    kind: Field,
    note_id: Field,
    chat_locator: Field,
    chat_owner: Field,
    class: Field,
    folder: Field,
    pub bodies: [TextFields; 4],
}

#[derive(Clone, Copy)]
pub(super) struct TextFields {
    pub prose: Field,
    pub exact: Field,
    pub prose_weight: f32,
    pub exact_weight: f32,
}

fn text_options(tokenizer: &str) -> TextOptions {
    TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(tokenizer)
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    )
}

impl Fields {
    pub fn new() -> Self {
        let mut schema = Schema::builder();
        let key = schema.add_text_field("doc_key", STRING);
        let kind = schema.add_u64_field("doc_kind", FAST | INDEXED);
        let note_id = schema.add_bytes_field("note_id_raw", FAST);
        let chat_locator = schema.add_bytes_field("chat_locator", FAST);
        let chat_owner = schema.add_bytes_field("chat_owner", FAST);
        let class = schema.add_u64_field("doc_class_ord", FAST | INDEXED);
        let folder = schema.add_u64_field("parent_folder_ord", FAST | INDEXED);
        let bodies = [
            ("note_title", 2.0, 2.5),
            ("note_body", 1.0, 1.5),
            ("memory_body", 1.0, 1.5),
            ("chat_body", 0.9, 1.35),
        ]
        .map(|(name, prose_weight, exact_weight)| TextFields {
            prose: schema.add_text_field(&format!("{name}_prose"), text_options(PROSE)),
            exact: schema.add_text_field(&format!("{name}_exact"), text_options(EXACT)),
            prose_weight,
            exact_weight,
        });
        Self {
            schema: schema.build(),
            key,
            kind,
            note_id,
            chat_locator,
            chat_owner,
            class,
            folder,
            bodies,
        }
    }

    pub fn note(
        &self,
        content: &SearchContent,
        title: &str,
        body: &str,
        folder: FolderOrd,
    ) -> TantivyDocument {
        let doc = content.provenance();
        let mut indexed = TantivyDocument::new();
        indexed.add_text(self.key, note_key(&doc.reference().note_id));
        indexed.add_u64(self.kind, NOTE);
        indexed.add_bytes(self.note_id, doc.reference().note_id.as_str().as_bytes());
        indexed.add_u64(self.class, class_ord(doc.class()));
        indexed.add_u64(self.folder, u64::from(folder.get()));
        self.add_text(&mut indexed, self.bodies[0], title);
        let body_field = if doc.class() == DocClass::AgentMemory {
            2
        } else {
            1
        };
        self.add_text(&mut indexed, self.bodies[body_field], body);
        indexed
    }

    pub fn chat(&self, hit: &HydratedChatHit, folder: Option<FolderOrd>) -> TantivyDocument {
        let mut indexed = TantivyDocument::new();
        indexed.add_text(self.key, chat_key(&hit.thread, hit.entry));
        indexed.add_u64(self.kind, CHAT);
        indexed.add_u64(self.class, 0);
        indexed.add_u64(
            self.folder,
            folder.map_or(0, |folder| u64::from(folder.get())),
        );
        indexed.add_bytes(self.chat_locator, &chat_locator(hit));
        if hit.kind == ChatThreadKind::Personal {
            indexed.add_bytes(self.chat_owner, hit.owner.as_str().as_bytes());
        }
        self.add_text(&mut indexed, self.bodies[3], &hit.text);
        indexed
    }

    fn add_text(&self, doc: &mut TantivyDocument, fields: TextFields, text: &str) {
        doc.add_text(fields.prose, text);
        doc.add_text(fields.exact, text);
    }

    pub fn note_term(&self, note: &NoteId) -> Term {
        Term::from_field_text(self.key, &note_key(note))
    }

    pub fn chat_term(&self, thread: &ChatThreadId, entry: ThreadEntrySeq) -> Term {
        Term::from_field_text(self.key, &chat_key(thread, entry))
    }
}

fn note_key(note: &NoteId) -> String {
    format!("n:{note}")
}

fn chat_key(thread: &ChatThreadId, entry: ThreadEntrySeq) -> String {
    format!("c:{thread}:{:016x}", entry.get())
}

pub(super) fn class_ord(class: DocClass) -> u64 {
    match class {
        DocClass::UserDoc => 1,
        DocClass::AgentMemory => 2,
        DocClass::Skill => 3,
        DocClass::Profile => 4,
        DocClass::EncryptedNote => 5,
    }
}

fn chat_locator(hit: &HydratedChatHit) -> Vec<u8> {
    let id = hit.thread.as_str().as_bytes();
    let mut locator = Vec::with_capacity(11 + id.len());
    locator.extend_from_slice(&(id.len() as u16).to_le_bytes());
    locator.extend_from_slice(id);
    locator.extend_from_slice(&hit.entry.get().to_le_bytes());
    locator.push(match hit.kind {
        ChatThreadKind::Personal => 1,
        ChatThreadKind::SpaceGroup => 2,
        ChatThreadKind::KeeperLog => 3,
    });
    locator
}

pub(super) fn decode_chat_locator(
    bytes: &[u8],
) -> Option<(ChatThreadId, ThreadEntrySeq, ChatThreadKind)> {
    let (len, rest) = bytes.split_at_checked(2)?;
    let len = u16::from_le_bytes(len.try_into().ok()?) as usize;
    let (id, rest) = rest.split_at_checked(len)?;
    let (seq, kind) = rest.split_at_checked(8)?;
    let thread = ChatThreadId::parse(std::str::from_utf8(id).ok()?).ok()?;
    let entry = ThreadEntrySeq::new(u64::from_le_bytes(seq.try_into().ok()?)).ok()?;
    let kind = match kind {
        [1] => ChatThreadKind::Personal,
        [2] => ChatThreadKind::SpaceGroup,
        [3] => ChatThreadKind::KeeperLog,
        _ => return None,
    };
    Some((thread, entry, kind))
}
