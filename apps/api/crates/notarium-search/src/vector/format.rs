use notarium_core::classes::DocClass;

pub(super) const HEADER: usize = 256;
pub(super) const FOOTER: usize = 64;
pub(super) const HEADER_MAGIC: &[u8; 8] = b"NCSRSEG1";
pub(super) const FOOTER_MAGIC: &[u8; 8] = b"NCSRFTR1";
pub(super) const VERSION: u32 = 1;
pub(super) const META_BYTES: usize = 80;
pub(super) const BASE_ROW_BYTES: usize = (super::M0 + 1) * 4;
pub(super) const SCALES: usize = 0;
pub(super) const VECTORS: usize = 1;
pub(super) const BASE: usize = 2;
pub(super) const LEVELS: usize = 3;
pub(super) const UPPER_OFFSETS: usize = 4;
pub(super) const UPPER: usize = 5;
pub(super) const METADATA: usize = 6;
pub(super) const NOTES: usize = 7;
pub(super) const SPANS: usize = 8;
pub(super) const SECTION_COUNT: usize = 9;

pub(super) fn class_number(class: DocClass) -> Option<u16> {
    match class {
        DocClass::UserDoc => Some(1),
        DocClass::AgentMemory => Some(2),
        DocClass::Skill => Some(3),
        DocClass::Profile => Some(4),
        DocClass::EncryptedNote => None,
    }
}

pub(super) fn doc_class(value: u16) -> Option<DocClass> {
    match value {
        1 => Some(DocClass::UserDoc),
        2 => Some(DocClass::AgentMemory),
        3 => Some(DocClass::Skill),
        4 => Some(DocClass::Profile),
        _ => None,
    }
}

pub(super) fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("validated field width"),
    )
}
pub(super) fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated field width"),
    )
}
pub(super) fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("validated field width"),
    )
}

pub(super) fn words(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .copied()
        .map(u32::from_le_bytes)
}
