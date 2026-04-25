use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};

#[test]
fn turn_sequence_matches_spec() {
    assert_eq!(TURN_SEQUENCE.len(), 20);
    // Slot 0: blue ban1
    assert_eq!(TURN_SEQUENCE[0].side, Side::Blue);
    assert_eq!(TURN_SEQUENCE[0].action_type, ActionType::Ban);
    assert_eq!(TURN_SEQUENCE[0].phase, Phase::Ban1);
    // Slot 6: blue pick1 (B1)
    assert_eq!(TURN_SEQUENCE[6].side, Side::Blue);
    assert_eq!(TURN_SEQUENCE[6].action_type, ActionType::Pick);
    // Slot 7-8: red R1-R2 pair
    assert!(TURN_SEQUENCE[7].pair_start);
    assert!(TURN_SEQUENCE[8].pair_end);
    assert_eq!(TURN_SEQUENCE[7].side, Side::Red);
    assert_eq!(TURN_SEQUENCE[8].side, Side::Red);
    // Slot 19: red pick2 (R5)
    assert_eq!(TURN_SEQUENCE[19].side, Side::Red);
    assert_eq!(TURN_SEQUENCE[19].action_type, ActionType::Pick);
    assert_eq!(TURN_SEQUENCE[19].phase, Phase::Pick2);
}

#[test]
fn pair_markers_at_expected_slots() {
    let pair_pairs: Vec<(usize, usize)> = (0..20)
        .filter(|&i| TURN_SEQUENCE[i].pair_start)
        .map(|i| (i, i + 1))
        .collect();
    assert_eq!(pair_pairs, vec![(7, 8), (9, 10), (17, 18)]);
}

#[test]
fn turn_index_equals_action_count() {
    let s = DraftState::default();
    assert_eq!(s.turn_index(), 0);

    let mut s = DraftState::default();
    s.blue_bans.push("Aatrox".into());
    assert_eq!(s.turn_index(), 1);
    s.red_bans.push("Renekton".into());
    assert_eq!(s.turn_index(), 2);
}

#[test]
fn mid_pair_state_is_valid() {
    let mut s = DraftState::default();
    // Fill bans (slots 0-5)
    for i in 0..6 {
        match TURN_SEQUENCE[i].side {
            Side::Blue => s.blue_bans.push(format!("ban{}", i)),
            Side::Red => s.red_bans.push(format!("ban{}", i)),
        }
    }
    // B1 (slot 6)
    s.blue_picks.push("B1".into());
    // R1 (slot 7) — pair_start
    s.red_picks.push("R1".into());
    assert_eq!(s.turn_index(), 8);
    assert!(TURN_SEQUENCE[s.turn_index()].pair_end);
}
