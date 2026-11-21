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

    pub(super) fn dot_rows(self, vectors: &[i8], slots: &[u32], output: &mut [i32]) -> Option<()> {
        let width = self.query.len();
        if slots.len() != output.len()
            || !vectors.len().is_multiple_of(width)
            || slots
                .iter()
                .any(|&slot| slot as usize >= vectors.len() / width)
        {
            return None;
        }
        #[cfg(target_arch = "x86_64")]
        if self.kernel == Kernel::Avx512Vnni && self.prefix == width {
            // SAFETY: with_kernel verified the CPU features. Query and matrix
            // contain complete 64-byte blocks and every slot identifies a row.
            unsafe { avx512vnni_rows(self.query, vectors, slots, output, self.query_bias) };
            return Some(());
        }
        for (&slot, output) in slots.iter().zip(output) {
            let start = slot as usize * width;
            *output = self.dot(&vectors[start..start + width])?;
        }
        Some(())
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
#[target_feature(enable = "avx512f,avx512bw,avx512vnni")]
unsafe fn avx512vnni_rows(
    query: &[i8],
    vectors: &[i8],
    slots: &[u32],
    output: &mut [i32],
    bias: i32,
) {
    let zero = _mm512_setzero_si512();
    let flip = _mm512_set1_epi8(i8::MIN);
    let width = query.len() / 64;
    let vectors = vectors.as_chunks::<64>().0;
    let mut packed = [zero; MAX_DIMENSION / 64];
    for (source, target) in query.as_chunks::<64>().0.iter().zip(&mut packed) {
        // SAFETY: source contains 64 readable bytes. Unaligned loads are valid.
        *target = unsafe { _mm512_loadu_si512(source.as_ptr().cast()) };
    }
    let (query_groups, query_tail) = packed[..width].as_chunks::<4>();
    for (position, (&slot, output)) in slots.iter().zip(output).enumerate() {
        if let Some(&ahead) = slots.get(position + 12) {
            let address = &vectors[ahead as usize * width];
            _mm_prefetch::<_MM_HINT_T0>(address.as_ptr());
        }
        let start = slot as usize * width;
        let (rows, row_tail) = vectors[start..start + width].as_chunks::<4>();
        let mut sums = [zero; 4];
        for (vectors, query) in rows.iter().zip(query_groups) {
            for ((vector, &query), sum) in vectors.iter().zip(query).zip(&mut sums) {
                // SAFETY: vector contains 64 readable bytes.
                let vector = unsafe { _mm512_loadu_si512(vector.as_ptr().cast()) };
                *sum = _mm512_dpbusd_epi32(*sum, _mm512_xor_si512(vector, flip), query);
            }
        }
        for ((vector, &query), sum) in row_tail.iter().zip(query_tail).zip(&mut sums) {
            // SAFETY: vector contains 64 readable bytes.
            let vector = unsafe { _mm512_loadu_si512(vector.as_ptr().cast()) };
            *sum = _mm512_dpbusd_epi32(*sum, _mm512_xor_si512(vector, flip), query);
        }
        let total = _mm512_add_epi32(
            _mm512_add_epi32(sums[0], sums[1]),
            _mm512_add_epi32(sums[2], sums[3]),
        );
        *output = _mm512_reduce_add_epi32(total) - bias;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_kernel_matches_individual_signed_dots_in_slot_order() {
        for width in [64, 100, 384, 768, MAX_DIMENSION] {
            let bytes = |length, offset| {
                (0..length)
                    .map(|at| (at * 211usize + offset) as u8 as i8)
                    .collect::<Vec<_>>()
            };
            let query = bytes(width, 26);
            let data = bytes(19 * width, 81);
            let slots = [
                18, 0, 7, 3, 14, 2, 11, 9, 16, 4, 12, 6, 8, 10, 17, 13, 1, 5, 15,
            ];
            for kernel in Kernel::ALL.into_iter().filter(|kernel| kernel.available()) {
                let dot = Dot::with_kernel(&query, kernel).unwrap();
                let mut scores = [0; 19];
                dot.dot_rows(&data, &slots, &mut scores).unwrap();
                for (&slot, score) in slots.iter().zip(scores) {
                    let start = slot as usize * width;
                    assert_eq!(
                        Some(score),
                        dot_i8_scalar(&query, &data[start..start + width])
                    );
                }
                assert!(dot.dot_rows(&data, &[19], &mut [0]).is_none());
            }
        }
    }
}
