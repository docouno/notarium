//! Shared inputs for the instrumented guard and durable ACK campaigns.

use notarium_core::ids::ViewKey;
use yrs::{Text, TextRef, TransactionMut};

pub const SIZES_KIB: [usize; 3] = [1, 100, 1024];
pub const WARMUP: usize = 4;
pub const SAMPLES: usize = 24;
pub const CLOSE_FENCE: &str = "```\n";
pub const WRITER: u64 = (1_u64 << 52) + 800;
pub const COMPETING: u64 = WRITER + 100;
pub const HISTORICAL_WRITER: u64 = WRITER + 200;
const HISTORY_PAD: usize = 256;

#[derive(Clone, Copy)]
pub struct History {
    pub label: &'static str,
    pub replacements: usize,
    pub authors: usize,
}

pub const HISTORIES: [History; 3] = [
    History {
        label: "short",
        replacements: 8,
        authors: 1,
    },
    History {
        label: "long_one_author",
        replacements: 256,
        authors: 1,
    },
    History {
        label: "long_many_authors",
        replacements: 256,
        authors: 16,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Shape {
    Prose,
    NearbyNota,
}

impl Shape {
    pub const ALL: [Self; 2] = [Self::Prose, Self::NearbyNota];

    pub fn label(self) -> &'static str {
        match self {
            Self::Prose => "prose",
            Self::NearbyNota => "nearby_nota",
        }
    }
}

pub fn carrier(kib: usize, shape: Shape) -> String {
    let header = "---\nstatus: todo # retained\n---\n";
    let history = format!("\n\nhistory {}", "h".repeat(HISTORY_PAD));
    let mut suffix = String::new();
    if shape == Shape::NearbyNota {
        let id = ViewKey::from_bytes([13; 16]);
        suffix.push_str(&format!("\n\n```nota\nid: {id}\nname: alpha\n```"));
    }
    suffix.push_str(&history);
    if shape == Shape::NearbyNota {
        suffix.push_str("\n\n```nota\nname: pending\n");
    }
    let prose = "p".repeat(kib * 1024 - header.len() - suffix.len());
    format!("{header}{prose}{suffix}")
}

pub fn history_offset(body: &str) -> u32 {
    let offset = body.find("history ").expect("history pad") + "history ".len();
    body[..offset].encode_utf16().count() as u32
}

pub fn build_history(
    text: &TextRef,
    txn: &mut TransactionMut<'_>,
    pad: u32,
    history: History,
    author: usize,
) {
    for cell in (author..history.replacements).step_by(history.authors) {
        let offset = pad + cell as u32;
        // Create separated deleted clocks and live items at distinct physical
        // gaps while preserving the exact visible fixture.
        text.insert(txn, offset, "x");
        text.remove_range(txn, offset, 1);
        text.remove_range(txn, offset, 1);
        text.insert(txn, offset, "h");
    }
}

#[derive(Clone, Copy)]
pub struct Typing {
    pub label: &'static str,
    pub position: u32,
    pub input: &'static str,
    pub ordinary: bool,
}

pub fn typing(body: &str, shape: Shape) -> Vec<Typing> {
    let end = body.find("\n\n").expect("end of prose paragraph") as u32;
    let mut result = vec![
        Typing {
            label: "prose_begin",
            position: 0,
            input: "x",
            ordinary: true,
        },
        Typing {
            label: "prose_middle",
            position: end / 2,
            input: "🚀",
            ordinary: true,
        },
        Typing {
            label: "prose_end",
            position: end,
            input: "x",
            ordinary: true,
        },
    ];
    if shape == Shape::NearbyNota {
        let position = body.find("name: alpha").expect("first note") + "name: a".len();
        result.push(Typing {
            label: "inside_nota",
            position: body[..position].encode_utf16().count() as u32,
            input: "x",
            ordinary: false,
        });
    }
    result
}

pub fn remove_added_suffix(
    text: &TextRef,
    txn: &mut TransactionMut<'_>,
    before: &str,
    after: &str,
) {
    let preserved: usize = before
        .chars()
        .zip(after.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum();
    let index = before[..preserved].encode_utf16().count() as u32;
    let removed = (after[preserved..].encode_utf16().count()) as u32;
    if removed > 0 {
        text.remove_range(txn, index, removed);
    }
    text.insert(txn, index, &before[preserved..]);
}
