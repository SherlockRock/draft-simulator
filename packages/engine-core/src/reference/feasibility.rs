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
use crate::pools::Role;
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

/// The prices one search reads (engine-role-grade design § 2): `p` per off-pool unit and `q_unit` =
/// Q / 100 per grade unit, in the objective's unit. Fixed on the memo at construction — the oracle and
/// the search build it after resolving both knobs — because the weighted tables the memo will hold are
/// chosen in the cost order AT this price: a memo must never be shared across a different (P, Q), as it
/// is never shared across different pools.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub p: f64,
    pub q_unit: f64,
}

impl Price {
    /// Unpriced: what a legality-only reader builds (`tier_b`'s one-shot check, the tests that read
    /// counts and classes). Every unweighted quantity is the same at any price, and at Q = 0 so is every
    /// weighted one (the exchange theorem, design fact 8).
    pub const ZERO: Self = Self {
        p: 0.0,
        q_unit: 0.0,
    };

    /// From the two resolved knobs: P and Q in blue-win logits, Q per 100 grade units.
    pub fn of(off_pool_cost: f64, off_role_cost: f64) -> Self {
        Self {
            p: off_pool_cost,
            q_unit: off_role_cost / 100.0,
        }
    }
}

/// A placement's cost, and an arrangement's (engine-role-grade design, Definitions): off-pool units — a
/// placement outside the side's pool entries — and grade units — the champion's grade in that role,
/// 0..=100 each (`Universe::grade`), so at most 500 over five picks. Integers: a price is computed from
/// them once (`price`), and the cost order is exact.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cost {
    pub off: u8,
    pub grade: u16,
}

impl Cost {
    fn plus(self, other: Cost) -> Cost {
        Cost {
            off: self.off + other.off,
            grade: self.grade + other.grade,
        }
    }

    /// `off · P + grade · Q/100`, each term skipped when its count or its unit is zero — so Q = 0 adds
    /// no `+0.0` (G5, G7: a `−0.0` board must stay `−0.0`).
    pub fn price(self, price: Price) -> f64 {
        let mut v = 0.0;
        if self.off != 0 && price.p != 0.0 {
            v += f64::from(self.off) * price.p;
        }
        if self.grade != 0 && price.q_unit != 0.0 {
            v += f64::from(self.grade) * price.q_unit;
        }
        v
    }

    /// The cost order (Definitions): by price; equal price → fewer off units; then fewer grade units.
    /// At Q = 0 it is "fewer off units" alone — today's "most in-role".
    fn better(self, other: Cost, price: Price) -> bool {
        let (a, b) = (self.price(price), other.price(price));
        a < b || (a == b && (self.off, self.grade) < (other.off, other.grade))
    }
}

/// The least total of a side at a position (Definitions): the cost of the locked picks' arrangement
/// `a*` and the placements still to come that `a*` leaves for the roster (`fills`, each (1, 0)).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Total {
    pub cost: Cost,
    pub fills: u8,
}

impl Total {
    fn off(self) -> u8 {
        self.cost.off + self.fills
    }

    /// `cost.price + fills · P` (the forced term is never graded — a lower bound, design G2 / fact 9).
    fn price(self, price: Price) -> f64 {
        self.cost
            .plus(Cost {
                off: self.fills,
                grade: 0,
            })
            .price(price)
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
/// build it. Nor across a different (P, Q): the price is fixed at construction (`Price`).
#[derive(Debug)]
pub struct FeasibilityMemo {
    price: Price,
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
    /// A role-tagged side's least total at this memo's price, on `(side, locked set, pool net)` — the
    /// weighted sibling of `weights` (engine-role-grade design § 2); the leaf charges it, the pool test
    /// never reads it.
    totals: HashMap<(Side, ChampionSet, ChampionSet), Option<Total>>,
    pub calls: u64,
    pub misses: u64,
}

impl FeasibilityMemo {
    /// An empty memo for one search at `price`. The oracle and the search build theirs after
    /// resolving (P, Q) (`oracle::resolve_off_pool_cost`, `resolve_off_role_cost`); a reader of
    /// legality, counts or classes alone builds one at `Price::ZERO`.
    pub fn new(price: Price) -> Self {
        Self {
            price,
            memo: HashMap::new(),
            ranks: HashMap::new(),
            locked: HashMap::new(),
            critical: HashMap::new(),
            profiles: HashMap::new(),
            weights: HashMap::new(),
            totals: HashMap::new(),
            calls: 0,
            misses: 0,
        }
    }

    pub fn price(&self) -> Price {
        self.price
    }
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

/// RA4: the roles `c` can fill for a role-tagged side — its `playable` set (champion-role-shares
/// design § 5.3: the listed roles plus every role above the refresh's pick-count floor; the positions
/// when the meta has none), plus the ones the side's own pool lists for it. Per side: the other
/// side's entries never widen it. The TAGGED path alone reads the playable mask (U2): a list-form
/// side and every `tags_for` = `None` context run the string predicates on the positions-only meta.
fn playable(tags: &RoleSets, universe: &Universe, c: ChampionIdx) -> RoleMask {
    universe.playable_mask(c) | tags.mask(c)
}

/// Role subsets, one per bit pattern over `ROLES`.
const SUBSETS: usize = 1 << ROLES.len();

fn roles_in(subset: usize) -> usize {
    (0..ROLES.len())
        .filter(|bit| subset >> bit & 1 == 1)
        .count()
}

/// A role-tagged side's locked picks, summarised for pricing (role-aware pools design § 2;
/// engine-role-grade design § 2): for each role subset, TWO tables over the arrangements of the picks
/// onto exactly those roles — `in_role`, the most IN-ROLE placements (a champion in a role its pool
/// entry lists), today's, unweighted, reading no price: it decides legality (`W`, the pool test) and
/// the in-pool class; and `cost`, the cheapest arrangement in the cost order at the memo's price
/// (`Cost`): the leaf and the ordering key read it. `None` where no arrangement exists, in both. An
/// arrangement puts each pick in a distinct role it can play for this side (`playable`).
#[derive(Clone, Copy, Debug)]
struct Profile {
    in_role: [Option<u8>; SUBSETS],
    cost: [Option<Cost>; SUBSETS],
}

impl Profile {
    /// No pick: the empty arrangement.
    fn start() -> Self {
        let mut in_role = [None; SUBSETS];
        in_role[0] = Some(0);
        let mut cost = [None; SUBSETS];
        cost[0] = Some(Cost::default());
        Self { in_role, cost }
    }

    /// One more pick, playable in `playable` and listed by the pool for `listed`, graded `grades` per
    /// role (bit `i` = `ROLES[i]`): in a listed role it costs nothing; elsewhere one off-pool unit and
    /// its grade there. The unweighted table keeps the most in-role placements; the weighted one the
    /// better cost at `price`.
    fn with(&self, playable: RoleMask, listed: RoleMask, grades: [u8; 5], price: Price) -> Self {
        let (playable, listed) = (usize::from(playable), usize::from(listed));
        let mut next = [None; SUBSETS];
        let mut next_cost = [None; SUBSETS];
        for (subset, held) in self.in_role.iter().enumerate() {
            let Some(held) = held else { continue };
            let held_cost = self.cost[subset].expect("the two tables are defined alike");
            for (bit, grade) in grades.iter().enumerate() {
                let role = 1 << bit;
                if playable & role == 0 || subset & role != 0 {
                    continue;
                }
                let in_role = listed & role != 0;
                let score = held + u8::from(in_role);
                let slot = &mut next[subset | role];
                if slot.is_none_or(|best| best < score) {
                    *slot = Some(score);
                }
                let placement = if in_role {
                    Cost::default()
                } else {
                    Cost {
                        off: 1,
                        grade: u16::from(*grade),
                    }
                };
                let cost = held_cost.plus(placement);
                let slot = &mut next_cost[subset | role];
                if slot.is_none_or(|best: Cost| cost.better(best, price)) {
                    *slot = Some(cost);
                }
            }
        }
        Self {
            in_role: next,
            cost: next_cost,
        }
    }

    /// The most in-role placements over every arrangement; `None` = the picks cannot be arranged.
    fn most_in_role(&self) -> Option<usize> {
        self.in_role.iter().flatten().max().map(|w| usize::from(*w))
    }

    /// `cheapest_s(S)`: the cheapest arrangement of the picks alone, in the cost order at `price`;
    /// `None` = unarrangeable. At Q = 0 its off units are today's `made` (fewest off = most in-role).
    fn cheapest(&self, price: Price) -> Option<Cost> {
        self.cost
            .iter()
            .flatten()
            .fold(None, |best: Option<Cost>, c| match best {
                Some(b) if !c.better(b, price) => Some(b),
                _ => Some(*c),
            })
    }

    /// `total_s(S, K)` (Definitions): over every arrangement `a` of the picks, the least `cost(a) +
    /// fills(a) · (1, 0)` under ONE comparator — price, total off units, the locked picks' own off
    /// units, grade units, canonical subset order — where `fills(a)` is the roles `a` leaves free less
    /// the most of them `cover` (the pool net through its listed roles, `coverable`) can fill. Returns
    /// the argmin's own cost and fills, so the report's split is non-negative by construction (review
    /// round 2: `total.off − cheapest.off` can be negative under weights). `None` = unarrangeable. At
    /// Q = 0 the exchange theorem (fact 8) makes its off units `5 − W` and its locked off units today's
    /// `made`.
    fn least_total(&self, cover: u32, price: Price) -> Option<Total> {
        let mut best: Option<(Total, (f64, u8, u8, u16))> = None;
        for (subset, cost) in self.cost.iter().enumerate() {
            let Some(cost) = cost else { continue };
            let free = (0..SUBSETS)
                .filter(|rest| cover >> rest & 1 == 1 && rest & subset == 0)
                .map(roles_in)
                .fold(0, usize::max);
            let open = ROLES.len() - roles_in(subset);
            debug_assert!(free <= open, "a cover fills free roles only");
            let fills = u8::try_from(open - free).unwrap_or(u8::MAX);
            let total = Total { cost: *cost, fills };
            let key = (total.price(price), total.off(), cost.off, cost.grade);
            // Strictly better replaces; a full tie keeps the earlier (smaller) subset.
            let better = match &best {
                None => true,
                Some((_, b)) => {
                    key.0 < b.0 || (key.0 == b.0 && (key.1, key.2, key.3) < (b.1, b.2, b.3))
                }
            };
            if better {
                best = Some((total, key));
            }
        }
        best.map(|(total, _)| total)
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
    let price = memo.price;
    let profile = locked.iter().fold(Profile::start(), |profile, c| {
        profile.with(
            playable(tags, universe, *c),
            tags.mask(*c),
            universe.grades(*c),
            price,
        )
    });
    memo.profiles.insert((side, locked_set), profile);
    profile
}

/// The least total (`Profile::least_total`) for a role-tagged side at `position` over `pool_net`, at the
/// memo's price, memoised on `(side, locked set, pool net)` beside `in_role_weight`.
fn least_total_at(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    pool_net: ChampionSet,
    tags: &RoleSets,
    universe: &Universe,
) -> Option<Total> {
    let locked = position.picks(side);
    let locked_set: ChampionSet = locked.iter().copied().collect();
    let key = (side, locked_set, pool_net);
    if let Some(&known) = memo.totals.get(&key) {
        return known;
    }
    let price = memo.price;
    let total = locked_profile(memo, side, locked, tags, universe)
        .least_total(coverable(tags, pool_net), price);
    memo.totals.insert(key, total);
    total
}

/// `cheapest_s(S)` (Definitions): the cheapest arrangement's cost, or — picks that cannot be arranged
/// (a broken board: L' prices it) — today's fallback, the champions outside the pool entirely at grade 0.
fn cheapest_cost(profile: &Profile, outside_pool: usize, price: Price) -> Cost {
    profile.cheapest(price).unwrap_or(Cost {
        off: u8::try_from(outside_pool).unwrap_or(u8::MAX),
        grade: 0,
    })
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

/// A side's off-pool count in its parts (role-aware pools design § 2; engine-role-grade design § 2):
/// `made`, the picks on the board that are off-pool (under role tags, off-role in the charged
/// arrangement `a*`), `grade`, the grade units those placements carry (0 on a list-form side), and
/// `forced`, the picks still to come that cannot be in-pool. The leaf charges `made + forced` at P and
/// `grade` at Q/100 (`off_pool_count` is the P count alone); the grid's forced column and a reader of
/// either part use this. `made` can exceed today's `made_u` at Q > 0 — the cheapest completion places
/// more locked picks off-role to avoid grade — the honest reading, not an error.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OffPool {
    pub made: usize,
    pub grade: usize,
    pub forced: usize,
}

impl OffPool {
    pub fn total(self) -> usize {
        self.made + self.forced
    }
}

/// What an action adds to the mover's charge (role-aware pools design § 2; engine-role-grade design
/// G7) — the one reading behind the ordering key's term, the root's in-pool / off-pool split and the
/// report's and the grid's class. Built once per node by `action_charge` at the memo's price; a
/// list-form side asks the set, as before.
#[derive(Clone, Copy, Debug)]
pub struct ActionCharge<'a> {
    pool: ChampionSet,
    price: Price,
    tagged: Option<TaggedCharge<'a>>,
}

#[derive(Clone, Copy, Debug)]
struct TaggedCharge<'a> {
    tags: &'a RoleSets,
    universe: &'a Universe,
    profile: Profile,
    picks: usize,
    outside_pool: usize,
    /// Today's `made` of the locked picks (the unweighted table) — the class's baseline.
    made: usize,
    /// The locked picks' cheapest cost (the weighted table) — the key's baseline.
    cheapest: Cost,
}

/// One action's charge (engine-role-grade design G7). `d_off` is today's count — the rise in the
/// mover's UNWEIGHTED off-role count, the action taken whole, floored at the champions it names outside
/// the pool — and decides the class (`is_in_pool`) at every Q. `d_off_key` / `d_grade` are the RAW
/// signed deltas of the weighted cheapest arrangement (child minus node) for a child that can be
/// arranged — today's floored delta and 0 for a broken child, where the fallback `(outside, 0)` applies
/// — and price the key (`key_charge`). `d_grade < 0` beside `d_off_key > 0` is legitimate: one more
/// off unit for less grade.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Charge {
    pub d_off: usize,
    pub d_off_key: i8,
    pub d_grade: i16,
    price: Price,
}

impl Charge {
    /// Today's class at every Q (fact 11): the action adds no off-pool pick.
    pub fn is_in_pool(self) -> bool {
        self.d_off == 0
    }

    /// What the ordering key charges: `d_off_key · P + d_grade · Q/100` from the two integers, each
    /// term skipped when its delta or its unit is zero (a `(1, 0) → (1, 50)` transition at Q = 0 must
    /// add nothing, or a `−0.0 + 0.0` turns a `−0.0` key into `+0.0`), the sum clamped at 0 — it is
    /// ≥ 0 algebraically for an arrangeable child (its arrangement restricted to the locked picks
    /// prices at least the node's cheapest) but float cancellation can leave `−1.4e−17`. At Q = 0 this
    /// is today's `made · P` bit for bit.
    pub fn key_charge(self) -> f64 {
        let mut v = 0.0;
        if self.d_off_key != 0 && self.price.p != 0.0 {
            v += f64::from(self.d_off_key) * self.price.p;
        }
        if self.d_grade != 0 && self.price.q_unit != 0.0 {
            v += f64::from(self.d_grade) * self.price.q_unit;
        }
        if v < 0.0 {
            0.0
        } else {
            v
        }
    }

    /// The price the memo this charge came from was built at — the ONE source the key reads P from.
    pub fn price(self) -> Price {
        self.price
    }
}

impl ActionCharge<'_> {
    /// A list-form side: an action costs one per champion it names outside the pool, at `price`.
    pub fn set(pool: ChampionSet, price: Price) -> Self {
        Self {
            pool,
            price,
            tagged: None,
        }
    }

    /// `action`'s charge for the mover. A list side: its champions outside the pool, ungraded. A tagged
    /// side: `d_off` is the rise in the off-role count of the mover's picks — the action taken whole,
    /// since two in-role singles can displace a locked pick together. Never negative: where the action
    /// breaks the comp the count falls back to the set test, which can undercount, and the difference
    /// is clamped at 0 (that child is in the L' band) — but never below the champions the action itself
    /// names outside the pool, so such an action still reads off-pool (the ordering key, the root split
    /// and the report's marker), as it does in list form. The weighted deltas are raw where the child
    /// can be arranged (the floor over-charges a child that pays grade instead of an off unit: node
    /// `(3, 0)`, child `(3, 170)`, outside 1 — review round 3) and today's floored delta where it cannot.
    pub fn of(&self, action: Action) -> Charge {
        let outside = action
            .champions()
            .filter(|c| !self.pool.contains(*c))
            .count();
        // A handful at most (≤ 2 on a list pool, ≤ 5 on a tagged one), so the conversions are exact.
        let unit = |n: usize| i8::try_from(n).unwrap_or(i8::MAX);
        let list = Charge {
            d_off: outside,
            d_off_key: unit(outside),
            d_grade: 0,
            price: self.price,
        };
        let Some(tagged) = self.tagged else {
            return list;
        };
        if matches!(action, Action::Ban(_)) {
            return list;
        }
        let profile = action.champions().fold(tagged.profile, |profile, c| {
            profile.with(
                playable(tagged.tags, tagged.universe, c),
                tagged.tags.mask(c),
                tagged.universe.grades(c),
                self.price,
            )
        });
        let d_off = off_role(
            &profile,
            tagged.picks + action.champions().count(),
            tagged.outside_pool + outside,
        )
        .saturating_sub(tagged.made)
        .max(outside);
        let (d_off_key, d_grade) = match profile.cheapest(self.price) {
            Some(child) => (
                unit(usize::from(child.off)) - unit(usize::from(tagged.cheapest.off)),
                // Grades sum to at most 500 a side, so the difference fits.
                i16::try_from(i32::from(child.grade) - i32::from(tagged.cheapest.grade))
                    .unwrap_or(i16::MAX),
            ),
            None => (unit(d_off), 0),
        };
        Charge {
            d_off,
            d_off_key,
            d_grade,
            price: self.price,
        }
    }
}

/// One champion's placement in the arrangement the key priced (engine-role-grade design § 6): the
/// role, the grade read there (0 in-pool), and whether the role is one of its pool entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub champion: ChampionIdx,
    pub role: Role,
    pub grade: u8,
    pub in_pool: bool,
}

/// The weighted table with argmin pointers, one level per pick — the report's trace, never the
/// search's (`Profile` is copied per child; this one is built only for the actions a report prints).
struct Traced {
    /// Per pick, per subset: the cheapest cost onto exactly those roles, the subset the previous level
    /// reached it from, and this pick's role bit.
    levels: Vec<[Option<(Cost, usize, usize)>; SUBSETS]>,
}

impl Traced {
    fn start() -> Self {
        let mut best = [None; SUBSETS];
        best[0] = Some((Cost::default(), 0, 0));
        Self { levels: vec![best] }
    }

    /// `Profile::with`, with pointers; the same subset and role order and the same strict "better", so
    /// the arrangement traced is the one whose cost the key read.
    fn with(mut self, playable: RoleMask, listed: RoleMask, grades: [u8; 5], price: Price) -> Self {
        let (playable, listed) = (usize::from(playable), usize::from(listed));
        let last = self.levels.last().expect("start holds a level");
        let mut next = [None; SUBSETS];
        for (subset, held) in last.iter().enumerate() {
            let Some((held, _, _)) = held else { continue };
            for (bit, grade) in grades.iter().enumerate() {
                let role = 1 << bit;
                if playable & role == 0 || subset & role != 0 {
                    continue;
                }
                let placement = if listed & role != 0 {
                    Cost::default()
                } else {
                    Cost {
                        off: 1,
                        grade: u16::from(*grade),
                    }
                };
                let cost = held.plus(placement);
                let slot = &mut next[subset | role];
                if slot.is_none_or(|(best, _, _): (Cost, usize, usize)| cost.better(best, price)) {
                    *slot = Some((cost, subset, bit));
                }
            }
        }
        self.levels.push(next);
        self
    }

    /// The role bit of each pick, in pick order, along the cheapest arrangement; `None` = unarrangeable.
    fn arrangement(&self, price: Price) -> Option<Vec<usize>> {
        let last = self.levels.last().expect("start holds a level");
        let mut subset =
            (0..SUBSETS)
                .filter(|m| last[*m].is_some())
                .fold(None, |best: Option<usize>, m| match best {
                    Some(b)
                        if !last[m]
                            .expect("filtered")
                            .0
                            .better(last[b].expect("filtered").0, price) =>
                    {
                        Some(b)
                    }
                    _ => Some(m),
                })?;
        let mut bits = Vec::with_capacity(self.levels.len() - 1);
        for level in self.levels.iter().skip(1).rev() {
            let (_, parent, bit) = level[subset].expect("a traced subset has a parent chain");
            bits.push(bit);
            subset = parent;
        }
        bits.reverse();
        Some(bits)
    }
}

/// The placements of `action`'s champions in the cheapest arrangement of `side`'s locked picks plus
/// the action, at the memo's price — the arrangement the ordering key priced (engine-role-grade
/// design § 6). Empty for a list-form side (nothing is graded there), for a ban, and where the child
/// cannot be arranged (the marker says what the fallback charged). Not the leaf's `a*`: wherever picks
/// remain the two can differ; they coincide on a complete five-pick side.
pub fn placements(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
    action: Action,
) -> Vec<Placement> {
    arrangement(memo, side, position, pools, universe, action)
        .into_iter()
        .filter(|p| !p.locked)
        .map(|p| Placement {
            champion: p.champion,
            role: p.role,
            grade: p.grade,
            in_pool: p.in_pool,
        })
        .collect()
}

/// One pick of the whole side in the arrangement the key priced (review tool design T6, F5): the
/// locked picks are in it too, since the cheapest arrangement of a side can move one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SidePlacement {
    pub champion: ChampionIdx,
    pub role: Role,
    /// The charged grade, as `Placement::grade` defines it: 0 in-pool, else `Universe::grades`.
    pub grade: u8,
    pub in_pool: bool,
    /// A pick already on the board, not one of the action's.
    pub locked: bool,
}

/// Every pick of `side` — the locked picks first, then `action`'s — in the cheapest arrangement at the
/// memo's price: the same trace `placements` reads, which is this list's suffix after the locked
/// picks. Empty where `placements` is empty (a list-form side, a ban, an unarrangeable child).
pub fn arrangement(
    memo: &mut FeasibilityMemo,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
    action: Action,
) -> Vec<SidePlacement> {
    let Some(tags) = live_tags(side, position, pools) else {
        return Vec::new();
    };
    if matches!(action, Action::Ban(_)) {
        return Vec::new();
    }
    let price = memo.price;
    let locked = position.picks(side).len();
    let picks: Vec<ChampionIdx> = position
        .picks(side)
        .iter()
        .copied()
        .chain(action.champions())
        .collect();
    let traced = picks.iter().fold(Traced::start(), |t, c| {
        t.with(
            playable(tags, universe, *c),
            tags.mask(*c),
            universe.grades(*c),
            price,
        )
    });
    let Some(bits) = traced.arrangement(price) else {
        return Vec::new();
    };
    picks
        .iter()
        .zip(&bits)
        .enumerate()
        .map(|(i, (c, bit))| {
            let in_pool = tags.mask(*c) >> bit & 1 == 1;
            SidePlacement {
                champion: *c,
                role: ROLES[*bit],
                grade: if in_pool {
                    0
                } else {
                    universe.grades(*c)[*bit]
                },
                in_pool,
                locked: i < locked,
            }
        })
        .collect()
}

/// The role sets `side`'s locked picks can leave open: over every arrangement onto distinct roles each
/// pick can play (`playable`), those with the most in-role placements (a role its pool lists), each
/// distinct set of roles left empty, in `ROLES` order, the sets sorted. No picks: all five roles as one
/// set. Empty for a list-form side (and where no arrangement exists). What `scored_options_roles.py`'s
/// `open_roles` computed, on the live masks.
pub fn open_roles(
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    universe: &Universe,
) -> Vec<Vec<Role>> {
    let Some(tags) = live_tags(side, position, pools) else {
        return Vec::new();
    };
    let picks = position.picks(side);
    let mut best: Option<usize> = None;
    let mut opens: std::collections::BTreeSet<Vec<usize>> = std::collections::BTreeSet::new();
    // (pick index, roles taken, in-role count so far)
    fn walk(
        picks: &[ChampionIdx],
        tags: &RoleSets,
        universe: &Universe,
        taken: usize,
        in_role: usize,
        best: &mut Option<usize>,
        opens: &mut std::collections::BTreeSet<Vec<usize>>,
    ) {
        let Some((c, rest)) = picks.split_first() else {
            if best.is_none_or(|b| in_role > b) {
                *best = Some(in_role);
                opens.clear();
            }
            if *best == Some(in_role) {
                opens.insert((0..ROLES.len()).filter(|b| taken >> b & 1 == 0).collect());
            }
            return;
        };
        let (can, listed) = (playable(tags, universe, *c), tags.mask(*c));
        for bit in 0..ROLES.len() {
            if usize::from(can) >> bit & 1 == 1 && taken >> bit & 1 == 0 {
                let here = usize::from(usize::from(listed) >> bit & 1 == 1);
                walk(
                    rest,
                    tags,
                    universe,
                    taken | 1 << bit,
                    in_role + here,
                    best,
                    opens,
                );
            }
        }
    }
    walk(picks, tags, universe, 0, 0, &mut best, &mut opens);
    opens
        .into_iter()
        .map(|set| set.into_iter().map(|bit| ROLES[bit]).collect())
        .collect()
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
    let price = memo.price;
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
            cheapest: cheapest_cost(&profile, outside_pool, price),
        }
    });
    ActionCharge {
        pool,
        price,
        tagged,
    }
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
        return OffPool {
            made,
            grade: 0,
            forced,
        };
    };
    // Role-tagged, weighted (engine-role-grade design § 2): under the two gates — no pick left, the
    // roster cannot complete — the leaf charges the locked picks' cheapest arrangement alone, as today
    // charges `made` alone (at "no pick left" every arrangement fills every role, so the total is the
    // cheapest anyway; at "the roster cannot complete" the fills `a*` was chosen for will not happen);
    // otherwise the least total: its argmin's own cost and fills.
    let pool_net = pool.intersect(position.available(universe));
    let locked = position.picks(side);
    let price = memo.price;
    let profile = locked_profile(memo, side, locked, tags, universe);
    let cheapest = cheapest_cost(&profile, outside_pool, price);
    let gated = |cost: Cost| OffPool {
        made: usize::from(cost.off),
        grade: usize::from(cost.grade),
        forced: 0,
    };
    if remaining == 0 {
        return gated(cheapest);
    }
    // Asked in the list path's order — the pool first (one memoised total), the roster only when a
    // pick is in fact short: the roster's candidate set is everything available, a different set at
    // every leaf, so asking it first costs a memo entry per leaf (measured on the grid: 4.6 times the
    // list form's memory under `pool_or_roster`). Picks that cannot be arranged have no total: nothing
    // is forced, and the roster would say the same.
    let Some(total) = least_total_at(memo, side, position, pool_net, tags, universe) else {
        return gated(cheapest);
    };
    // Nothing to fill: the argmin's own cost, which is NOT always the cheapest arrangement alone
    // (fact 10: a dearer-alone arrangement can win the total by leaving the pool a fill).
    if total.fills == 0 {
        return gated(total.cost);
    }
    if !can_complete_from(
        memo,
        side,
        position,
        position.available(universe),
        Some(tags),
        universe,
    ) {
        return gated(cheapest);
    }
    OffPool {
        made: usize::from(total.cost.off),
        grade: usize::from(total.cost.grade),
        forced: usize::from(total.fills),
    }
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
        // Role-tagged (role-aware pools design § 5; engine-role-grade G9): the champions whose removal
        // makes the least total WORSE in the comparator's first two keys — a higher price, or the same
        // price and more off units (at P = Q = 0 the price never moves, so it is today's "lowers W").
        // The candidates cannot come from one maximum-cardinality matching here — a champion outside it
        // can sit in every optimal solution — so each champion of the pool net is tried against the
        // total itself. Under weights the role-aware design's facts 3 and 5 (a removal moves the count
        // by 0 or 1; two critical champions by exactly 2) do not hold, nor does the key's `sniped · P`
        // gain: said here, acceptable while the key stays OFF.
        let price = memo.price;
        let profile = locked_profile(memo, side, locked, tags, universe);
        let total = profile.least_total(coverable(tags, pool_net), price);
        let worse = |after: Option<Total>| match (total, after) {
            (Some(t), Some(a)) => (a.price(price), a.off()) > (t.price(price), t.off()),
            (Some(_), None) => true,
            (None, _) => false,
        };
        let critical = pool_net
            .iter()
            .filter(|c| worse(profile.least_total(coverable(tags, pool_net.without(*c)), price)))
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
    use super::{
        coverable, off_role, roles_in, Cost, Price, Profile, RoleMask, RoleSets, Total, ROLES,
        SUBSETS,
    };
    use crate::reference::universe::{ChampionIdx, ChampionSet};

    /// One champion as the solver sees it: the roles it can play for the side, the roles the pool lists,
    /// its grade in each role (read only off the listed roles).
    #[derive(Clone, Copy, Debug)]
    struct Champ {
        playable: RoleMask,
        listed: RoleMask,
        grades: [u8; 5],
    }

    fn placement(c: &Champ, bit: usize) -> Cost {
        if usize::from(c.listed) >> bit & 1 == 1 {
            Cost::default()
        } else {
            Cost {
                off: 1,
                grade: u16::from(c.grades[bit]),
            }
        }
    }

    /// Every arrangement of `picks` (distinct roles, each playable), as `(roles used, in-role count, cost)`.
    fn arrangements(picks: &[Champ]) -> Vec<(usize, usize, Cost)> {
        picks
            .iter()
            .fold(vec![(0, 0, Cost::default())], |partial, c| {
                partial
                    .iter()
                    .flat_map(|&(used, in_role, cost)| {
                        (0..ROLES.len())
                            .filter(move |bit| {
                                usize::from(c.playable) >> bit & 1 == 1 && used >> bit & 1 == 0
                            })
                            .map(move |bit| {
                                (
                                    used | 1 << bit,
                                    in_role + usize::from(usize::from(c.listed) >> bit & 1 == 1),
                                    cost.plus(placement(c, bit)),
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

    fn tags_of(pool: &[Champ]) -> (RoleSets, ChampionSet) {
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
        (tags, net)
    }

    fn profile_of(locked: &[Champ], price: Price) -> Profile {
        locked.iter().fold(Profile::start(), |p, c| {
            p.with(c.playable, c.listed, c.grades, price)
        })
    }

    /// (most in-role, W, the cheapest cost, the least total) by the solver.
    fn solver(
        locked: &[Champ],
        pool: &[Champ],
        price: Price,
    ) -> (Option<usize>, Option<usize>, Option<Cost>, Option<Total>) {
        let profile = profile_of(locked, price);
        let (tags, net) = tags_of(pool);
        let cover = coverable(&tags, net);
        (
            profile.most_in_role(),
            profile.weight(cover),
            profile.cheapest(price),
            profile.least_total(cover, price),
        )
    }

    /// The same four by brute force over every arrangement: the cheapest in the cost order (price,
    /// fewer off, fewer grade) and the least total under the comparator (price, total off, locked off,
    /// grade, roles used).
    fn brute(
        locked: &[Champ],
        pool: &[Champ],
        price: Price,
    ) -> (Option<usize>, Option<usize>, Option<Cost>, Option<Total>) {
        let all = arrangements(locked);
        let cheapest = all.iter().map(|&(_, _, cost)| cost).min_by(|a, b| {
            (a.price(price), a.off, a.grade)
                .partial_cmp(&(b.price(price), b.off, b.grade))
                .expect("finite prices")
        });
        let total = all
            .iter()
            .map(|&(used, _, cost)| {
                let open = ROLES.len() - roles_in(used);
                let fills = u8::try_from(open - fill(pool, used)).unwrap_or(u8::MAX);
                (Total { cost, fills }, used)
            })
            .min_by(|(a, ua), (b, ub)| {
                (a.price(price), a.off(), a.cost.off, a.cost.grade, *ua)
                    .partial_cmp(&(b.price(price), b.off(), b.cost.off, b.cost.grade, *ub))
                    .expect("finite prices")
            })
            .map(|(t, _)| t);
        (
            all.iter().map(|&(_, in_role, _)| in_role).max(),
            all.iter()
                .map(|&(used, in_role, _)| in_role + fill(pool, used))
                .max(),
            cheapest,
            total,
        )
    }

    /// Every playable mask of one or two roles with every listed mask it can carry (`listed ⊆ playable`:
    /// `playable` is the meta's roles OR the listed ones), and every grade pattern from {0, 100} on the
    /// playable roles the pool does not list (a grade is read nowhere else; listed roles stay 0).
    fn champs() -> Vec<Champ> {
        let mut out = Vec::new();
        for playable in (1..SUBSETS).filter(|p| roles_in(*p) <= 2) {
            for listed in (0..SUBSETS).filter(|l| l & !playable == 0) {
                let open: Vec<usize> = (0..ROLES.len())
                    .filter(|bit| playable >> bit & 1 == 1 && listed >> bit & 1 == 0)
                    .collect();
                for pattern in 0..1usize << open.len() {
                    let mut grades = [0u8; 5];
                    for (i, bit) in open.iter().enumerate() {
                        if pattern >> i & 1 == 1 {
                            grades[*bit] = 100;
                        }
                    }
                    out.push(Champ {
                        playable: RoleMask::try_from(playable).unwrap_or(0),
                        listed: RoleMask::try_from(listed).unwrap_or(0),
                        grades,
                    });
                }
            }
        }
        out
    }

    /// The least price over every way to complete `locked` with `to_come` of `candidates` (pool net and
    /// roster alike) and arrange the five; `None` when no completion can be arranged. `chosen` ranges
    /// over every subset of the candidates, which can outnumber the roles (review minor F1: `roles_in`
    /// counts the first five bits only).
    fn true_min_price(
        locked: &[Champ],
        candidates: &[Champ],
        to_come: usize,
        price: Price,
    ) -> Option<f64> {
        let chosen_count = |chosen: usize| {
            (0..candidates.len())
                .filter(|i| chosen >> i & 1 == 1)
                .count()
        };
        (0..1usize << candidates.len())
            .filter(|chosen| chosen_count(*chosen) == to_come)
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
                    .map(|&(_, _, cost)| cost.price(price))
                    .min_by(|a, b| a.partial_cmp(b).expect("finite"))
            })
            .min_by(|a, b| a.partial_cmp(b).expect("finite"))
    }

    /// Role-aware pools design § 6 test 19 and engine-role-grade design § 7 test 1: the subset-table
    /// solver against brute force, both tables. Exhaustive over every locked set of up to two champions
    /// (one- and two-role masks, every listing, every {0, 100} grade pattern on the unlisted playable
    /// roles) and every pool net of up to two listed champions, at a dyadic weighted price; then 20 000
    /// larger draws (up to five locked, six in the pool net, any masks, grades 0..=100) at dyadic
    /// (P, q_unit) with P ∈ {0, 1/4, 1/2, 1, 2} and q_unit ∈ {0, P/128, P/64, P/32}, so prices add
    /// exactly (at P = 0 every price is 0 and the comparator's integer keys alone decide). On each: `most_in_role`
    /// and W (today's tables), the cheapest cost and the least total (price AND the comparator's split)
    /// equal brute force; the off-role count and — with up to four roster champions the pool does not
    /// list — the lower bound: the least total's price is never above the least price over every
    /// completion (fact 9), and equal to it on a complete comp. At q_unit = 0 with non-zero grades the
    /// exchange theorem's consequence (fact 8): `least_total.off = 5 − W` and `cost.off = made_u`.
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
        // the exhaustive part a few seconds in a debug build; the draws below cover the rest.
        let single: Vec<Champ> = listed
            .iter()
            .copied()
            .filter(|c| roles_in(usize::from(c.listed)) == 1 && c.playable == c.listed)
            .collect();
        let mut nets: Vec<Vec<Champ>> = vec![Vec::new()];
        nets.extend(single.iter().map(|a| vec![*a]));
        nets.extend(
            single
                .iter()
                .flat_map(|a| single.iter().map(move |b| vec![*a, *b])),
        );
        let weighted = Price {
            p: 1.0,
            q_unit: 1.0 / 128.0,
        };
        let mut cases = 0u64;
        for locked in &locked_sets {
            for net in &nets {
                assert_eq!(
                    solver(locked, net, weighted),
                    brute(locked, net, weighted),
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
        let (mut bounded, mut slack, mut complete, mut exchanged, mut graded_moves) =
            (0u64, 0u64, 0u64, 0u64, 0u64);
        for _ in 0..20_000 {
            let draw = |n: u64, next: &mut dyn FnMut(u64) -> u64| -> Vec<Champ> {
                (0..n)
                    .map(|_| {
                        let listed = if next(3) == 0 { 0 } else { mask(next(32)) };
                        let playable = mask(next(31) + 1) | listed;
                        let mut grades = [0u8; 5];
                        for (bit, g) in grades.iter_mut().enumerate() {
                            if playable >> bit & 1 == 1 && listed >> bit & 1 == 0 {
                                *g = u8::try_from(next(101)).unwrap_or(100);
                            }
                        }
                        Champ {
                            playable,
                            listed,
                            grades,
                        }
                    })
                    .collect()
            };
            let (locked_len, net_len) = (next(6), next(7));
            let (locked, net) = (draw(locked_len, &mut next), draw(net_len, &mut next));
            let p = [0.0, 0.25, 0.5, 1.0, 2.0][usize::try_from(next(5)).unwrap_or(0)];
            let q_unit =
                [0.0, p / 128.0, p / 64.0, p / 32.0][usize::try_from(next(4)).unwrap_or(0)];
            let price = Price { p, q_unit };
            let expected = brute(&locked, &net, price);
            assert_eq!(
                solver(&locked, &net, price),
                expected,
                "{locked:?} {net:?} {price:?}"
            );
            unmatchable += u64::from(expected.1.is_none());
            short += u64::from(expected.1.is_some_and(|w| w < ROLES.len()));

            // The off-role count: the picks less the most in-role, or the fallback when unarrangeable.
            let profile = profile_of(&locked, price);
            let outside = locked.iter().filter(|c| c.listed == 0).count();
            let made_u = expected.0.map_or(outside, |in_role| locked.len() - in_role);
            assert_eq!(
                off_role(&profile, locked.len(), outside),
                made_u,
                "{locked:?}"
            );

            // Fact 8 at Q = 0: the least total's off units are 5 − W and its locked off units today's
            // made, whatever the grades (the comparator's "total off, locked off" tie-breaks).
            if let (true, Some(w), Some(c), Some(t)) =
                (q_unit == 0.0, expected.1, expected.2, expected.3)
            {
                assert_eq!(usize::from(c.off), made_u, "{locked:?} {net:?}");
                assert_eq!(usize::from(t.off()), ROLES.len() - w, "{locked:?} {net:?}");
                assert_eq!(usize::from(t.cost.off), made_u, "{locked:?} {net:?}");
                exchanged += 1;
            }
            // Under weights the honest split can place more locked picks off-role than today.
            if let (true, Some(t)) = (q_unit > 0.0, expected.3) {
                graded_moves += u64::from(usize::from(t.cost.off) > made_u);
            }

            // The lower bound, on comps of five with a pool net and a roster small enough to enumerate.
            if net.len() > 4 {
                continue;
            }
            let roster_len = next(5);
            let roster: Vec<Champ> = (0..roster_len)
                .map(|_| {
                    let playable = mask(next(31) + 1);
                    let mut grades = [0u8; 5];
                    for (bit, g) in grades.iter_mut().enumerate() {
                        if playable >> bit & 1 == 1 {
                            *g = u8::try_from(next(101)).unwrap_or(100);
                        }
                    }
                    Champ {
                        playable,
                        listed: 0,
                        grades,
                    }
                })
                .collect();
            let to_come = ROLES.len() - locked.len();
            let candidates: Vec<Champ> = net.iter().chain(&roster).copied().collect();
            let (Some(total), Some(truth)) = (
                expected.3,
                true_min_price(&locked, &candidates, to_come, price),
            ) else {
                continue;
            };
            bounded += 1;
            assert!(
                total.price(price) <= truth,
                "{locked:?} {net:?} {roster:?} {price:?}"
            );
            slack += u64::from(total.price(price) < truth);
            if to_come == 0 {
                complete += 1;
                assert_eq!(total.price(price), truth, "{locked:?} {price:?}");
            }
        }
        // The bound was checked on thousands of completable comps, some with slack, some complete; the
        // Q = 0 consequence on thousands of draws; and the weighted split moved on some.
        assert!(
            bounded > 3_000 && slack > 50 && complete > 50,
            "{bounded} {slack} {complete}"
        );
        assert!(
            exchanged > 2_000 && graded_moves > 20,
            "{exchanged} {graded_moves}"
        );
        // The draws reach both kinds of case the pricing turns on.
        assert!(unmatchable > 100, "{unmatchable}");
        assert!(short > 5_000, "{short}");
    }
}
