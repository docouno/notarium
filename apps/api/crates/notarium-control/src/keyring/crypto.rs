use crate::error::{invalid, unavailable};
use aes_gcm::{
    Aes256Gcm,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::GenericHkdf;
use hmac::Hmac;
use notarium_core::{
    auth::SecretString,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{CredentialId, KeyId, ProviderResourceId},
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

pub(super) const MAX_PLAINTEXT: usize = 32 * 1024;
pub(super) const MAX_ENVELOPE: usize = 44 * 1024;

/// AAD identity is independent of where an encrypted value is stored.
#[derive(Clone, Debug)]
pub struct EnvelopeAddress {
    facet: String,
    record: String,
    field: String,
}
impl EnvelopeAddress {
    pub fn credential(id: &CredentialId) -> Self {
        Self {
            facet: "credential".into(),
            record: id.to_string(),
            field: "secret".into(),
        }
    }
    pub fn resource_header(id: &ProviderResourceId, header: &str) -> Result<Self, PortError> {
        if header.len() > 256 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let name = reqwest::header::HeaderName::from_bytes(header.as_bytes())
            .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        Ok(Self {
            facet: "resource".into(),
            record: id.to_string(),
            field: name.as_str().into(),
        })
    }
    pub(super) fn canary(id: &KeyId) -> Self {
        Self {
            facet: "keyring".into(),
            record: id.to_string(),
            field: "canary".into(),
        }
    }
    fn aad(&self, key: &KeyId) -> Result<Vec<u8>, PortError> {
        if [&self.facet, &self.record, &self.field]
            .iter()
            .any(|part| part.is_empty() || part.len() > 512 || part.contains('\0'))
        {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        Ok(format!("v1\0{key}\0{}\0{}\0{}", self.facet, self.record, self.field).into_bytes())
    }
}

pub(super) fn failure() -> PortError {
    unavailable("control keyring verification", CommitEffect::NotCommitted)
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub(super) fn file_hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex(&Sha256::digest(bytes)))
}
pub(super) fn canonical_decode(
    encoded: &str,
    maximum: usize,
) -> Result<Zeroizing<Vec<u8>>, PortError> {
    if encoded.len() > maximum {
        return Err(failure());
    }
    let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).map_err(|_| failure())?);
    let canonical = Zeroizing::new(URL_SAFE_NO_PAD.encode(&*decoded));
    if canonical.as_str() != encoded {
        return Err(failure());
    }
    Ok(decoded)
}
pub(super) struct Envelope {
    pub key: KeyId,
    data: Zeroizing<Vec<u8>>,
}
impl Envelope {
    pub fn parse(encoded: &str) -> Result<Self, PortError> {
        if encoded.len() > MAX_ENVELOPE {
            return Err(failure());
        }
        let mut parts = encoded.split('.');
        if parts.next() != Some("v1") {
            return Err(failure());
        }
        let key = KeyId::parse(parts.next().ok_or_else(failure)?).map_err(|_| failure())?;
        let data = canonical_decode(parts.next().ok_or_else(failure)?, MAX_ENVELOPE)?;
        if parts.next().is_some() || data.len() < 28 || data.len() > MAX_PLAINTEXT + 28 {
            return Err(failure());
        }
        Ok(Self { key, data })
    }
}

/// Operation-scoped material; no raw master or persistent decrypt cache.
pub(super) struct Material {
    pub id: KeyId,
    encryption: Zeroizing<[u8; 32]>,
    canary: Zeroizing<String>,
}
impl Material {
    pub fn derive(master: &[u8; 32]) -> Result<Self, PortError> {
        let (mut prk, hkdf) = GenericHkdf::<Hmac<Sha256>>::extract(None, master);
        prk.as_mut_slice().zeroize();
        let mut id = [0; 12];
        hkdf.expand(b"notarium:key-id:v1", &mut id)
            .map_err(|_| failure())?;
        let mut encryption = Zeroizing::new([0; 32]);
        hkdf.expand(b"notarium:secret:credential:v1", &mut *encryption)
            .map_err(|_| failure())?;
        let mut canary = Zeroizing::new([0; 32]);
        hkdf.expand(b"notarium:canary:v1", &mut *canary)
            .map_err(|_| failure())?;
        Ok(Self {
            id: KeyId::parse(&format!("ck_{}", hex(&id))).map_err(|_| failure())?,
            encryption,
            canary: Zeroizing::new(URL_SAFE_NO_PAD.encode(canary.as_slice())),
        })
    }
    pub fn seal(&self, address: &EnvelopeAddress, plaintext: &str) -> Result<String, PortError> {
        let mut nonce = [0; 12];
        getrandom::fill(&mut nonce).map_err(|_| failure())?;
        self.seal_nonce(address, plaintext, nonce)
    }
    fn seal_nonce(
        &self,
        address: &EnvelopeAddress,
        plaintext: &str,
        nonce: [u8; 12],
    ) -> Result<String, PortError> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let cipher = Aes256Gcm::new_from_slice(&*self.encryption).map_err(|_| failure())?;
        let ciphertext = cipher
            .encrypt(
                &nonce.into(),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: &address.aad(&self.id)?,
                },
            )
            .map_err(|_| failure())?;
        let mut packed = Vec::with_capacity(12 + ciphertext.len());
        packed.extend_from_slice(&nonce);
        packed.extend_from_slice(&ciphertext);
        Ok(format!("v1.{}.{}", self.id, URL_SAFE_NO_PAD.encode(packed)))
    }
    pub fn open(
        &self,
        address: &EnvelopeAddress,
        envelope: &Envelope,
    ) -> Result<SecretString, PortError> {
        if envelope.key != self.id {
            return Err(failure());
        }
        let nonce: [u8; 12] = envelope.data[..12].try_into().map_err(|_| failure())?;
        let cipher = Aes256Gcm::new_from_slice(&*self.encryption).map_err(|_| failure())?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    &nonce.into(),
                    Payload {
                        msg: &envelope.data[12..],
                        aad: &address.aad(&self.id)?,
                    },
                )
                .map_err(|_| failure())?,
        );
        let plaintext = std::str::from_utf8(&plaintext).map_err(|_| failure())?;
        Ok(SecretString::new(plaintext.into()))
    }
    pub fn seal_canary(&self) -> Result<String, PortError> {
        self.seal(&EnvelopeAddress::canary(&self.id), &self.canary)
    }
    pub fn check_canary(&self, encrypted: &str) -> Result<(), PortError> {
        let value = self.open(
            &EnvelopeAddress::canary(&self.id),
            &Envelope::parse(encrypted)?,
        )?;
        if value
            .expose()
            .as_bytes()
            .ct_eq(self.canary.as_bytes())
            .unwrap_u8()
            != 1
        {
            return Err(failure());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/keyring/vectors.json")).unwrap()
    }
    fn text<'a>(vectors: &'a serde_json::Value, name: &str) -> &'a str {
        vectors[name].as_str().unwrap()
    }
    #[test]
    fn native_hkdf_aad_and_aes_gcm_match_independent_vectors() {
        // Static expected bytes were generated independently with Python
        // cryptography. The test runner needs only the pinned Rust toolchain.
        let v = vectors();
        let material = Material::derive(&std::array::from_fn(|i| i as u8)).unwrap();
        assert_eq!(material.id.as_str(), text(&v, "keyId"));
        assert_eq!(material.canary.as_str(), text(&v, "canaryPlaintext"));
        assert_eq!(
            file_hash(include_bytes!(
                "../../tests/fixtures/keyring/native/keys/ck_6cec1c7707250abbc703cfcd.json"
            )),
            text(&v, "keyHash")
        );
        let credential =
            EnvelopeAddress::credential(&CredentialId::parse(text(&v, "credentialId")).unwrap());
        let header = EnvelopeAddress::resource_header(
            &ProviderResourceId::parse(text(&v, "resourceId")).unwrap(),
            "AUTHORIZATION",
        )
        .unwrap();
        for (address, plaintext, encoded, offset) in [
            (
                EnvelopeAddress::canary(&material.id),
                text(&v, "canaryPlaintext"),
                text(&v, "canaryEnvelope"),
                0,
            ),
            (
                credential,
                text(&v, "credentialPlaintext"),
                text(&v, "credentialEnvelope"),
                12,
            ),
            (
                header,
                text(&v, "headerPlaintext"),
                text(&v, "headerEnvelope"),
                24,
            ),
        ] {
            assert_eq!(
                material
                    .seal_nonce(
                        &address,
                        plaintext,
                        std::array::from_fn(|i| i as u8 + offset)
                    )
                    .unwrap(),
                encoded
            );
            assert_eq!(
                material
                    .open(&address, &Envelope::parse(encoded).unwrap())
                    .unwrap()
                    .expose(),
                plaintext
            );
        }
        material.check_canary(text(&v, "canaryEnvelope")).unwrap();
        material
            .check_canary(&material.seal_canary().unwrap())
            .unwrap();
    }
    #[test]
    fn altered_identity_tag_encoding_and_canary_fail_closed() {
        let v = vectors();
        let material = Material::derive(&std::array::from_fn(|i| i as u8)).unwrap();
        let correct =
            EnvelopeAddress::credential(&CredentialId::parse(text(&v, "credentialId")).unwrap());
        let encoded = text(&v, "credentialEnvelope");
        for address in [
            EnvelopeAddress {
                facet: "resource".into(),
                ..correct.clone()
            },
            EnvelopeAddress {
                record: "crd_other".into(),
                ..correct.clone()
            },
            EnvelopeAddress {
                field: "other".into(),
                ..correct.clone()
            },
            EnvelopeAddress {
                field: "secret\0".into(),
                ..correct.clone()
            },
            EnvelopeAddress {
                record: String::new(),
                ..correct.clone()
            },
        ] {
            assert!(
                material
                    .open(&address, &Envelope::parse(encoded).unwrap())
                    .is_err()
            );
        }
        let mut altered = Envelope::parse(encoded).unwrap();
        altered.key = KeyId::parse("ck_000000000000000000000000").unwrap();
        assert!(material.open(&correct, &altered).is_err());
        for index in [0, 12, altered.data.len() - 1] {
            let mut altered = Envelope::parse(encoded).unwrap();
            altered.data[index] ^= 1;
            let error = material.open(&correct, &altered).unwrap_err();
            let diagnostic = format!("{error:?}");
            assert!(!diagnostic.contains(text(&v, "credentialPlaintext")));
            assert!(!diagnostic.contains(encoded));
        }
        for malformed in [
            format!("{encoded}="),
            encoded.replacen("v1.", "v2.", 1),
            format!("{encoded}.extra"),
            "v1.ck_000000000000000000000000.AA".into(),
        ] {
            assert!(Envelope::parse(&malformed).is_err());
        }
        let bad_canary = material
            .seal(&EnvelopeAddress::canary(&material.id), "not the canary")
            .unwrap();
        assert!(material.check_canary(&bad_canary).is_err());
        assert!(
            EnvelopeAddress::resource_header(&ProviderResourceId::from_bytes([2; 16]), "x\0header")
                .is_err()
        );
        assert!(
            material
                .seal(&correct, &"x".repeat(MAX_PLAINTEXT + 1))
                .is_err()
        );
    }
}
