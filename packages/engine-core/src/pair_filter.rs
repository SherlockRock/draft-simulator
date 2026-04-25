use std::collections::HashSet;

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
/// - `role_a_top` / `role_b_top` — top candidates per role-of-pair (already filtered)
/// - `forced_partner` — Some(c) means c must be in every emitted pair (if the bucket is enabled)
pub fn seed_pair_candidates<'a>(
    scored_singles: &[(&'a str, f64)],
    role_a_top: &[&'a str],
    role_b_top: &[&'a str],
    forced_partner: Option<&'a str>,
    cfg: &PairFilterConfig,
) -> Vec<PairCandidate> {
    let mut out: HashSet<PairCandidate> = HashSet::new();

    // Bucket 1: top-K global singles → all pairs among them
    if cfg.single_top_k > 0 {
        let top: Vec<&str> = scored_singles
            .iter()
            .take(cfg.single_top_k)
            .map(|(c, _)| *c)
            .collect();
        for i in 0..top.len() {
            for j in (i + 1)..top.len() {
                out.insert(PairCandidate::canonical(top[i], top[j]));
            }
        }
    }

    // Bucket 2: per-role top × top
    if cfg.per_role_top > 0 {
        let a = &role_a_top[..role_a_top.len().min(cfg.per_role_top)];
        let b = &role_b_top[..role_b_top.len().min(cfg.per_role_top)];
        for &x in a {
            for &y in b {
                if x != y {
                    out.insert(PairCandidate::canonical(x, y));
                }
            }
        }
    }

    // Bucket 3: forced partner — pair forced with every other single
    if let Some(forced) = forced_partner {
        for (c, _) in scored_singles {
            if *c != forced {
                out.insert(PairCandidate::canonical(forced, c));
            }
        }
    }

    // Cap at max_pairs (deterministic via sort)
    let mut sorted: Vec<PairCandidate> = out.into_iter().collect();
    sorted.sort();
    sorted.truncate(cfg.max_pairs);
    sorted
}
