use engine_core::forced_branches::{resolve_path, PathMatch, PathStep};

fn step(slot: usize, ids: &[&str]) -> PathStep {
    PathStep {
        slot,
        champion_ids: ids.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn empty_path_matches_root() {
    let r = resolve_path(&[], &[]);
    assert!(matches!(r, PathMatch::Resolved { depth: 0 }));
}

#[test]
fn unresolved_path_returns_unresolved() {
    let path = vec![step(7, &["Yone"])];
    let actual_lineage: Vec<(usize, Vec<String>)> = Vec::new();
    let r = resolve_path(&path, &actual_lineage);
    assert!(matches!(r, PathMatch::Unresolved));
}

#[test]
fn content_addressed_path_resolves() {
    let path = vec![step(6, &["B1"]), step(7, &["R1", "R2"])];
    let lineage = vec![
        (6, vec!["B1".to_string()]),
        (7, vec!["R1".to_string(), "R2".to_string()]),
    ];
    let r = resolve_path(&path, &lineage);
    assert!(matches!(r, PathMatch::Resolved { depth: 2 }));
}

#[test]
fn pair_path_order_independent() {
    // Pair championIds should match irrespective of the order they're listed.
    let path = vec![step(7, &["R2", "R1"])];
    let lineage = vec![(7, vec!["R1".to_string(), "R2".to_string()])];
    let r = resolve_path(&path, &lineage);
    assert!(matches!(r, PathMatch::Resolved { depth: 1 }));
}

#[test]
fn slot_mismatch_unresolved() {
    let path = vec![step(7, &["B1"])];
    let lineage = vec![(6, vec!["B1".to_string()])]; // slot 6 vs 7
    let r = resolve_path(&path, &lineage);
    assert!(matches!(r, PathMatch::Unresolved));
}
