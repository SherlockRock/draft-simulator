//! D3 ii through the incumbent predicate, verbatim (design § 4, S4, S5). The predicate is only
//! defined at five picks a side (`crate::feasibility::can_complete_roles` returns `true` for
//! any other total); `FeasibilityRule::Off` is how a fixture on a shorter format says so.

use super::state::{Pools, Position, RoleSets};
use super::universe::{ChampionIdx, ChampionSet, Universe};
use crate::draft_state::Side;
use crate::feasibility::{
    can_complete_masks, can_complete_roles, max_matching_masks, max_role_assignment,
    max_role_matching, RoleMask,
};
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

    /// The wire's lowercase spelling (`#[serde(rename_all = "snake_case")]` above), for messages that
    /// otherwise read the rule alongside "on" and "off" — never Debug's `PoolOrRoster`/`Roster`.
    pub fn wire_name(self) -> &'static str {
        match self {
            FeasibilityRule::On => "on",
            FeasibilityRule::Off => "off",
            FeasibilityRule::PoolOrRoster => "pool_or_roster",
            FeasibilityRule::Roster => "roster",
        }
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
/// gate's time and memory for that alone). `critical` memoises `critical_pool` on `(side, locked set,
/// pool net)` (the snipe-aware key, design `engine-snipe-key-design.md` § 2). No key carries the pools:
/// a role-tagged side (`tags_for`) answers `locked` and `memo` on its own playable masks, so a memo
/// must never be shared across different pools either — one per search, as the search and the oracle
/// build it.
#[derive(Debug, Default)]
pub struct FeasibilityMemo {
    memo: HashMap<(Side, ChampionSet, ChampionSet), bool>,
    ranks: HashMap<(Side, ChampionSet, ChampionSet), usize>,
    locked: HashMap<(Side, ChampionSet), bool>,
    critical: HashMap<(Side, ChampionSet, ChampionSet), ChampionSet>,
    pub calls: u64,
    pub misses: u64,
}

/// `side`'s role tags where they are read (role-aware pools design § 1): the pool carries them, the
/// rule is a live one and the side picks five. Everywhere else the side is its set and every reader
/// runs the list-form code — which is what keeps a list pool bit-identical, and what makes the public
/// helpers total; a search or an oracle run refuses the other cases up front
/// (`oracle::check_role_tags`).
pub fn tags_for<'p>(
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &'p Pools,
) -> Option<&'p RoleSets> {
    if rule.is_live() {
        live_tags(side, position, pools)
    } else {
        None
    }
}

/// `tags_for` where the caller is already on a live rule's path.
fn live_tags<'p>(side: Side, position: &Position<'_>, pools: &'p Pools) -> Option<&'p RoleSets> {
    pools
        .roles(side)
        .filter(|_| position.format().picks_per_side(side) == 5)
}

/// RA4: the roles `c` can fill for a role-tagged side — the meta's, plus the ones the side's own pool
/// lists for it. Per side: the other side's entries never widen it.
fn playable(tags: &RoleSets, universe: &Universe, c: ChampionIdx) -> RoleMask {
    universe.role_mask(c) | tags.mask(c)
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
    let tags = tags_for(rule, side, position, pools);
    let roster = |memo: &mut FeasibilityMemo| {
        can_complete_from(
            memo,
            side,
            position,
            position.available(universe),
            tags,
            universe,
        )
    };
    match rule {
        FeasibilityRule::Off => true,
        FeasibilityRule::On => pool_can_complete(memo, rule, side, position, pools, universe),
        FeasibilityRule::PoolOrRoster => {
            pool_can_complete(memo, rule, side, position, pools, universe) || roster(memo)
        }
        FeasibilityRule::Roster => roster(memo),
    }
}

/// Can `side` complete its comp from its own pool net of the board? Under `PoolOrRoster` this is
/// also the widening test: `false` at a pick slot means the side draws from the roster (U10).
pub fn pool_can_complete(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> bool {
    let pool_net = pools.for_side(side).intersect(position.available(universe));
    let tags = tags_for(rule, side, position, pools);
    can_complete_from(memo, side, position, pool_net, tags, universe)
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
    let tags = tags_for(rule, side, position, pools);
    let made = position
        .picks(side)
        .iter()
        .filter(|c| !pool.contains(**c))
        .count();
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    let forced = if remaining == 0
        || pool_can_complete(memo, rule, side, position, pools, universe)
        || !can_complete_from(
            memo,
            side,
            position,
            position.available(universe),
            tags,
            universe,
        ) {
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

/// The snipe-aware key's input (design `engine-snipe-key-design.md` § 1): the champions of `side`'s pool
/// net whose removal lowers `rank(locked ∪ pool net)` — each one the opponent takes adds exactly one to
/// `side`'s forced off-pool count, since that count is `5 − rank` (the design's fact 1). Only a champion
/// one maximum assignment matches can be critical (fact 2), so this is one assignment plus at most
/// `5 − |locked|` re-ranks per distinct `(side, locked, pool net)`, memoised in `memo.critical`; two
/// critical champions taken together lower the rank by exactly two (fact 3: they are coloops). Empty,
/// without a matching, when the count cannot move: `side` has no pick left (a cost gate: five matched
/// locked picks already hold the rank at five), or its locked picks cannot be matched (the comp is
/// broken whatever the pool holds). `off_pool_count`'s third gate — the roster cannot complete
/// either — is left out on purpose: its candidate set is everything available, which differs at every
/// node and would miss the memo each time; it affects ordering only, never a leaf.
pub fn critical_pool(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> ChampionSet {
    let locked = position.picks(side);
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    // Only ever asked where the off-pool term rides the key — under a live rule.
    let tags = live_tags(side, position, pools);
    if remaining == 0 || !locked_matchable(memo, side, locked, tags, universe) {
        return ChampionSet::EMPTY;
    }
    let pool_net = pools.for_side(side).intersect(position.available(universe));
    let locked_set: ChampionSet = locked.iter().copied().collect();
    let key = (side, locked_set, pool_net);
    if let Some(&known) = memo.critical.get(&key) {
        return known;
    }
    let pool: Vec<ChampionIdx> = pool_net.iter().collect();
    let mut names = universe.names(locked);
    names.extend(universe.names(&pool));
    let matched = max_role_assignment(&names, universe.champion_meta());
    let rank = matched.iter().filter(|m| **m).count();
    let mut critical = ChampionSet::EMPTY;
    for (&c, _) in pool
        .iter()
        .zip(&matched[locked.len()..])
        .filter(|(_, m)| **m)
    {
        if role_rank(memo, side, position, pool_net.without(c), universe) < rank {
            critical = critical.with(c);
        }
    }
    memo.critical.insert(key, critical);
    critical
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

/// Can `locked` be matched to distinct roles at all? The predicate's own first test, and the whole
/// answer when it fails; memoised on the locked set alone (`FeasibilityMemo.locked`). Public for the
/// shortlist's lazy filter (B-proper § 2, `search::truncate_children`), which asks it of a child's
/// locked picks — at most five names, no candidate set. `tags` is the side's `tags_for`: `None` is
/// the meta alone, as before; `Some` matches on the side's playable roles (RA4). The switch is HERE,
/// inside the one function the critical-set gate, the completion predicate and the lazy filter all
/// call, so the three cannot put a meta-only and a playable answer on the same `(side, locked)` key.
pub fn locked_matchable(
    memo: &mut FeasibilityMemo,
    side: Side,
    locked: &[ChampionIdx],
    tags: Option<&RoleSets>,
    universe: &Universe,
) -> bool {
    let locked_set: ChampionSet = locked.iter().copied().collect();
    if let Some(&ok) = memo.locked.get(&(side, locked_set)) {
        return ok;
    }
    let ok = match tags {
        None => {
            max_role_matching(&universe.names(locked), universe.champion_meta()) == locked.len()
        }
        Some(tags) => {
            let masks: Vec<RoleMask> = locked
                .iter()
                .map(|c| playable(tags, universe, *c))
                .collect();
            max_matching_masks(&masks) == locked.len()
        }
    };
    memo.locked.insert((side, locked_set), ok);
    ok
}

/// The predicate on an explicit candidate set, memoised on `(side, locked set, candidate set)`.
/// `tags` as in `locked_matchable`: `None` runs the incumbent's string predicate, as before; `Some`
/// runs the same predicate on the side's playable masks (`crate::feasibility::can_complete_masks`).
fn can_complete_from(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    candidates: ChampionSet,
    tags: Option<&RoleSets>,
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
    if locked.len() + remaining == 5 && !locked_matchable(memo, side, locked, tags, universe) {
        memo.memo.insert(key, false);
        return false;
    }
    let feasible = match tags {
        None => can_complete_roles(
            &universe.names(locked),
            &universe.names_of(candidates),
            remaining,
            universe.champion_meta(),
        ),
        Some(tags) => {
            let masks = |champions: &mut dyn Iterator<Item = ChampionIdx>| -> Vec<RoleMask> {
                champions.map(|c| playable(tags, universe, c)).collect()
            };
            can_complete_masks(
                &masks(&mut locked.iter().copied()),
                &masks(&mut candidates.iter()),
                remaining,
            )
        }
    };
    memo.memo.insert(key, feasible);
    feasible
}
