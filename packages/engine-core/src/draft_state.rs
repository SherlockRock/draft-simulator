use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side {
    Blue,
    Red,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ActionType {
    Ban,
    Pick,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Phase {
    Ban1,
    Pick1,
    Ban2,
    Pick2,
}

#[derive(Clone, Copy, Debug)]
pub struct TurnInfo {
    pub side: Side,
    pub action_type: ActionType,
    pub phase: Phase,
    pub pair_start: bool,
    pub pair_end: bool,
}

const fn t(
    side: Side,
    action_type: ActionType,
    phase: Phase,
    pair_start: bool,
    pair_end: bool,
) -> TurnInfo {
    TurnInfo {
        side,
        action_type,
        phase,
        pair_start,
        pair_end,
    }
}

pub const TURN_SEQUENCE: [TurnInfo; 20] = [
    t(Side::Blue, ActionType::Ban, Phase::Ban1, false, false),
    t(Side::Red, ActionType::Ban, Phase::Ban1, false, false),
    t(Side::Blue, ActionType::Ban, Phase::Ban1, false, false),
    t(Side::Red, ActionType::Ban, Phase::Ban1, false, false),
    t(Side::Blue, ActionType::Ban, Phase::Ban1, false, false),
    t(Side::Red, ActionType::Ban, Phase::Ban1, false, false),
    t(Side::Blue, ActionType::Pick, Phase::Pick1, false, false),
    t(Side::Red, ActionType::Pick, Phase::Pick1, true, false),
    t(Side::Red, ActionType::Pick, Phase::Pick1, false, true),
    t(Side::Blue, ActionType::Pick, Phase::Pick1, true, false),
    t(Side::Blue, ActionType::Pick, Phase::Pick1, false, true),
    t(Side::Red, ActionType::Pick, Phase::Pick1, false, false),
    t(Side::Red, ActionType::Ban, Phase::Ban2, false, false),
    t(Side::Blue, ActionType::Ban, Phase::Ban2, false, false),
    t(Side::Red, ActionType::Ban, Phase::Ban2, false, false),
    t(Side::Blue, ActionType::Ban, Phase::Ban2, false, false),
    t(Side::Red, ActionType::Pick, Phase::Pick2, false, false),
    t(Side::Blue, ActionType::Pick, Phase::Pick2, true, false),
    t(Side::Blue, ActionType::Pick, Phase::Pick2, false, true),
    t(Side::Red, ActionType::Pick, Phase::Pick2, false, false),
];

pub const TOTAL_TURNS: usize = TURN_SEQUENCE.len();

#[derive(Clone, Debug, Default)]
pub struct DraftState {
    pub blue_bans: Vec<String>,
    pub red_bans: Vec<String>,
    pub blue_picks: Vec<String>,
    pub red_picks: Vec<String>,
}

impl DraftState {
    pub fn turn_index(&self) -> usize {
        self.blue_bans.len() + self.red_bans.len() + self.blue_picks.len() + self.red_picks.len()
    }

    pub fn current_turn(&self) -> Option<TurnInfo> {
        TURN_SEQUENCE.get(self.turn_index()).copied()
    }

    pub fn is_complete(&self) -> bool {
        self.turn_index() >= TOTAL_TURNS
    }
}
