#![forbid(unsafe_code)]

//! Byte-preserving Markdown/YAML transformations. No filesystem, network or database I/O.
pub mod carrier;
pub mod chunk;
pub mod encrypted;
pub mod extract;
pub mod frontmatter;
mod lines;
pub mod live;
pub mod markdown;
pub mod nota;
pub mod patch;
pub mod unicode;
mod yaml;

use notarium_core::ids::ContentDigest;
pub fn content_digest(source: &str) -> ContentDigest {
    ContentDigest::from_bytes(*blake3::hash(source.as_bytes()).as_bytes())
}
