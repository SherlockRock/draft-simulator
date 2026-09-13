//! The two exact oracles (design § 4, D2): plain full-width minimax on a Blue-perspective
//! value — the mover's slot takes max (Blue) or min (Red), no negation (S1) — either to the end
//! of the draft or to a fixed number of turns with the static utility at the horizon. No
//! pruning, no shortlists, no memoisation of the search (S6); feasibility is checked at every
//! node (S5) and infeasibility is terminal (D3 ii).

use super::feasibility::{side_feasible, FeasibilityMemo, FeasibilityRule};
use super::objective::{Leaf, Objective};
use super::state::{Action, Pools, Position};
use super::universe::Universe;
use crate::draft_state::Side;
use std::time::{Duration, Instant};

/// D2: full-remainder search is feasible at ≤ 7 turns on ≤ 12 available champions. Asserted at
/// the root for both modes — a horizon oracle at eight turns costs the same as a full remainder.
pub const MAX_TURNS: usize = 7;
pub const MAX_AVAILABLE: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    FullRemainder,
    /// Static utility after this many turns from the root (a pair is one turn).
    Horizon(usize),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActionValue {
    pub action: Action,
    pub value: f64,
}

#[derive(Clone, Debug)]
pub struct Evaluation {
    pub mover: Side,
    /// The root's minimax value.
    pub value: f64,
    /// Every legal root action, best-first for the mover; ties in canonical action order.
    pub ranked: Vec<ActionValue>,
    /// Actions within `epsilon` of the best, in canonical order.
    pub top_set: Vec<Action>,
    /// Calls to `Objective::value`.
    pub leaves: u64,
    /// Positions visited below the root (its children included, itself not).
    pub nodes: u64,
    pub elapsed: Duration,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OracleError {
    #[error("{explored} turns to explore exceeds the bound of {max}")]
    TurnsExceedBound { explored: usize, max: usize },
    #[error("{available} champions available exceeds the bound of {max}")]
    AvailableExceedsBound { available: usize, max: usize },
    #[error("no legal action at slot {slot} (a pool ran dry with feasibility off)")]
    NoLegalAction { slot: usize },
    #[error("the draft is complete")]
    DraftComplete,
    /// The root itself is terminal by D3 ii; there is no decision to rank (a mis-authored fixture).
    #[error(
        "the root is already terminal: blue_feasible={blue_feasible}, red_feasible={red_feasible}"
    )]
    RootTerminal {
        blue_feasible: bool,
        red_feasible: bool,
    },
    #[error("a horizon of 0 evaluates the root and decides nothing")]
    HorizonZero,
}

pub struct OracleInput<'a> {
    pub position: &'a Position<'a>,
    pub universe: &'a Universe,
    pub pools: &'a Pools,
    pub objective: &'a dyn Objective,
    pub feasibility: FeasibilityRule,
    pub mode: Mode,
    pub epsilon: f64,
}

struct Search<'a> {
    input: &'a OracleInput<'a>,
    memo: FeasibilityMemo,
    leaves: u64,
    nodes: u64,
}

impl Search<'_> {
    fn feasible(&mut self, side: Side, position: &Position<'_>) -> bool {
        side_feasible(
            &mut self.memo,
            self.input.feasibility,
            side,
            position,
            self.input.pools,
            self.input.universe,
        )
    }

    fn leaf(&mut self, position: &Position<'_>, blue_feasible: bool, red_feasible: bool) -> f64 {
        self.leaves += 1;
        self.input.objective.value(&Leaf {
            blue: position.picks(Side::Blue),
            red: position.picks(Side::Red),
            blue_feasible,
            red_feasible,
        })
    }

    /// Minimax value of `position`, `turns_used` turns below the root.
    fn value(&mut self, position: &Position<'_>, turns_used: usize) -> Result<f64, OracleError> {
        self.nodes += 1;
        let blue_feasible = self.feasible(Side::Blue, position);
        let red_feasible = self.feasible(Side::Red, position);
        if !(blue_feasible && red_feasible) {
            return Ok(self.leaf(position, blue_feasible, red_feasible));
        }
        let Some(slot) = position.next_slot() else {
            return Ok(self.leaf(position, true, true));
        };
        if let Mode::Horizon(h) = self.input.mode {
            if turns_used >= h {
                return Ok(self.leaf(position, true, true));
            }
        }
        let actions = position.legal_actions(self.input.universe, self.input.pools);
        if actions.is_empty() {
            return Err(OracleError::NoLegalAction {
                slot: position.slot_index(),
            });
        }
        let mut best: Option<f64> = None;
        for action in actions {
            let v = self.value(&position.apply(action), turns_used + 1)?;
            best = Some(match (best, slot.side) {
                (None, _) => v,
                (Some(b), Side::Blue) => b.max(v),
                (Some(b), Side::Red) => b.min(v),
            });
        }
        Ok(best.expect("actions is non-empty, checked above"))
    }
}

pub fn evaluate(input: &OracleInput<'_>) -> Result<Evaluation, OracleError> {
    let position = input.position;
    let Some(root) = position.next_slot() else {
        return Err(OracleError::DraftComplete);
    };
    let remaining = position.format().turns_remaining(position.slot_index());
    let explored = match input.mode {
        Mode::FullRemainder => remaining,
        Mode::Horizon(h) => h.min(remaining),
    };
    if explored > MAX_TURNS {
        return Err(OracleError::TurnsExceedBound {
            explored,
            max: MAX_TURNS,
        });
    }
    let available = position.available(input.universe).len();
    if available > MAX_AVAILABLE {
        return Err(OracleError::AvailableExceedsBound {
            available,
            max: MAX_AVAILABLE,
        });
    }
    if input.mode == Mode::Horizon(0) {
        return Err(OracleError::HorizonZero);
    }

    let started = Instant::now();
    let mut search = Search {
        input,
        memo: FeasibilityMemo::default(),
        leaves: 0,
        nodes: 0,
    };
    // The root is subject to the same terminal rule as every other node (D3 ii), and — as at every node —
    // the terminal check comes BEFORE action generation: a starved root is "terminal", not "no legal action".
    let (blue_feasible, red_feasible) = (
        search.feasible(Side::Blue, position),
        search.feasible(Side::Red, position),
    );
    if !(blue_feasible && red_feasible) {
        return Err(OracleError::RootTerminal {
            blue_feasible,
            red_feasible,
        });
    }
    let actions = position.legal_actions(input.universe, input.pools);
    if actions.is_empty() {
        return Err(OracleError::NoLegalAction {
            slot: position.slot_index(),
        });
    }
    let mut ranked = Vec::with_capacity(actions.len());
    for action in actions {
        let value = search.value(&position.apply(action), 1)?;
        ranked.push(ActionValue { action, value });
    }
    ranked.sort_by(|x, y| {
        let by_value = match root.side {
            Side::Blue => y.value.partial_cmp(&x.value),
            Side::Red => x.value.partial_cmp(&y.value),
        };
        by_value
            .expect("leaf values are finite")
            .then(x.action.cmp(&y.action))
    });
    let value = ranked[0].value;
    let mut top_set: Vec<Action> = ranked
        .iter()
        .filter(|av| (av.value - value).abs() <= input.epsilon)
        .map(|av| av.action)
        .collect();
    top_set.sort();

    Ok(Evaluation {
        mover: root.side,
        value,
        ranked,
        top_set,
        leaves: search.leaves,
        nodes: search.nodes,
        elapsed: started.elapsed(),
    })
}
