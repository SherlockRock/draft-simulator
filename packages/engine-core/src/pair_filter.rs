use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug)]
pub struct PairFilterConfig {
    pub single_top_k: usize,
    pub per_role_top: usize,
    pub max_pairs: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PairCandidate {
    pub first: String,
    pub second: String,
}

impl PairCandidate {
    fn canonical(a: &str, b: &str) -> Self {
        if a <= b {
            Self {
                first: a.into(),
                second: b.into(),
            }
        } else {
            Self {
                first: b.into(),
                second: a.into(),
            }
        }
    }
}

/// Three-bucket pair candidate seeding.
/// - `scored_singles` — pre-scored singles, sorted DESC by score
/// - `role_buckets` — list of (role_a_top, role_b_top) tuples; each tuple is
///   one bucket-2 group, the caller is responsible for not double-counting.
///   Pick2 with N missing roles passes `C(N,2)` tuples (one per unordered
///   missing-role pair). Empty list disables bucket-2.
/// - `forced_partner` — Some(c) means c must be in every emitted pair (if the bucket is enabled)
///
/// Bucket-2 (role specialists) and Bucket-3 (caller-forced partner) are
/// "protected": always emitted in full, even if `protected.len() > max_pairs`.
/// This is by design — both buckets are pre-filtered to caller-mandated
/// invariants (role coverage at Pick2, forced-branch overrides) that the
/// downstream value-sort cannot reconstruct.
///
/// Bucket-1 is the open-ended bucket; its surplus is what `max_pairs` caps.
/// The cap applies *after* dedup against the protected set, sorted by additive
/// single-score (DESC) with lex tie-break — lex-only truncation biases against
/// high-scoring champions whose IDs sort late alphabetically when
/// `max_pairs < C(single_top_k, 2)`.
pub fn seed_pair_candidates<'a>(
    scored_singles: &[(&'a str, f64)],
    role_buckets: &[(Vec<&'a str>, Vec<&'a str>)],
    forced_partner: Option<&'a str>,
    cfg: &PairFilterConfig,
) -> Vec<PairCandidate> {
    let mut protected: HashSet<PairCandidate> = HashSet::new();

    // Bucket 2: union of per-role top × top across every (role_a, role_b)
    // bucket. Dedup is implicit via `protected: HashSet`.
    if cfg.per_role_top > 0 {
        for (role_a_top, role_b_top) in role_buckets {
            let a = &role_a_top[..role_a_top.len().min(cfg.per_role_top)];
            let b = &role_b_top[..role_b_top.len().min(cfg.per_role_top)];
            for &x in a {
                for &y in b {
                    if x != y {
                        protected.insert(PairCandidate::canonical(x, y));
                    }
                }
            }
        }
    }

    // Bucket 3: forced partner — protected.
    if let Some(forced) = forced_partner {
        for (c, _) in scored_singles {
            if *c != forced {
                protected.insert(PairCandidate::canonical(forced, c));
            }
        }
    }

    // Bucket 1: top-K global singles → all pairs among them, minus already-protected.
    let mut bucket_1: HashSet<PairCandidate> = HashSet::new();
    if cfg.single_top_k > 0 {
        let top: Vec<&str> = scored_singles
            .iter()
            .take(cfg.single_top_k)
            .map(|(c, _)| *c)
            .collect();
        for i in 0..top.len() {
            for j in (i + 1)..top.len() {
                let pc = PairCandidate::canonical(top[i], top[j]);
                if !protected.contains(&pc) {
                    bucket_1.insert(pc);
                }
            }
        }
    }

    let bucket_1_budget = cfg.max_pairs.saturating_sub(protected.len());

    // Truncate bucket-1 by additive single-score DESC (lex tie-break for
    // determinism). Lex-only truncation would silently evict high-scoring
    // pairs whose champion IDs sort late alphabetically whenever
    // `bucket_1_budget < bucket_1.len()`.
    let score_lookup: HashMap<&str, f64> = scored_singles.iter().copied().collect();
    let pair_score = |p: &PairCandidate| -> f64 {
        score_lookup.get(p.first.as_str()).copied().unwrap_or(0.0)
            + score_lookup.get(p.second.as_str()).copied().unwrap_or(0.0)
    };
    let mut bucket_1_sorted: Vec<PairCandidate> = bucket_1.into_iter().collect();
    bucket_1_sorted.sort_by(|a, b| {
        pair_score(b)
            .total_cmp(&pair_score(a))
            .then_with(|| a.cmp(b))
    });
    bucket_1_sorted.truncate(bucket_1_budget);

    let mut out: Vec<PairCandidate> = protected.into_iter().collect();
    out.extend(bucket_1_sorted);
    out.sort();
    out
}
