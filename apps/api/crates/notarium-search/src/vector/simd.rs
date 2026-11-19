#![allow(unsafe_code)]

//! Runtime-dispatched signed-byte dot products. Every architecture shares the
//! same scalar accumulation and accumulation bound.

use super::MAX_DIMENSION;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kernel {
    Scalar,
    Avx2,
    Avx512Vnni,
    Neon,
}

impl Kernel {
    pub const ALL: [Self; 4] = [Self::Scalar, Self::Avx2, Self::Avx512Vnni, Self::Neon];

    pub fn detect() -> Self {
        [Self::Avx512Vnni, Self::Avx2, Self::Neon]
            .into_iter()
            .find(|kernel| kernel.available())
            .unwrap_or(Self::Scalar)
    }

    pub fn available(self) -> bool {
        match self {
            Self::Scalar => true,
            #[cfg(target_arch = "x86_64")]
            Self::Avx2 => std::is_x86_feature_detected!("avx2"),
            #[cfg(target_arch = "x86_64")]
            Self::Avx512Vnni => {
                std::is_x86_feature_detected!("avx512f")
                    && std::is_x86_feature_detected!("avx512bw")
                    && std::is_x86_feature_detected!("avx512vnni")
            }
            #[cfg(target_arch = "aarch64")]
            Self::Neon => std::arch::is_aarch64_feature_detected!("neon"),
            #[allow(unreachable_patterns)]
            _ => false,
        }
    }

    fn block_width(self) -> usize {
        match self {
            Self::Avx512Vnni => 64,
            Self::Avx2 => 32,
            Self::Neon => 16,
            Self::Scalar => 1,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Dot<'a> {
    query: &'a [i8],
    kernel: Kernel,
    prefix: usize,
    #[cfg(target_arch = "x86_64")]
    query_bias: i32,
}

impl<'a> Dot<'a> {
    pub fn new(query: &'a [i8]) -> Option<Self> {
        Self::with_kernel(query, Kernel::detect())
    }

    pub fn with_kernel(query: &'a [i8], kernel: Kernel) -> Option<Self> {
        if query.is_empty() || query.len() > MAX_DIMENSION || !kernel.available() {
            return None;
        }
        let prefix = query.len() / kernel.block_width() * kernel.block_width();
        #[cfg(target_arch = "x86_64")]
        let query_bias = if kernel == Kernel::Avx512Vnni {
            128 * query[..prefix]
                .iter()
                .map(|&value| i32::from(value))
                .sum::<i32>()
        } else {
            0
        };
        Some(Self {
            query,
            kernel,
            prefix,
            #[cfg(target_arch = "x86_64")]
            query_bias,
        })
    }

    pub fn kernel(self) -> Kernel {
        self.kernel
    }

    pub fn dot(self, vector: &[i8]) -> Option<i32> {
        if vector.len() != self.query.len() {
            return None;
        }
        let (q, q_tail) = self.query.split_at(self.prefix);
        let (v, v_tail) = vector.split_at(self.prefix);
        let score = match self.kernel {
            #[cfg(target_arch = "x86_64")]
            Kernel::Avx512Vnni => {
                // SAFETY: with_kernel checked all required CPU features. Both
                // prefixes are equal and a multiple of 64 bytes.
                (unsafe { avx512vnni(q, v) }) - self.query_bias
            }
            #[cfg(target_arch = "x86_64")]
            Kernel::Avx2 => {
                // SAFETY: with_kernel checked AVX2 and both prefixes contain
                // complete 32-byte blocks.
                unsafe { avx2(q, v) }
            }
            #[cfg(target_arch = "aarch64")]
            Kernel::Neon => {
                // SAFETY: with_kernel checked NEON and both prefixes contain
                // complete 16-byte blocks.
                unsafe { neon(q, v) }
            }
            _ => scalar(q, v),
        };
        Some(score + scalar(q_tail, v_tail))
    }
}

pub fn dot_i8_scalar(query: &[i8], vector: &[i8]) -> Option<i32> {
    Dot::with_kernel(query, Kernel::Scalar)?.dot(vector)
}

fn scalar(query: &[i8], vector: &[i8]) -> i32 {
    query
        .iter()
        .zip(vector)
        .map(|(&q, &v)| i32::from(q) * i32::from(v))
        .sum()
}

#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,avx512bw,avx512vnni")]
unsafe fn avx512vnni(query: &[i8], vector: &[i8]) -> i32 {
    let mut sum = _mm512_setzero_si512();
    let flip = _mm512_set1_epi8(i8::MIN);
    for (q, v) in query
        .as_chunks::<64>()
        .0
        .iter()
        .zip(vector.as_chunks::<64>().0)
    {
        // SAFETY: each chunk contains exactly 64 readable bytes and these loads
        // permit any byte alignment. The caller checked the CPU features.
        let (q, v) = unsafe {
            (
                _mm512_loadu_si512(q.as_ptr().cast()),
                _mm512_loadu_si512(v.as_ptr().cast()),
            )
        };
        sum = _mm512_dpbusd_epi32(sum, _mm512_xor_si512(v, flip), q);
    }
    _mm512_reduce_add_epi32(sum)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn avx2(query: &[i8], vector: &[i8]) -> i32 {
    let mut sum = _mm256_setzero_si256();
    for (q, v) in query
        .as_chunks::<16>()
        .0
        .iter()
        .zip(vector.as_chunks::<16>().0)
    {
        // SAFETY: each chunk contains exactly 16 readable bytes and these loads
        // permit any byte alignment. The caller checked AVX2.
        let (q, v) = unsafe {
            (
                _mm_loadu_si128(q.as_ptr().cast()),
                _mm_loadu_si128(v.as_ptr().cast()),
            )
        };
        let q = _mm256_cvtepi8_epi16(q);
        let v = _mm256_cvtepi8_epi16(v);
        sum = _mm256_add_epi32(sum, _mm256_madd_epi16(q, v));
    }
    let mut lanes = [0i32; 8];
    // SAFETY: lanes provides 32 writable bytes, unaligned store is valid, and
    // AVX2 is enabled for this function.
    unsafe { _mm256_storeu_si256(lanes.as_mut_ptr().cast(), sum) };
    lanes.iter().sum()
}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn neon(query: &[i8], vector: &[i8]) -> i32 {
    use std::arch::aarch64::*;
    let mut sum = vdupq_n_s32(0);
    for (q, v) in query
        .as_chunks::<16>()
        .0
        .iter()
        .zip(vector.as_chunks::<16>().0)
    {
        // SAFETY: each chunk contains exactly 16 readable bytes. The caller
        // checked NEON and the loads accept any byte alignment.
        let (q, v) = unsafe { (vld1q_s8(q.as_ptr()), vld1q_s8(v.as_ptr())) };
        sum = vpadalq_s16(sum, vmull_s8(vget_low_s8(q), vget_low_s8(v)));
        sum = vpadalq_s16(sum, vmull_high_s8(q, v));
    }
    vaddvq_s32(sum)
}
