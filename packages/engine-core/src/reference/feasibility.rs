//! D3 ii through the incumbent predicate, verbatim (design § 4, S4, S5). The predicate is only
//! defined at five picks a side (`crate::feasibility::can_complete_roles` returns `true` for
//! any other total); `FeasibilityRule::Off` is how a fixture on a shorter format says so.

use super::state::{Pools, Position};
use super::universe::{ChampionSet, Universe};
use crate::draft_state::Side;
use crate::feasibility::can_complete_roles;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeasibilityRule {
    On,
    Off,
}

/// Memo keyed on `(side, locked bitmask, pool-net bitmask)`. Both sets are monotone along any
/// line of play, so the key identifies the predicate's inputs exactly — but only for a fixed
/// universe and a fixed format: the key carries no identity for either, so a memo must never be
/// shared across a different universe or a different format.
#[derive(Debug, Default)]
pub struct FeasibilityMemo {
    memo: HashMap<(Side, u32, u32), bool>,
    pub calls: u64,
    pub misses: u64,
}

/// Can `side` still complete five roles? locked = its picks; pool = its pool net of everything
/// on the board; remaining = the format's picks for the side minus the locked count.
pub fn side_feasible(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> bool {
    if rule == FeasibilityRule::Off {
        return true;
    }
    memo.calls += 1;
    let locked = position.picks(side);
    let locked_set: ChampionSet = locked.iter().copied().collect();
    let pool_net = pools.for_side(side).intersect(position.available(universe));
    let key = (side, locked_set.bits(), pool_net.bits());
    if let Some(&known) = memo.memo.get(&key) {
        return known;
    }
    memo.misses += 1;
    // == picks_per_side(side) − locked.len() for any position the loader accepted; counted from the
    // next slot so a mid-pair root's completing pick is included.
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    let feasible = can_complete_roles(
        &universe.names(locked),
        &universe.names_of(pool_net),
        remaining,
        universe.champion_meta(),
    );
    memo.memo.insert(key, feasible);
    feasible
}
