use engine_core::draft_state::DraftState;
use engine_core::transposition::{StateHash, TranspositionCache};

#[test]
fn same_state_same_score() {
    let mut cache = TranspositionCache::new();
    let state = DraftState::default();
    let h = StateHash::from(&state);
    cache.insert(h.clone(), 0.42);
    assert_eq!(cache.get(&h), Some(0.42));
}

#[test]
fn ban_order_irrelevant() {
    let mut a = DraftState::default();
    a.blue_bans = vec!["X".into(), "Y".into()];
    a.red_bans = vec!["Z".into()];

    let mut b = DraftState::default();
    b.blue_bans = vec!["Y".into(), "X".into()]; // reversed
    b.red_bans = vec!["Z".into()];

    assert_eq!(StateHash::from(&a), StateHash::from(&b));
}

#[test]
fn pair_pick_internal_order_irrelevant() {
    let mut a = DraftState::default();
    // R1-R2 pair: champions A then B
    a.red_picks = vec!["A".into(), "B".into()];

    let mut b = DraftState::default();
    b.red_picks = vec!["B".into(), "A".into()];

    // Both are at the same revelation boundary, so hashes match.
    assert_eq!(StateHash::from(&a), StateHash::from(&b));
}
