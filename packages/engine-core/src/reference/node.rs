//! The one node classifier (design docs/designs/engine-reference-search-design.md R2). Both oracles and the
//! reference search call it, so an equal-horizon comparison between them cannot hide a classification
//! mismatch. Feasibility is a leaf INPUT, never a terminal (R1): it is read only when a node is a leaf.

use super::feasibility::{
    off_pool_count, pool_can_complete, side_feasible, FeasibilityMemo, FeasibilityRule,
};
use super::format::Slot;
use super::state::{Action, Pools, Position};
use super::universe::Universe;
use crate::draft_state::{ActionType, Side};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeafKind {
    /// No next slot.
    Complete,
    /// `turns_used ≥ horizon`.
    Horizon,
    /// The mover has no legal action and feasibility is on: that side is count-infeasible by
    /// construction (its pool net of the board is smaller than its remaining picks).
    DryPool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeafEnd {
    pub kind: LeafKind,
    pub blue_feasible: bool,
    pub red_feasible: bool,
    /// U10: off-pool picks made plus forced ones to come, per side (0 under `On` / `Off`).
    pub blue_off_pool: usize,
    pub red_off_pool: usize,
}

#[derive(Clone, Debug)]
pub enum NodeKind {
    Leaf(LeafEnd),
    /// Legal actions in canonical order (bans, picks, pairs; by index) — the caller orders them.
    Interior {
        slot: Slot,
        actions: Vec<Action>,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ClassifyError {
    #[error("no legal action at slot {slot} (a pool ran dry with feasibility off)")]
    NoLegalAction { slot: usize },
}

/// The legal actions under `rule` (slice-5 U10; B-proper § 1): `Position::legal_actions` (the D4 gate),
/// except that under `PoolOrRoster` a pick slot whose mover's pool can no longer complete its comp
/// draws from everything available instead, and under `Roster` every pick slot does (the pool prices,
/// never gates). The one place the widening happens; the oracle's and the search's root checks and
/// `classify` all go through it.
pub fn legal_actions_under(
    position: &Position<'_>,
    universe: &Universe,
    pools: &Pools,
    rule: FeasibilityRule,
    memo: &mut FeasibilityMemo,
) -> Vec<Action> {
    if let Some(slot) = position.next_slot() {
        let widened = match rule {
            FeasibilityRule::On | FeasibilityRule::Off => false,
            FeasibilityRule::PoolOrRoster => {
                slot.action == ActionType::Pick
                    && !pool_can_complete(memo, rule, slot.side, position, pools, universe)
            }
            FeasibilityRule::Roster => slot.action == ActionType::Pick,
        };
        if widened {
            return position.pick_actions_from(position.available(universe));
        }
    }
    position.legal_actions(universe, pools)
}

/// Fixed order: (1) draft complete → leaf; (2) horizon reached → leaf; (3) no legal action → leaf when
/// feasibility is `on` or a live rule (under those only an exhausted roster gets here), error when
/// `off` (an authoring mistake, as in slice 3); (4) interior. `turns_used` counts turns below the
/// search root (a pair is one); `horizon = None` is the full remainder.
pub fn classify(
    position: &Position<'_>,
    turns_used: usize,
    horizon: Option<usize>,
    universe: &Universe,
    pools: &Pools,
    rule: FeasibilityRule,
    memo: &mut FeasibilityMemo,
) -> Result<NodeKind, ClassifyError> {
    let leaf = |kind: LeafKind, memo: &mut FeasibilityMemo| {
        let blue_feasible = side_feasible(memo, rule, Side::Blue, position, pools, universe);
        let red_feasible = side_feasible(memo, rule, Side::Red, position, pools, universe);
        let blue_off_pool = off_pool_count(memo, rule, Side::Blue, position, pools, universe);
        let red_off_pool = off_pool_count(memo, rule, Side::Red, position, pools, universe);
        NodeKind::Leaf(LeafEnd {
            kind,
            blue_feasible,
            red_feasible,
            blue_off_pool,
            red_off_pool,
        })
    };
    let Some(slot) = position.next_slot() else {
        return Ok(leaf(LeafKind::Complete, memo));
    };
    if horizon.is_some_and(|h| turns_used >= h) {
        return Ok(leaf(LeafKind::Horizon, memo));
    }
    let actions = legal_actions_under(position, universe, pools, rule, memo);
    if actions.is_empty() {
        return match rule {
            // Under a live rule only an exhausted ROSTER gets here: a leaf, both sides read off it.
            FeasibilityRule::On | FeasibilityRule::PoolOrRoster | FeasibilityRule::Roster => {
                Ok(leaf(LeafKind::DryPool, memo))
            }
            FeasibilityRule::Off => Err(ClassifyError::NoLegalAction {
                slot: position.slot_index(),
            }),
        };
    }
    Ok(NodeKind::Interior { slot, actions })
}
