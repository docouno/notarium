use super::token::{Secret, random};
use crate::error::{invalid, unavailable};
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use base64::{Engine, engine::general_purpose::STANDARD};
use notarium_core::{
    DomainError,
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
};
use std::sync::{Arc, LazyLock};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use zeroize::Zeroizing;

const CREDIT: u64 = 64 * 1024 * 1024;
static ADMISSION: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));

enum Profile {
    Argon {
        encoded: String,
        credits: u32,
    },
    Scrypt {
        params: scrypt::Params,
        salt: [u8; 16],
        key: [u8; 32],
        credits: u32,
    },
}
impl Profile {
    fn parse(encoded: &str) -> Result<Self, PortError> {
        let bad = || invalid(ValidationReason::InvalidAuthority);
        if encoded.len() > 1024 {
            return Err(bad());
        }
        if encoded.starts_with("$argon2id$") {
            let hash = PasswordHash::new(encoded).map_err(|_| bad())?;
            let params = Params::try_from(&hash).map_err(|_| bad())?;
            if hash.version != Some(19)
                || hash.salt.as_ref().is_none_or(|s| s.len() != 16)
                || hash.hash.as_ref().is_none_or(|s| s.len() != 32)
                || !(1..=262144).contains(&params.m_cost())
                || !(1..=10).contains(&params.t_cost())
                || !(1..=4).contains(&params.p_cost())
                || hash.params.iter().count() != 3
            {
                return Err(bad());
            }
            return Ok(Self::Argon {
                encoded: encoded.to_owned(),
                credits: params.m_cost().div_ceil(65536),
            });
        }
        let parts: Vec<_> = encoded.split(':').collect();
        if parts.len() != 6 || parts[0] != "scrypt" {
            return Err(bad());
        }
        let log_n: u8 = parts[1].parse().map_err(|_| bad())?;
        let r: u32 = parts[2].parse().map_err(|_| bad())?;
        let p: u32 = parts[3].parse().map_err(|_| bad())?;
        if !(1..=20).contains(&log_n) || !(1..=32).contains(&r) || !(1..=16).contains(&p) {
            return Err(bad());
        }
        let n = 1u64 << log_n;
        let memory = n * 128 * u64::from(r);
        if memory > 4 * CREDIT || n * u64::from(r) * u64::from(p) > 4 * (1 << 17) * 8 {
            return Err(bad());
        }
        let salt = STANDARD.decode(parts[4]).map_err(|_| bad())?;
        let key = STANDARD.decode(parts[5]).map_err(|_| bad())?;
        if salt.len() != 16
            || key.len() != 32
            || STANDARD.encode(&salt) != parts[4]
            || STANDARD.encode(&key) != parts[5]
        {
            return Err(bad());
        }
        let params = scrypt::Params::new(log_n, r, p).map_err(|_| bad())?;
        Ok(Self::Scrypt {
            params,
            salt: salt.try_into().map_err(|_| bad())?,
            key: key.try_into().map_err(|_| bad())?,
            credits: memory.div_ceil(CREDIT) as u32,
        })
    }
    fn credits(&self) -> u32 {
        match self {
            Self::Argon { credits, .. } | Self::Scrypt { credits, .. } => *credits,
        }
    }
}

fn admit(credits: u32) -> Result<OwnedSemaphorePermit, PortError> {
    ADMISSION
        .clone()
        .try_acquire_many_owned(credits)
        .map_err(|_| {
            DomainError::RateLimited {
                retry_after_ms: 1000,
                budget: BudgetKind::Concurrency,
            }
            .into()
        })
}
fn canonical_hash(password: &[u8]) -> Result<String, PortError> {
    let params = Params::new(65536, 3, 1, Some(32)).expect("fixed valid Argon2 profile");
    let algorithm = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    algorithm
        .hash_password_with_salt(password, &random::<16>()?)
        .map(|hash| hash.to_string())
        .map_err(|_| unavailable("password hashing", CommitEffect::NotCommitted))
}

#[derive(Debug)]
pub struct PasswordVerification {
    pub valid: bool,
    /// Persist with CAS on the old password hash and auth version before login.
    pub upgraded_hash: Option<String>,
}

/// Validate a stored login method without running a KDF or accepting a secret.
pub(crate) fn supported(encoded: &str) -> bool {
    Profile::parse(encoded).is_ok()
}

pub async fn hash(password: Secret) -> Result<String, PortError> {
    if !(8..=1024).contains(&password.expose().len()) {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let permit = admit(1)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        canonical_hash(password.expose().as_bytes())
    })
    .await
    .map_err(|_| unavailable("password worker", CommitEffect::NotCommitted))?
}

pub async fn verify(password: Secret, encoded: &str) -> Result<PasswordVerification, PortError> {
    if password.expose().len() > 4096 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let profile = Profile::parse(encoded)?;
    let permit = admit(profile.credits())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        verify_profile(password, profile)
    })
    .await
    .map_err(|_| unavailable("password worker", CommitEffect::NotCommitted))?
}

fn verify_profile(password: Secret, profile: Profile) -> Result<PasswordVerification, PortError> {
    let legacy = matches!(&profile, Profile::Scrypt { .. });
    let valid = match profile {
        Profile::Argon { encoded, .. } => Argon2::default()
            .verify_password(password.expose().as_bytes(), encoded.as_str())
            .is_ok(),
        Profile::Scrypt {
            params, salt, key, ..
        } => {
            let mut output = Zeroizing::new([0u8; 32]);
            scrypt::scrypt(password.expose().as_bytes(), &salt, &params, &mut *output)
                .map_err(|_| invalid(ValidationReason::InvalidAuthority))?;
            bool::from(output.as_slice().ct_eq(&key))
        }
    };
    // The scrypt call and its memory-hard buffers have returned before rehash.
    let upgraded_hash = if valid && legacy {
        Some(canonical_hash(password.expose().as_bytes())?)
    } else {
        None
    };
    Ok(PasswordVerification {
        valid,
        upgraded_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    static KDF_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    #[test]
    fn admission_costs_and_malicious_parameters_are_checked_before_work() {
        let encoded = format!(
            "scrypt:17:8:1:{}:{}",
            STANDARD.encode([0; 16]),
            STANDARD.encode([0; 32])
        );
        assert_eq!(Profile::parse(&encoded).unwrap().credits(), 2);
        for value in [
            encoded.replace(":17:", ":20:"),
            encoded.replace(":8:1:", ":8:16:"),
            "scrypt:999:8:1:a:b".into(),
            "$argon2id$v=19$m=4294967295,t=3,p=1$a$b".into(),
        ] {
            assert!(Profile::parse(&value).is_err());
        }
    }
    #[tokio::test]
    async fn canonical_password_roundtrip() {
        let _serial = KDF_TEST_LOCK.lock().await;
        let encoded = hash(Secret::new("test password".into())).await.unwrap();
        assert!(encoded.starts_with("$argon2id$v=19$m=65536,t=3,p=1$"));
        assert!(
            verify(Secret::new("test password".into()), &encoded)
                .await
                .unwrap()
                .valid
        );
        assert!(
            !verify(Secret::new("wrong".into()), &encoded)
                .await
                .unwrap()
                .valid
        );
    }
    #[tokio::test]
    async fn measured_kdf_heap_and_overhead_stay_bounded() {
        let _serial = KDF_TEST_LOCK.lock().await;
        // The counter observes the actual synchronous worker on this thread.
        // Inputs and profile parsing are included; no nested measurement is used.
        let canonical = allocation_counter::measure(|| {
            let password = Secret::new("x".repeat(1024));
            drop(canonical_hash(password.expose().as_bytes()).unwrap());
        });
        assert!(
            (CREDIT..=CREDIT + 1024 * 1024).contains(&canonical.bytes_max),
            "{canonical:?}"
        );
        assert_eq!(canonical.bytes_current, 0);
        eprintln!("canonical Argon2 heap peak: {} bytes", canonical.bytes_max);
        let native_password = "native test password";
        let mut native_key = [0; 32];
        scrypt::scrypt(
            native_password.as_bytes(),
            &[1; 16],
            &scrypt::Params::new(17, 8, 1).unwrap(),
            &mut native_key,
        )
        .unwrap();
        let native = format!(
            "scrypt:17:8:1:{}:{}",
            STANDARD.encode([1; 16]),
            STANDARD.encode(native_key)
        );
        let profiles=[
            ("native scrypt then Argon2",native,native_password,2*CREDIT,true),
            ("maximum scrypt V",format!("scrypt:16:32:1:{}:{}",STANDARD.encode([0;16]),STANDARD.encode([0;32])),"wrong",4*CREDIT,false),
            ("maximum scrypt B",format!("scrypt:1:32:16:{}:{}",STANDARD.encode([0;16]),STANDARD.encode([0;32])),"wrong",8192,false),
            ("maximum Argon2", "$argon2id$v=19$m=262144,t=1,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),"wrong",4*CREDIT,false),
        ];
        for (name, encoded, password, primary, valid) in profiles {
            let info = allocation_counter::measure(|| {
                let profile = Profile::parse(&encoded).unwrap();
                let result = verify_profile(Secret::new(password.into()), profile).unwrap();
                assert_eq!(result.valid, valid);
                if valid {
                    assert!(result.upgraded_hash.unwrap().starts_with("$argon2id$"));
                }
            });
            assert!(
                (primary..=primary + 1024 * 1024).contains(&info.bytes_max),
                "{name}: {info:?}"
            );
            assert_eq!(info.bytes_current, 0, "{name}");
            eprintln!(
                "{name}: primary={primary} heap_peak={} overhead={}",
                info.bytes_max,
                info.bytes_max - primary
            );
        }
        // Inputs and job metadata have hard bounds independently of buffers.
        assert!(
            std::mem::size_of::<Profile>()
                + std::mem::size_of::<OwnedSemaphorePermit>()
                + 4096
                + 1024
                < 16384
        );
    }
    #[tokio::test]
    async fn mixed_flood_rejects_before_work_and_drop_retains_credits() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let _serial = KDF_TEST_LOCK.lock().await;
        let rejected = AtomicUsize::new(0);
        let argon = "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let scrypt = format!(
            "scrypt:17:8:1:{}:{}",
            STANDARD.encode([0; 16]),
            STANDARD.encode([0; 32])
        );
        let mut attempts = Box::pin(futures_util::future::join_all((0..50).map(|i| {
            let encoded = if i % 3 == 0 { scrypt.as_str() } else { argon };
            let rejected = &rejected;
            async move {
                let result = verify(Secret::new("wrong".into()), encoded).await;
                if matches!(
                    result,
                    Err(PortError::Domain(DomainError::RateLimited { .. }))
                ) {
                    rejected.fetch_add(1, Ordering::SeqCst);
                }
                result
            }
        })));
        assert!(futures_util::poll!(&mut attempts).is_pending());
        assert_eq!(ADMISSION.available_permits(), 0);
        assert!((46..=48).contains(&rejected.load(Ordering::SeqCst)));
        eprintln!(
            "mixed flood: admitted={} rejected={} peak_credits=4",
            50 - rejected.load(Ordering::SeqCst),
            rejected.load(Ordering::SeqCst)
        );
        drop(attempts);
        assert!(matches!(
            hash(Secret::new("new password".into())).await,
            Err(PortError::Domain(DomainError::RateLimited { .. }))
        ));
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while ADMISSION.available_permits() != 4 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
