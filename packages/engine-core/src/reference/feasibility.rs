//! D3 ii through the incumbent predicate, verbatim (design § 4, S4, S5). The predicate is only
//! defined at five picks a side (`crate::feasibility::can_complete_roles` returns `true` for
//! any other total); `FeasibilityRule::Off` is how a fixture on a shorter format says so.

use super::state::{Pools, Position};
use super::universe::{ChampionSet, Universe};
use crate::draft_state::Side;
use crate::feasibility::{can_complete_roles, max_role_matching};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeasibilityRule {
    /// The hard gate (D4 as approved; the Tier A fixtures that declare it — 06a, 06b and five
    /// probes declare `off`): picks come from the pool only, and a side whose pool cannot complete
    /// its comp is infeasible.
    On,
    Off,
    /// The live rule (slice-5 U10, D4 as amended): a side draws from its pool while the pool can
    /// still complete its comp, and from the whole roster once it cannot (count or roles), each
    /// off-pool pick — made, or forced still to come — costing a flat P (`Universe::off_pool_cost`,
    /// charged at the leaf from `off_pool_count`). Infeasible only when the roster cannot complete it either, priced with
    /// the wider band L' (`Universe::live_loss`) so that no comp is worth breaking to save P.
    PoolOrRoster,
    /// B-proper (design `engine-b-proper-design.md` § 1, D4 amended a second time): the pool PRICES
    /// and never gates. Every pick node fans to everything available; each off-pool pick — made, or
    /// forced still to come — costs the search's P (`OracleInput::off_pool_cost`, board-scale, so a
    /// strong roster champion can be worth its cost); a side is infeasible only when the roster
    /// cannot complete it, priced at L'. The rule the calibration report sweeps P under.
    Roster,
}

impl FeasibilityRule {
    /// The two live rules — the ones with an off-pool term, an L' band and a ranked (never refused)
    /// root; `On` and `Off` are Tier A's gate.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            FeasibilityRule::PoolOrRoster | FeasibilityRule::Roster
        )
    }
}

/// Memo keyed on `(side, locked set, candidate set)` — the candidates are the pool net of the board,
/// or everything available under `PoolOrRoster`'s roster query. Both sets are monotone along any
/// line of play, so the key identifies the predicate's inputs exactly — but only for a fixed
/// universe and a fixed format: the key carries no identity for either, so a memo must never be
/// shared across a different universe or a different format. `ranks` memoises the role-matching
/// size of `locked ∪ candidates` on the same key (U10's forced-pick count); `locked` memoises, on
/// the locked set alone, whether the locked picks can be matched at all — the predicate's first
/// test, and the whole answer when they cannot (round 5: at the sample's slot 7 the 238 Red pairs
/// of two sole-ADCs are queried against the roster at every leaf below them, `available` differs
/// per leaf, and each miss ran the string predicate over ≈ 165 names — the live rule cost 2× the
/// gate's time and memory for that alone).
#[derive(Debug, Default)]
pub struct FeasibilityMemo {
    memo: HashMap<(Side, ChampionSet, ChampionSet), bool>,
    ranks: HashMap<(Side, ChampionSet, ChampionSet), usize>,
    locked: HashMap<(Side, ChampionSet), bool>,
    pub calls: u64,
    pub misses: u64,
}

/// Can `side` still complete five roles? locked = its picks; `On`: from its pool net of everything
/// on the board; `PoolOrRoster`: from that pool, or failing that from everything available (U10);
/// `Roster`: from everything available (the pool never gates).
pub fn side_feasible(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> bool {
    match rule {
        FeasibilityRule::Off => true,
        FeasibilityRule::On => pool_can_complete(memo, side, position, pools, universe),
        FeasibilityRule::PoolOrRoster => {
            pool_can_complete(memo, side, position, pools, universe)
                || can_complete_from(memo, side, position, position.available(universe), universe)
        }
        FeasibilityRule::Roster => {
            can_complete_from(memo, side, position, position.available(universe), universe)
        }
    }
}

/// Can `side` complete its comp from its own pool net of the board? Under `PoolOrRoster` this is
/// also the widening test: `false` at a pick slot means the side draws from the roster (U10).
pub fn pool_can_complete(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> bool {
    let pool_net = pools.for_side(side).intersect(position.available(universe));
    can_complete_from(memo, side, position, pool_net, universe)
}

/// U10's off-pool count for `side` at a leaf: off-pool picks already made (picks outside the side's
/// pool — the pool includes its own board picks at the root, so only picks made in the search count)
/// plus a lower bound on the forced ones still to come: 0 when the pool can complete, 0 when the
/// ROSTER cannot complete either (the L' band prices that; no off-pool pick would help), else the
/// number of the side's roles the pool cannot cover — `remaining − (rank(locked ∪ pool net) −
/// |locked|)`, the largest number of in-pool picks any completion can still hold (the transversal
/// matroid's contraction rank, so a pool short by two roles but long on champions is charged 2, and
/// a pool short by count is charged its count shortfall). A lower bound because the opponent can only
/// remove pool champions; exact once the side's picks are complete. Charged at the leaf so a short
/// horizon cannot hide the cost of a pool that can no longer finish. Zero under `On` / `Off`; the
/// forced part is zero wherever the pool suffices (picks already made off-pool stay charged), so the
/// live rule and the gate give identical values until a pool actually runs out. Under `Roster` the
/// same count: the pool prices instead of gating, so `made` also holds picks the search CHOSE off-pool.
pub fn off_pool_count(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> usize {
    if !rule.is_live() {
        return 0;
    }
    let pool = pools.for_side(side);
    let made = position
        .picks(side)
        .iter()
        .filter(|c| !pool.contains(**c))
        .count();
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    let forced = if remaining == 0
        || pool_can_complete(memo, side, position, pools, universe)
        || !can_complete_from(memo, side, position, position.available(universe), universe)
    {
        0
    } else {
        // The roster can complete, so the locked picks form a matching and every matchable
        // `locked ∪ S` (S in the pool) extends to a full comp from the roster; the most in-pool
        // picks a completion can hold is therefore `rank(locked ∪ pool net) − |locked|`.
        let pool_net = pool.intersect(position.available(universe));
        let rank = role_rank(memo, side, position, pool_net, universe);
        remaining.saturating_sub(rank.saturating_sub(position.picks(side).len()))
    };
    made + forced
}

/// The size of the largest role assignment over `locked ∪ candidates`, memoised like the predicate.
fn role_rank(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    candidates: ChampionSet,
    universe: &Universe,
) -> usize {
    let locked = position.picks(side);
    let locked_set: ChampionSet = locked.iter().copied().collect();
    let key = (side, locked_set, candidates);
    if let Some(&known) = memo.ranks.get(&key) {
        return known;
    }
    let mut names = universe.names(locked);
    names.extend(universe.names_of(candidates));
    let rank = max_role_matching(&names, universe.champion_meta());
    memo.ranks.insert(key, rank);
    rank
}

/// The predicate on an explicit candidate set, memoised on `(side, locked set, candidate set)`.
fn can_complete_from(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    candidates: ChampionSet,
    universe: &Universe,
) -> bool {
    memo.calls += 1;
    let locked = position.picks(side);
    let locked_set: ChampionSet = locked.iter().copied().collect();
    let key = (side, locked_set, candidates);
    if let Some(&known) = memo.memo.get(&key) {
        return known;
    }
    memo.misses += 1;
    // == picks_per_side(side) − locked.len() for any position the loader accepted; counted from the
    // next slot so a mid-pair root's completing pick is included.
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    // Fast path: on a five-pick comp, locked picks that cannot be matched among themselves are
    // infeasible whatever the candidates (the predicate's own first test, `can_complete_roles`), so
    // the answer is memoised on the locked set alone and the candidates are never named. Exactly the
    // predicate's result; only its cost changes.
    if locked.len() + remaining == 5 {
        let locked_ok = match memo.locked.get(&(side, locked_set)) {
            Some(&ok) => ok,
            None => {
                let ok = max_role_matching(&universe.names(locked), universe.champion_meta())
                    == locked.len();
                memo.locked.insert((side, locked_set), ok);
                ok
            }
        };
        if !locked_ok {
            memo.memo.insert(key, false);
            return false;
        }
    }
    let feasible = can_complete_roles(
        &universe.names(locked),
        &universe.names_of(candidates),
        remaining,
        universe.champion_meta(),
    );
    memo.memo.insert(key, feasible);
    feasible
}
