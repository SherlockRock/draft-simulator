//! D3 ii through the incumbent predicate, verbatim (design § 4, S4, S5). The predicate is only
//! defined at five picks a side (`crate::feasibility::can_complete_roles` returns `true` for
//! any other total); `FeasibilityRule::Off` is how a fixture on a shorter format says so.

use super::state::{Action, Pools, Position, RoleSets};
use super::universe::{ChampionIdx, ChampionSet, Universe};
use crate::draft_state::Side;
use crate::feasibility::{
    can_complete_masks, can_complete_roles, max_matching_masks, max_role_assignment,
    max_role_matching, RoleMask, ROLES,
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
    /// A role-tagged side's locked profile, on `(side, locked set)`.
    profiles: HashMap<(Side, ChampionSet), Profile>,
    /// A role-tagged side's in-role weight `W`, on `(side, locked set, pool net)` — a map of its own:
    /// the tagged pool test is read off it and must never meet the roster predicate in `memo`, whose
    /// key is the same triple whenever the pool net is everything available.
    weights: HashMap<(Side, ChampionSet, ChampionSet), Option<usize>>,
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

/// Role subsets, one per bit pattern over `ROLES`.
const SUBSETS: usize = 1 << ROLES.len();

fn roles_in(subset: usize) -> usize {
    (0..ROLES.len())
        .filter(|bit| subset >> bit & 1 == 1)
        .count()
}

/// A role-tagged side's locked picks, summarised for pricing (role-aware pools design § 2): for each
/// role subset, the most IN-ROLE placements (a champion in a role its pool entry lists) any
/// arrangement of the picks onto exactly those roles holds — `None` where no arrangement exists. An
/// arrangement puts each pick in a distinct role it can play for this side (`playable`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Profile {
    in_role: [Option<u8>; SUBSETS],
}

impl Profile {
    /// No pick: the empty arrangement.
    fn start() -> Self {
        let mut in_role = [None; SUBSETS];
        in_role[0] = Some(0);
        Self { in_role }
    }

    /// One more pick, playable in `playable` and listed by the pool for `listed`.
    fn with(&self, playable: RoleMask, listed: RoleMask) -> Self {
        let (playable, listed) = (usize::from(playable), usize::from(listed));
        let mut next = [None; SUBSETS];
        for (subset, held) in self.in_role.iter().enumerate() {
            let Some(held) = held else { continue };
            for bit in 0..ROLES.len() {
                let role = 1 << bit;
                if playable & role == 0 || subset & role != 0 {
                    continue;
                }
                let score = held + u8::from(listed & role != 0);
                let slot = &mut next[subset | role];
                if slot.is_none_or(|best| best < score) {
                    *slot = Some(score);
                }
            }
        }
        Self { in_role: next }
    }

    /// The most in-role placements over every arrangement; `None` = the picks cannot be arranged.
    fn most_in_role(&self) -> Option<usize> {
        self.in_role.iter().flatten().max().map(|w| usize::from(*w))
    }

    /// `W`: the most in-role placements a full comp can hold — over every arrangement of the locked
    /// picks, its own in-role placements plus the largest set of the roles it leaves free that
    /// `cover` (`coverable`, the pool net through its listed roles) can fill. `None` = unarrangeable.
    fn weight(&self, cover: u32) -> Option<usize> {
        self.in_role
            .iter()
            .enumerate()
            .filter_map(|(subset, held)| {
                let held = usize::from((*held)?);
                // The empty subset is always coverable and disjoint from everything: at least 0.
                let free = (0..SUBSETS)
                    .filter(|rest| cover >> rest & 1 == 1 && rest & subset == 0)
                    .map(roles_in)
                    .fold(0, usize::max);
                Some(held + free)
            })
            .max()
    }
}

/// The role subsets distinct champions of `candidates` can fill exactly, each in a role `tags` lists
/// for it: bit `s` set = subset `s` coverable. The empty subset always is.
fn coverable(tags: &RoleSets, candidates: ChampionSet) -> u32 {
    candidates.iter().fold(1, |cover, c| {
        let listed = usize::from(tags.mask(c));
        (0..SUBSETS)
            .filter(|subset| cover >> subset & 1 == 1)
            .fold(cover, |next, subset| {
                (0..ROLES.len())
                    .map(|bit| 1 << bit)
                    .filter(|role| listed & role != 0 && subset & role == 0)
                    .fold(next, |next, role| next | 1 << (subset | role))
            })
    })
}

/// The locked profile of a role-tagged side, memoised on `(side, locked set)`.
fn locked_profile(
    memo: &mut FeasibilityMemo,
    side: Side,
    locked: &[ChampionIdx],
    tags: &RoleSets,
    universe: &Universe,
) -> Profile {
    let locked_set: ChampionSet = locked.iter().copied().collect();
    if let Some(&known) = memo.profiles.get(&(side, locked_set)) {
        return known;
    }
    let profile = locked.iter().fold(Profile::start(), |profile, c| {
        profile.with(playable(tags, universe, *c), tags.mask(*c))
    });
    memo.profiles.insert((side, locked_set), profile);
    profile
}

/// `W` for a role-tagged side at `position` over `pool_net`, memoised on `(side, locked set, pool net)`.
fn in_role_weight(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    pool_net: ChampionSet,
    tags: &RoleSets,
    universe: &Universe,
) -> Option<usize> {
    let locked = position.picks(side);
    let locked_set: ChampionSet = locked.iter().copied().collect();
    let key = (side, locked_set, pool_net);
    if let Some(&known) = memo.weights.get(&key) {
        return known;
    }
    let weight =
        locked_profile(memo, side, locked, tags, universe).weight(coverable(tags, pool_net));
    memo.weights.insert(key, weight);
    weight
}

/// The off-role count of a tagged side's picks alone: the picks minus the most in-role placements
/// any arrangement holds. Picks that cannot be arranged at all (a broken board: L' prices it) fall
/// back to the list form's question — how many are outside the pool entirely.
fn off_role(profile: &Profile, picks: usize, outside_pool: usize) -> usize {
    profile.most_in_role().map_or(outside_pool, |in_role| {
        debug_assert!(in_role <= picks, "an arrangement places each pick once");
        picks.saturating_sub(in_role)
    })
}

/// A side's off-pool count in its two parts (role-aware pools design § 2): `made`, the picks on the
/// board that are off-pool, and `forced`, the picks still to come that cannot be in-pool. The leaf
/// charges their sum (`off_pool_count`); the grid's forced column and a reader of either part use this.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OffPool {
    pub made: usize,
    pub forced: usize,
}

impl OffPool {
    pub fn total(self) -> usize {
        self.made + self.forced
    }
}

/// What an action adds to the mover's `OffPool::made` (role-aware pools design § 2) — the one count
/// behind the ordering key's term, the root's in-pool / off-pool split and the report's and the
/// grid's class. Built once per node by `action_charge`; a list-form side asks the set, as before.
#[derive(Clone, Copy, Debug)]
pub struct ActionCharge<'a> {
    pool: ChampionSet,
    tagged: Option<TaggedCharge<'a>>,
}

#[derive(Clone, Copy, Debug)]
struct TaggedCharge<'a> {
    tags: &'a RoleSets,
    universe: &'a Universe,
    profile: Profile,
    picks: usize,
    outside_pool: usize,
    made: usize,
}

impl ActionCharge<'_> {
    /// A list-form side: an action costs one per champion it names outside the pool.
    pub fn set(pool: ChampionSet) -> Self {
        Self { pool, tagged: None }
    }

    /// The off-pool picks `action` adds for the mover. A list side: its champions outside the pool. A
    /// tagged side: the rise in the off-role count of the mover's picks — the action taken whole, since
    /// two in-role singles can displace a locked pick together. Never negative: where the action breaks
    /// the comp the count falls back to the set test, which can undercount, and the difference is
    /// clamped at 0 (that child is in the L' band). 0 = an in-pool action.
    pub fn of(&self, action: Action) -> usize {
        let outside = action
            .champions()
            .filter(|c| !self.pool.contains(*c))
            .count();
        let Some(tagged) = self.tagged else {
            return outside;
        };
        if matches!(action, Action::Ban(_)) {
            return outside;
        }
        let profile = action.champions().fold(tagged.profile, |profile, c| {
            profile.with(
                playable(tagged.tags, tagged.universe, c),
                tagged.tags.mask(c),
            )
        });
        off_role(
            &profile,
            tagged.picks + action.champions().count(),
            tagged.outside_pool + outside,
        )
        .saturating_sub(tagged.made)
    }
}

/// `ActionCharge` for `side` at `position`: its set under a list pool, its locked profile under a
/// role-tagged one (`tags_for`).
pub fn action_charge<'a>(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &'a Pools,
    universe: &'a Universe,
) -> ActionCharge<'a> {
    let pool = pools.for_side(side);
    let tagged = tags_for(rule, side, position, pools).map(|tags| {
        let locked = position.picks(side);
        let profile = locked_profile(memo, side, locked, tags, universe);
        let outside_pool = locked.iter().filter(|c| !pool.contains(**c)).count();
        TaggedCharge {
            tags,
            universe,
            profile,
            picks: locked.len(),
            outside_pool,
            made: off_role(&profile, locked.len(), outside_pool),
        }
    });
    ActionCharge { pool, tagged }
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
    let Some(tags) = tags_for(rule, side, position, pools) else {
        return can_complete_from(memo, side, position, pool_net, None, universe);
    };
    // Role-tagged (design § 3): the picks still to come can all be in-role — nothing more is forced.
    // Picks already off-role or off-pool are sunk and do not count against the pool, so a side
    // returns to its pool once a roster pick has filled the hole. Read off `weights`, never `memo`.
    let locked = position.picks(side);
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    if pool_net.len() < remaining {
        return false;
    }
    let outside_pool = locked
        .iter()
        .filter(|c| !pools.for_side(side).contains(**c))
        .count();
    let made = off_role(
        &locked_profile(memo, side, locked, tags, universe),
        locked.len(),
        outside_pool,
    );
    in_role_weight(memo, side, position, pool_net, tags, universe).is_some_and(|weight| {
        debug_assert!(
            weight + made <= ROLES.len(),
            "W counts at most the placements that are not made off-role"
        );
        ROLES.len().saturating_sub(weight) == made
    })
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
///
/// A role-tagged side (`tags_for`; role-aware pools design, Definitions): off-role is off-pool. `made`
/// is the off-role count of the picks on the board — the picks minus the most in-role placements any
/// arrangement of them holds (RA2: the cheapest arrangement, so a locked pick a later pick displaces
/// is charged, once) — and `forced` is `(5 − W) − made`, the placements still to come that cannot be
/// in-role, under the same two gates (no pick left; the roster cannot complete). A lower bound at a
/// horizon leaf, exact on a complete comp.
pub fn off_pool_count(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> usize {
    off_pool(memo, rule, side, position, pools, universe).total()
}

/// `off_pool_count` in its two parts.
pub fn off_pool(
    memo: &mut FeasibilityMemo,
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> OffPool {
    if !rule.is_live() {
        return OffPool::default();
    }
    let pool = pools.for_side(side);
    let outside_pool = position
        .picks(side)
        .iter()
        .filter(|c| !pool.contains(**c))
        .count();
    let remaining = position
        .format()
        .picks_remaining(side, position.slot_index());
    let Some(tags) = tags_for(rule, side, position, pools) else {
        let made = outside_pool;
        let forced = if remaining == 0
            || pool_can_complete(memo, rule, side, position, pools, universe)
            || !can_complete_from(
                memo,
                side,
                position,
                position.available(universe),
                None,
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
        return OffPool { made, forced };
    };
    let pool_net = pool.intersect(position.available(universe));
    let locked = position.picks(side);
    let made = off_role(
        &locked_profile(memo, side, locked, tags, universe),
        locked.len(),
        outside_pool,
    );
    // Asked in the list path's order — the pool first (one memoised weight), the roster only when a
    // pick is in fact short: the roster's candidate set is everything available, a different set at
    // every leaf, so asking it first costs a memo entry per leaf (measured on the grid: 4.6 times the
    // list form's memory under `pool_or_roster`). Picks that cannot be arranged have no `W`: nothing
    // is forced, and the roster would say the same.
    let short = if remaining == 0 {
        0
    } else {
        in_role_weight(memo, side, position, pool_net, tags, universe).map_or(0, |weight| {
            debug_assert!(
                weight + made <= ROLES.len(),
                "forced is never negative (design fact 2)"
            );
            ROLES.len().saturating_sub(weight).saturating_sub(made)
        })
    };
    let forced = if short == 0
        || !can_complete_from(
            memo,
            side,
            position,
            position.available(universe),
            Some(tags),
            universe,
        ) {
        0
    } else {
        short
    };
    OffPool { made, forced }
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
    if let Some(tags) = tags {
        // Role-tagged (design § 5): the champions whose removal lowers `W`. The candidates cannot come
        // from one maximum-cardinality matching here — a champion outside it can sit in every
        // W-optimal solution — so each listed champion of the pool net is tried against `W` itself.
        let profile = locked_profile(memo, side, locked, tags, universe);
        let weight = profile.weight(coverable(tags, pool_net));
        let critical = pool_net
            .iter()
            .filter(|c| profile.weight(coverable(tags, pool_net.without(*c))) < weight)
            .collect();
        memo.critical.insert(key, critical);
        return critical;
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

#[cfg(test)]
mod tests {
    use super::{coverable, off_role, roles_in, Profile, RoleMask, RoleSets, ROLES, SUBSETS};
    use crate::reference::universe::{ChampionIdx, ChampionSet};

    /// One champion as the solver sees it: the roles it can play for the side, the roles the pool lists.
    #[derive(Clone, Copy, Debug)]
    struct Champ {
        playable: RoleMask,
        listed: RoleMask,
    }

    /// Every arrangement of `picks` (distinct roles, each playable), as `(roles used, in-role count)`.
    fn arrangements(picks: &[Champ]) -> Vec<(usize, usize)> {
        picks.iter().fold(vec![(0, 0)], |partial, c| {
            partial
                .iter()
                .flat_map(|&(used, in_role)| {
                    (0..ROLES.len())
                        .map(|bit| 1usize << bit)
                        .filter(move |role| usize::from(c.playable) & role != 0 && used & role == 0)
                        .map(move |role| {
                            (
                                used | role,
                                in_role + usize::from(usize::from(c.listed) & role != 0),
                            )
                        })
                })
                .collect()
        })
    }

    /// The largest number of `pool` champions that fit, each in a listed role, into roles outside `used`.
    fn fill(pool: &[Champ], used: usize) -> usize {
        let Some((first, rest)) = pool.split_first() else {
            return 0;
        };
        (0..ROLES.len())
            .map(|bit| 1usize << bit)
            .filter(|role| usize::from(first.listed) & role != 0 && used & role == 0)
            .map(|role| 1 + fill(rest, used | role))
            .chain(std::iter::once(fill(rest, used)))
            .max()
            .unwrap_or(0)
    }

    fn solver(locked: &[Champ], pool: &[Champ]) -> (Option<usize>, Option<usize>) {
        let profile = locked
            .iter()
            .fold(Profile::start(), |p, c| p.with(c.playable, c.listed));
        let tags = pool
            .iter()
            .enumerate()
            .fold(RoleSets::default(), |tags, (i, c)| {
                let idx = ChampionIdx(u8::try_from(i).unwrap_or(u8::MAX));
                ROLES
                    .iter()
                    .enumerate()
                    .filter(|(bit, _)| c.listed >> bit & 1 == 1)
                    .fold(tags, |tags, (_, role)| tags.with(*role, idx))
            });
        let net: ChampionSet = (0..pool.len())
            .map(|i| ChampionIdx(u8::try_from(i).unwrap_or(u8::MAX)))
            .collect();
        (
            profile.most_in_role(),
            profile.weight(coverable(&tags, net)),
        )
    }

    fn brute(locked: &[Champ], pool: &[Champ]) -> (Option<usize>, Option<usize>) {
        let all = arrangements(locked);
        (
            all.iter().map(|&(_, in_role)| in_role).max(),
            all.iter()
                .map(|&(used, in_role)| in_role + fill(pool, used))
                .max(),
        )
    }

    /// Every playable mask of one or two roles with every listed mask it can carry (`listed ⊆ playable`:
    /// `playable` is the meta's roles OR the listed ones).
    fn champs() -> Vec<Champ> {
        (1..SUBSETS)
            .filter(|playable| roles_in(*playable) <= 2)
            .flat_map(|playable| {
                (0..SUBSETS)
                    .filter(move |listed| listed & !playable == 0)
                    .map(move |listed| Champ {
                        playable: RoleMask::try_from(playable).unwrap_or(0),
                        listed: RoleMask::try_from(listed).unwrap_or(0),
                    })
            })
            .collect()
    }

    /// The fewest placements that are not in-role over every way to complete `locked` with
    /// `to_come` of `candidates` (pool net and roster alike) and arrange the five; `None` when no
    /// completion can be arranged.
    fn true_minimum(locked: &[Champ], candidates: &[Champ], to_come: usize) -> Option<usize> {
        (0..1usize << candidates.len())
            .filter(|chosen| roles_in(*chosen) == to_come)
            .filter_map(|chosen| {
                let mut team = locked.to_vec();
                team.extend(
                    candidates
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| chosen >> i & 1 == 1)
                        .map(|(_, c)| *c),
                );
                arrangements(&team)
                    .iter()
                    .map(|&(_, in_role)| team.len() - in_role)
                    .min()
            })
            .min()
    }

    /// Role-aware pools design § 6 test 19: the subset-table solver against brute force. Exhaustive over
    /// every locked set of up to two champions (one- and two-role masks, every listing) and every pool
    /// net of up to two listed champions; then 20 000 larger draws (up to five locked, six in the pool
    /// net, any masks). `most_in_role` is the off-role count's input and `weight` is W. On each draw the
    /// off-role count itself is checked, and — with up to four roster champions the pool does not list —
    /// the count the leaf charges, `5 − W`, against the true minimum over every completion: never above
    /// it (design fact 4: a lower bound), and equal to it on a complete comp.
    #[test]
    fn the_solver_equals_brute_force_on_small_mask_sets() {
        let all = champs();
        let listed: Vec<Champ> = all.iter().copied().filter(|c| c.listed != 0).collect();
        let mut locked_sets: Vec<Vec<Champ>> = vec![Vec::new()];
        locked_sets.extend(all.iter().map(|a| vec![*a]));
        locked_sets.extend(
            all.iter()
                .flat_map(|a| all.iter().map(move |b| vec![*a, *b])),
        );
        // The pool net of two is taken over the single-role listings: 5 × 5 nets per locked set keeps
        // the exhaustive part under a second in a debug build; the draws below cover the rest.
        let single: Vec<Champ> = listed
            .iter()
            .copied()
            .filter(|c| roles_in(usize::from(c.listed)) == 1 && c.playable == c.listed)
            .collect();
        let mut nets: Vec<Vec<Champ>> = vec![Vec::new()];
        nets.extend(listed.iter().map(|a| vec![*a]));
        nets.extend(
            single
                .iter()
                .flat_map(|a| single.iter().map(move |b| vec![*a, *b])),
        );
        let mut cases = 0u64;
        for locked in &locked_sets {
            for net in &nets {
                assert_eq!(
                    solver(locked, net),
                    brute(locked, net),
                    "{locked:?} {net:?}"
                );
                cases += 1;
            }
        }
        assert!(cases > 100_000, "{cases}");

        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = |bound: u64| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) % bound
        };
        let mask = |bits: u64| RoleMask::try_from(bits % 32).unwrap_or(0);
        let mut unmatchable = 0;
        let mut short = 0;
        let (mut bounded, mut slack, mut complete) = (0u64, 0u64, 0u64);
        for _ in 0..20_000 {
            let draw = |n: u64, next: &mut dyn FnMut(u64) -> u64| -> Vec<Champ> {
                (0..n)
                    .map(|_| {
                        let listed = if next(3) == 0 { 0 } else { mask(next(32)) };
                        Champ {
                            playable: mask(next(31) + 1) | listed,
                            listed,
                        }
                    })
                    .collect()
            };
            let (locked_len, net_len) = (next(6), next(7));
            let (locked, net) = (draw(locked_len, &mut next), draw(net_len, &mut next));
            let expected = brute(&locked, &net);
            assert_eq!(solver(&locked, &net), expected, "{locked:?} {net:?}");
            unmatchable += u64::from(expected.1.is_none());
            short += u64::from(expected.1.is_some_and(|w| w < ROLES.len()));

            // The off-role count: the picks less the most in-role, or the fallback when unarrangeable.
            let profile = locked
                .iter()
                .fold(Profile::start(), |p, c| p.with(c.playable, c.listed));
            let outside = locked.iter().filter(|c| c.listed == 0).count();
            assert_eq!(
                off_role(&profile, locked.len(), outside),
                expected.0.map_or(outside, |in_role| locked.len() - in_role),
                "{locked:?}"
            );

            // The lower bound, on comps of five with a pool net and a roster small enough to enumerate.
            if net.len() > 4 {
                continue;
            }
            let roster_len = next(5);
            let roster: Vec<Champ> = (0..roster_len)
                .map(|_| Champ {
                    playable: mask(next(31) + 1),
                    listed: 0,
                })
                .collect();
            let to_come = ROLES.len() - locked.len();
            let candidates: Vec<Champ> = net.iter().chain(&roster).copied().collect();
            let (Some(weight), Some(truth)) =
                (expected.1, true_minimum(&locked, &candidates, to_come))
            else {
                continue;
            };
            bounded += 1;
            assert!(
                ROLES.len() - weight <= truth,
                "{locked:?} {net:?} {roster:?}"
            );
            slack += u64::from(ROLES.len() - weight < truth);
            if to_come == 0 {
                complete += 1;
                assert_eq!(ROLES.len() - weight, truth, "{locked:?}");
            }
        }
        // The bound was checked on thousands of completable comps, some with slack, some complete.
        assert!(
            bounded > 3_000 && slack > 50 && complete > 50,
            "{bounded} {slack} {complete}"
        );
        // The draws reach both kinds of case the pricing turns on.
        assert!(unmatchable > 100, "{unmatchable}");
        assert!(short > 5_000, "{short}");
    }
}
