use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side, TURN_SEQUENCE};
use engine_core::search::{search, SearchParams};

#[test]
fn terminal_node_evaluated() {
    let mut state = DraftState::default();
    // Fill the draft to terminal (all 20 turns)
    for i in 0..20 {
        let id = format!("c{}", i);
        let turn = TURN_SEQUENCE[i];
        match (turn.action_type, turn.side) {
            (ActionType::Ban, Side::Blue) => state.blue_bans.push(id),
            (ActionType::Ban, Side::Red) => state.red_bans.push(id),
            (ActionType::Pick, Side::Blue) => state.blue_picks.push(id),
            (ActionType::Pick, Side::Red) => state.red_picks.push(id),
        }
    }
    let h = CancelHandle::new();
    let params = SearchParams::default();
    let result = search(&state, &params, &h);
    let tree = result.expect("terminal state must produce a tree");
    assert_eq!(tree.children.len(), 0, "terminal node has no children");
}
