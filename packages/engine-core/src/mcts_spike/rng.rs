//! Hand-rolled SplitMix64 — keeps the spike free of external rand deps.
//! Deterministic per seed, fast, statistically fine for benchmarking.

pub struct SplitMix64(pub u64);

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform integer in 0..n. Caller ensures n > 0.
    pub fn gen_range(&mut self, n: usize) -> usize {
        (self.next_u64() as usize) % n
    }

    /// Uniform float in [0, 1).
    pub fn gen_unit(&mut self) -> f64 {
        // Top 53 bits → mantissa.
        let bits = self.next_u64() >> 11;
        bits as f64 / (1u64 << 53) as f64
    }
}
