use engine_core::pair_filter::{seed_pair_candidates, PairFilterConfig};
use std::collections::HashSet;

#[test]
fn bucket_global_top_k() {
    let scored: Vec<(&str, f64)> = vec![
        ("A", 0.9),
        ("B", 0.85),
        ("C", 0.8),
        ("D", 0.7),
        ("E", 0.5),
    ];
    let cfg = PairFilterConfig {
        single_top_k: 3,
        per_role_top: 0,
        max_pairs: 100,
    };
    let pairs = seed_pair_candidates(&scored, &[], &[], None, &cfg);
    // C(3,2) = 3 pairs from top-3 globally
    assert_eq!(pairs.len(), 3);
}

#[test]
fn bucket_per_role_pairs() {
    let scored: Vec<(&str, f64)> = vec![("A", 0.9), ("B", 0.5), ("C", 0.4)];
    let role_a: Vec<&str> = vec!["A", "C"];
    let role_b: Vec<&str> = vec!["B"];
    let cfg = PairFilterConfig {
        single_top_k: 0,
        per_role_top: 5,
        max_pairs: 100,
    };
    let pairs = seed_pair_candidates(&scored, &role_a, &role_b, None, &cfg);
    // 2 × 1 = 2 (A,B) (C,B)
    assert_eq!(pairs.len(), 2);
}

#[test]
fn bucket_forced_partner() {
    let scored: Vec<(&str, f64)> = vec![("A", 0.9), ("B", 0.5), ("C", 0.4)];
    let cfg = PairFilterConfig {
        single_top_k: 0,
        per_role_top: 0,
        max_pairs: 100,
    };
    let pairs = seed_pair_candidates(&scored, &[], &[], Some("A"), &cfg);
    // forced=A pairs with every other candidate: (A,B), (A,C)
    assert_eq!(pairs.len(), 2);
    assert!(pairs.iter().all(|p| p.first == "A" || p.second == "A"));
}

#[test]
fn buckets_dedup() {
    let scored: Vec<(&str, f64)> = vec![("A", 0.9), ("B", 0.85)];
    let role_a: Vec<&str> = vec!["A"];
    let role_b: Vec<&str> = vec!["B"];
    let cfg = PairFilterConfig {
        single_top_k: 2,
        per_role_top: 5,
        max_pairs: 100,
    };
    let pairs = seed_pair_candidates(&scored, &role_a, &role_b, None, &cfg);
    let unique: HashSet<_> = pairs
        .iter()
        .map(|p| (p.first.clone(), p.second.clone()))
        .collect();
    assert_eq!(unique.len(), 1);
}

#[test]
fn pair_count_under_1000_at_171_pool() {
    let scored: Vec<(String, f64)> = (0..171)
        .map(|i| (format!("c{}", i), 1.0 / (i as f64 + 1.0)))
        .collect();
    let scored_refs: Vec<(&str, f64)> = scored.iter().map(|(s, f)| (s.as_str(), *f)).collect();
    let cfg = PairFilterConfig {
        single_top_k: 32,
        per_role_top: 8,
        max_pairs: 1000,
    };
    let pairs = seed_pair_candidates(&scored_refs, &[], &[], None, &cfg);
    assert!(
        pairs.len() <= 1000,
        "Pair seed must stay under 1000 with single_top_k=32: got {}",
        pairs.len()
    );
    assert!(
        pairs.len() < 14535,
        "Pair seed must beat the JS baseline 14535: got {}",
        pairs.len()
    );
}
