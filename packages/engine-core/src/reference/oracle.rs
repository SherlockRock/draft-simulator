//! The two exact oracles (design § 4, D2): plain full-width minimax on a Blue-perspective
//! value — the mover's slot takes max (Blue) or min (Red), no negation (S1) — either to the end
//! of the draft or to a fixed number of turns with the static utility at the horizon. No
//! pruning, no shortlists, no memoisation of the search (S6); node classification is shared with
//! the reference search (`node::classify`); feasibility is a leaf input, never a terminal
//! (slice-4 R1). The reference search (`super::search`) is compared against
//! `evaluate(.., Horizon(h))` at every h.

use super::feasibility::{side_feasible, FeasibilityMemo, FeasibilityRule, Price};
use super::node::{classify, legal_actions_under, ClassifyError, LeafEnd, NodeKind};
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
    /// Blue-perspective, as `Evaluation::value`: Blue maximises, Red minimises, so Red's best
    /// action carries the most negative value.
    pub value: f64,
}

#[derive(Clone, Debug)]
pub struct Evaluation {
    pub mover: Side,
    /// The root's minimax value, Blue-perspective: Blue maximises, Red minimises, so Red's best
    /// action carries the most negative value.
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
    /// A side is already infeasible at the root; there is no decision to rank (a mis-authored fixture).
    #[error(
        "the root is already infeasible: blue_feasible={blue_feasible}, red_feasible={red_feasible}"
    )]
    RootInfeasible {
        blue_feasible: bool,
        red_feasible: bool,
    },
    #[error("a horizon of 0 evaluates the root and decides nothing")]
    HorizonZero,
    /// `OracleInput::off_pool_cost` does not fit the rule (B-proper design § 1).
    #[error("off_pool_cost: {reason}")]
    OffPoolCost { reason: String },
    /// `OracleInput::off_role_cost` does not fit the rule, or P + Q exceeds L (engine-role-grade G4).
    #[error("off_role_cost: {reason}")]
    OffRoleCost { reason: String },
    /// A role-tagged pool where role tags are not read (role-aware pools design § 1).
    #[error("role tags: {reason}")]
    RoleTags { reason: String },
}

impl From<ClassifyError> for OracleError {
    fn from(err: ClassifyError) -> Self {
        match err {
            ClassifyError::NoLegalAction { slot } => OracleError::NoLegalAction { slot },
        }
    }
}

pub struct OracleInput<'a> {
    pub position: &'a Position<'a>,
    pub universe: &'a Universe,
    pub pools: &'a Pools,
    pub objective: &'a dyn Objective,
    pub feasibility: FeasibilityRule,
    pub mode: Mode,
    pub epsilon: f64,
    /// P, the flat cost of one off-pool pick, in the objective's unit (blue-win logits on the live
    /// universe). Read under `FeasibilityRule::Roster` ONLY, where it is required; every other rule
    /// refuses a value (`OracleError::OffPoolCost`): `PoolOrRoster` prices at `Universe::off_pool_cost()`
    /// = L by construction and the gate rules have no off-pool picks. A silently ignored value would
    /// be the trap review round 5 removed from `Objective::value_under`.
    pub off_pool_cost: Option<f64>,
    /// Q, the graded off-role cost per 100 grade units (engine-role-grade design G4), in the
    /// objective's unit: a champion placed outside its pool entries in a secondary meta role pays
    /// `grade · Q / 100` beside P. Read under `FeasibilityRule::Roster` ONLY, where it is required
    /// (`DEFAULT_OFF_ROLE_COST` is the assumption); every other rule refuses a value
    /// (`OracleError::OffRoleCost`): `PoolOrRoster` charges Q = 0 by design (G3) and the gate rules
    /// price nothing. Validated with P: finite, ≥ 0, and P + Q ≤ L, which keeps the live band L'
    /// separating (feasible live leaves span `board ± 5 · (P + Q)`).
    pub off_role_cost: Option<f64>,
}

/// The P this search prices off-pool picks at, from the rule and `OracleInput::off_pool_cost`
/// (B-proper design § 1): `Roster` → the input's value, required, finite, in `[0, L]` (L' = L + 10·L
/// separates the bands for every P up to L, and above L the cost would exceed Tier A's own
/// infeasibility band); `PoolOrRoster` → `Universe::off_pool_cost()` (= L, lexicographic); `On` /
/// `Off` → 0 (the counts are 0); a value under any of these three is refused.
pub fn resolve_off_pool_cost(input: &OracleInput<'_>) -> Result<f64, OracleError> {
    let refuse = |reason: String| OracleError::OffPoolCost { reason };
    match (input.feasibility, input.off_pool_cost) {
        (FeasibilityRule::Roster, Some(p)) => {
            let l = input.universe.loss();
            if !p.is_finite() {
                Err(refuse(format!("{p} is not finite")))
            } else if p < 0.0 {
                Err(refuse(format!("{p} is negative")))
            } else if p > l {
                Err(refuse(format!("{p} exceeds L = {l}")))
            } else {
                Ok(p)
            }
        }
        (FeasibilityRule::Roster, None) => Err(refuse(
            "required under roster (DEFAULT_OFF_POOL_COST is the B5 assumption)".to_string(),
        )),
        (FeasibilityRule::PoolOrRoster, None) => Ok(input.universe.off_pool_cost()),
        (FeasibilityRule::On | FeasibilityRule::Off, None) => Ok(0.0),
        (rule, Some(_)) => Err(refuse(format!(
            "not read under {rule:?}: pool_or_roster prices at P = L itself and the gate rules have no off-pool picks"
        ))),
    }
}

/// The Q this search grades off-role placements at, from the rule, `OracleInput::off_role_cost` and
/// the resolved P (engine-role-grade design G4): `Roster` → the input's value, required, finite, ≥ 0
/// and with `p + q ≤ L` (the message names both); `PoolOrRoster` / `On` / `Off` → 0 (Q is not read
/// there; the gate rules price nothing); a value under any of these three is refused.
pub fn resolve_off_role_cost(input: &OracleInput<'_>, p: f64) -> Result<f64, OracleError> {
    let refuse = |reason: String| OracleError::OffRoleCost { reason };
    match (input.feasibility, input.off_role_cost) {
        (FeasibilityRule::Roster, Some(q)) => {
            let l = input.universe.loss();
            if !q.is_finite() {
                Err(refuse(format!("{q} is not finite")))
            } else if q < 0.0 {
                Err(refuse(format!("{q} is negative")))
            } else if p + q > l {
                Err(refuse(format!(
                    "P + Q = {p} + {q} exceeds L = {l}: the live band L' = L + 10·L separates feasible leaves only while P + Q ≤ L"
                )))
            } else {
                Ok(q)
            }
        }
        (FeasibilityRule::Roster, None) => Err(refuse(
            "required under roster (DEFAULT_OFF_ROLE_COST is the assumption)".to_string(),
        )),
        (FeasibilityRule::PoolOrRoster | FeasibilityRule::On | FeasibilityRule::Off, None) => Ok(0.0),
        (rule, Some(_)) => Err(refuse(format!(
            "not read under {}: pool_or_roster charges Q = 0 by design and the gate rules price nothing",
            rule.wire_name()
        ))),
    }
}

/// Role tags are read under a live rule on a five-pick comp and nowhere else (role-aware pools design
/// § 1). The gate rules have no price, so an off-role pick from a tagged pool would be legal and free
/// there — the defect the tags exist to remove — and off five picks the completion predicate is not
/// defined. Refused here, beside the check on P, so no search or oracle run ever reads a tagged pool
/// as its set without saying so.
pub fn check_role_tags(input: &OracleInput<'_>) -> Result<(), OracleError> {
    for side in [Side::Blue, Side::Red] {
        let Some(tags) = input.pools.roles(side) else {
            continue;
        };
        if tags.union() != input.pools.for_side(side) {
            return Err(OracleError::RoleTags {
                reason: format!(
                    "{side:?}'s pool is role-tagged but its set is not the union of its tags: build it with Pools::with_roles"
                ),
            });
        }
        if !input.feasibility.is_live() {
            return Err(OracleError::RoleTags {
                reason: format!(
                    "{side:?}'s pool is role-tagged under {}: role tags are priced by the live rules (pool_or_roster, roster); the gate takes list form",
                    input.feasibility.wire_name()
                ),
            });
        }
        let picks = input.position.format().picks_per_side(side);
        if picks != 5 {
            return Err(OracleError::RoleTags {
                reason: format!(
                    "{side:?}'s pool is role-tagged and {side:?} picks {picks}: role tags need a five-pick comp"
                ),
            });
        }
    }
    Ok(())
}

struct Search<'a> {
    input: &'a OracleInput<'a>,
    memo: FeasibilityMemo,
    off_pool_cost: f64,
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

    fn leaf(&mut self, position: &Position<'_>, end: LeafEnd) -> f64 {
        self.leaves += 1;
        self.input.objective.value_under(
            &Leaf {
                blue: position.picks(Side::Blue),
                red: position.picks(Side::Red),
                blue_feasible: end.blue_feasible,
                red_feasible: end.red_feasible,
            },
            self.input.feasibility,
            self.off_pool_cost,
            end.blue_off_pool,
            end.red_off_pool,
        )
    }

    /// Minimax value of `position`, `turns_used` turns below the root.
    fn value(&mut self, position: &Position<'_>, turns_used: usize) -> Result<f64, OracleError> {
        self.nodes += 1;
        let horizon = match self.input.mode {
            Mode::FullRemainder => None,
            Mode::Horizon(h) => Some(h),
        };
        let (slot, actions) = match classify(
            position,
            turns_used,
            horizon,
            self.input.universe,
            self.input.pools,
            self.input.feasibility,
            &mut self.memo,
        )? {
            NodeKind::Leaf(end) => return Ok(self.leaf(position, end)),
            NodeKind::Interior { slot, actions } => (slot, actions),
        };
        let mut best: Option<f64> = None;
        for action in actions {
            let v = self.value(&position.apply(action), turns_used + 1)?;
            best = Some(match (best, slot.side) {
                (None, _) => v,
                (Some(b), Side::Blue) => b.max(v),
                (Some(b), Side::Red) => b.min(v),
            });
        }
        Ok(best.expect("Interior carries at least one action"))
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
    let off_pool_cost = resolve_off_pool_cost(input)?;
    let off_role_cost = resolve_off_role_cost(input, off_pool_cost)?;
    check_role_tags(input)?;

    let started = Instant::now();
    // The oracle's ONLY memo: priced, so every leaf and key below reads this search's (P, Q).
    let mut search = Search {
        input,
        memo: FeasibilityMemo::new(Price::of(off_pool_cost, off_role_cost)),
        off_pool_cost,
        leaves: 0,
        nodes: 0,
    };
    // A root where a side is already infeasible has nothing to rank under the gate (R1 keeps this as an
    // error). Checked before action generation: a starved root is "infeasible", not "no legal action".
    // Under a live rule (U10, B-proper) a broken locked side is a fact on the board and the root is
    // ranked, that side priced at L' on every leaf (search.rs says why).
    let (blue_feasible, red_feasible) = (
        search.feasible(Side::Blue, position),
        search.feasible(Side::Red, position),
    );
    let gated = !input.feasibility.is_live();
    if gated && !(blue_feasible && red_feasible) {
        return Err(OracleError::RootInfeasible {
            blue_feasible,
            red_feasible,
        });
    }
    let actions = legal_actions_under(
        position,
        input.universe,
        input.pools,
        input.feasibility,
        &mut search.memo,
    );
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
