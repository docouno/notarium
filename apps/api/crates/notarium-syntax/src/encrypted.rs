//! Structural age validation over in-memory slices; never decrypts production content.
use crate::{content_digest, frontmatter, markdown};
use notarium_core::{
    DomainError, DomainResult, classes::DocClass, error::ValidationReason, ids::ContentDigest,
    span::ByteSpan,
};
use std::io::Read;

#[derive(Clone, Debug)]
pub struct EncryptedCarrierValidated {
    pub source: ContentDigest,
    pub carrier: ByteSpan,
    pub title: Option<ByteSpan>,
}
fn invalid() -> DomainError {
    DomainError::validation(ValidationReason::InvalidAgeCarrier)
}

pub fn validate(source: &str) -> DomainResult<EncryptedCarrierValidated> {
    let header = frontmatter::analyze(source, DocClass::EncryptedNote)?;
    if !header.writable {
        return Err(invalid());
    }
    let analysis = markdown::analyze(source, header.carrier.body)?;
    let age: Vec<_> = analysis.fences.iter().filter(|f| f.info == "age").collect();
    let mut position = header.carrier.body.start();
    let mut title = None;
    for fence in &age {
        check_outside(
            source,
            ByteSpan::new(position, fence.span.start())?,
            title.is_none() && position == header.carrier.body.start(),
            &mut title,
        )?;
        position = fence.span.end();
    }
    check_outside(
        source,
        ByteSpan::new(position, source.len())?,
        age.is_empty(),
        &mut title,
    )?;
    if age.len() != 1 || !age[0].closed {
        return Err(invalid());
    }
    validate_armor(&age[0].text)?;
    Ok(EncryptedCarrierValidated {
        source: content_digest(source),
        carrier: age[0].span,
        title,
    })
}
fn check_outside(
    source: &str,
    range: ByteSpan,
    allow_title: bool,
    title: &mut Option<ByteSpan>,
) -> DomainResult<()> {
    let mut offset = range.start();
    for line in range.slice(source)?.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        if !text.chars().all(char::is_whitespace) {
            let permitted = allow_title
                && title.is_none()
                && text.starts_with("# ")
                && !text[2..].is_empty()
                && !text[2..].contains(['#', '[', ']', '<', '>', '`', '*', '_', '\\']);
            if !permitted {
                return Err(DomainError::UnsafePlaintextOutsideAgeFence);
            }
            *title = Some(ByteSpan::new(offset, offset + text.len())?);
        }
        offset += line.len();
    }
    Ok(())
}
pub fn validate_armor(armor: &str) -> DomainResult<()> {
    let armor = armor.trim_matches(['\r', '\n']);
    let begin = "-----BEGIN AGE ENCRYPTED FILE-----";
    let end = "-----END AGE ENCRYPTED FILE-----";
    if !armor.is_ascii()
        || !armor.starts_with(begin)
        || !armor.ends_with(end)
        || armor.matches(begin).count() != 1
        || armor.matches(end).count() != 1
    {
        return Err(invalid());
    }
    let mut decoded = Vec::new();
    age::armor::ArmoredReader::new(armor.as_bytes())
        .take(armor.len() as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|_| invalid())?;
    let mut remainder = decoded.as_slice();
    {
        let _header = age::Decryptor::new(&mut remainder).map_err(|_| invalid())?;
    }
    // Header parsing also consumes the nonce. At least one authenticated STREAM
    // chunk remains; authenticity itself requires the recipient's private key.
    let tail = remainder.len() % 65552;
    if remainder.len() < 16 || (tail != 0 && tail < 16) {
        return Err(invalid());
    }
    Ok(())
}
