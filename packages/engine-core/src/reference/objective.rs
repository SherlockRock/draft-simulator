//! The utility (design § 3, D3): the antisymmetric FM structural logit over the picks on the
//! board, Blue-perspective, with the leaf-carried additive feasibility rule (slice-4 R1: a side
//! that cannot complete five roles pays L at the leaf; play never stops early). A trait so tests
//! can wrap it (the strict-transform invariant) and so slice 4's alpha-beta consumes the same
//! surface.

use super::feasibility::FeasibilityRule;
use super::universe::{ChampionIdx, Universe};

/// What a leaf sees: both sides' picks and whether each side can still fill five roles.
pub struct Leaf<'a> {
    pub blue: &'a [ChampionIdx],
    pub red: &'a [ChampionIdx],
    pub blue_feasible: bool,
    pub red_feasible: bool,
}

pub trait Objective {
    /// Blue-perspective value: Blue maximises, Red minimises (D3). Implementations must return a
    /// finite value — the oracle sorts root values with `partial_cmp` and panics on a non-finite
    /// one — and must be a function of the pick SETS and the flags, never of slice order (slice-5
    /// U3: the search compares values reached by different paths bit for bit).
    fn value(&self, leaf: &Leaf<'_>) -> f64;

    /// `value` under `rule` (slice-5 U10; engine-role-grade G5): under the live rules the leaf also
    /// carries `blue_off` / `red_off`, each side's off-pool picks made plus the forced ones still to
    /// come (a lower bound from the feasibility predicate), priced at `off_pool_cost` each — the P the
    /// caller resolved for this search (`oracle::resolve_off_pool_cost`: `Universe::off_pool_cost()`
    /// = L under `PoolOrRoster`, the input's board-scale value under `Roster`, 0 under the gate, where
    /// the counts are 0 too) — and `blue_grade` / `red_grade`, the grade units those placements carry
    /// on a role-tagged side, priced at `off_role_cost / 100` each (the Q the caller resolved,
    /// `oracle::resolve_off_role_cost`: 0 everywhere but `Roster`) — and the infeasibility band is the
    /// wider L'. Under `On` / `Off` `value` is the answer. The oracle and the search call this one. No
    /// default on purpose (review round 5): a default that called `value` would be exact under the
    /// gate and silently WRONG under a live rule even with zero counts (L where L' is due), so every
    /// implementation — the strict-transform test wrappers included — must say what it does under the
    /// live rules (a wrapper forwards to the wrapped objective's `value_under`, P and Q included).
    #[allow(clippy::too_many_arguments)]
    fn value_under(
        &self,
        leaf: &Leaf<'_>,
        rule: FeasibilityRule,
        off_pool_cost: f64,
        off_role_cost: f64,
        blue_off: usize,
        red_off: usize,
        blue_grade: usize,
        red_grade: usize,
    ) -> f64;
}

/// The live leaf's charges on a board (engine-role-grade G5, Definitions "Leaf"): the two sides'
/// counts netted as INTEGERS first (Blue-perspective — Red's charges pay, Blue's cost; `i8` for the
/// off-pool counts, ≤ 5 a side, `i16` for the grades, ≤ 500), then `board + net_off · P +
/// net_grade · Q/100`, one operation per term, a term SKIPPED when its net or its unit is zero: so
/// equal counts leave the board bit for bit (review round 4: `(board − P) + P` is not `board`), Q = 0
/// adds no `+0.0` (which would turn a `−0.0` board into `+0.0`), and at P = 0 the P term is skipped
/// rather than adding `net · 0.0` (the one place this differs from slice 7, on a `−0.0` board only).
pub fn net_live(
    board: f64,
    off_pool_cost: f64,
    off_role_cost: f64,
    blue_off: usize,
    red_off: usize,
    blue_grade: usize,
    red_grade: usize,
) -> f64 {
    let count = |n: usize| i8::try_from(n).unwrap_or(i8::MAX);
    let grade = |n: usize| i16::try_from(n).unwrap_or(i16::MAX);
    let net_off = count(red_off).saturating_sub(count(blue_off));
    let net_grade = grade(red_grade).saturating_sub(grade(blue_grade));
    let mut v = board;
    if net_off != 0 && off_pool_cost != 0.0 {
        v += f64::from(net_off) * off_pool_cost;
    }
    if net_grade != 0 && off_role_cost != 0.0 {
        v += f64::from(net_grade) * (off_role_cost / 100.0);
    }
    v
}

impl Universe {
    /// `Σ lin(b) + Σ_{b<b'} syn(b,b') − Σ lin(r) − Σ_{r<r'} syn(r,r') + Σ_{b,r} ctr(b,r)`.
    /// Bans have no term (D3 iii); nothing here reads them. Both slices must be index-sorted
    /// (`Position` keeps them so, U3): the sums then run in one canonical order and the value is a
    /// function of the two sets, bit for bit, on any floats.
    pub fn board_value(&self, blue: &[ChampionIdx], red: &[ChampionIdx]) -> f64 {
        debug_assert!(
            blue.windows(2).all(|w| w[0] < w[1]) && red.windows(2).all(|w| w[0] < w[1]),
            "board_value takes index-sorted picks (U3)"
        );
        let mut u = 0.0;
        for &b in blue {
            u += self.linear(b);
        }
        for &r in red {
            u -= self.linear(r);
        }
        for (i, &b) in blue.iter().enumerate() {
            for &b2 in &blue[i + 1..] {
                u += self.synergy(b, b2);
            }
        }
        for (i, &r) in red.iter().enumerate() {
            for &r2 in &red[i + 1..] {
                u -= self.synergy(r, r2);
            }
        }
        for &b in blue {
            for &r in red {
                u += self.counter(b, r);
            }
        }
        u
    }
}

impl Universe {
    /// Under the live rule the two bands can meet: five locked champions that cannot fill five
    /// roles are infeasible on ANY roster, so a side whose pool lacks a role chooses between a forced
    /// off-pool pick (−P) and a suicide comp (−L'); with L' = L = P the board would decide (review
    /// round 4). Feasible live leaves span `board ± 5 · (P + Q)` (net counts run from −5 to 5; the
    /// grade rides off-pool placements only, ≤ 100 units each at Q/100 — engine-role-grade § 3), so the
    /// band that keeps every leaf where Blue ALONE is broken below every feasible one must clear
    /// 2Σ + 10(P + Q): `L' = L + 10·L` does whenever P + Q ≤ L, which `oracle::resolve_off_role_cost`
    /// refuses to exceed; L' is finite by construction (`from_tables` rejects an L' that overflows, and
    /// a largest leaf `Σ + 5L + L'` that does). `board − (P + Q)·k` and `board − L'` therefore never
    /// tie for any k ≤ 5. A BOTH-broken leaf is `board + net·P + net_grade·Q/100` — the off-pool
    /// picks made are facts, the bands cancel (R1) — the S11 residual, which can now move through
    /// both counts at Q > 0.
    #[allow(clippy::too_many_arguments)]
    fn live_leaf_value(
        &self,
        leaf: &Leaf<'_>,
        off_pool_cost: f64,
        off_role_cost: f64,
        blue_off: usize,
        red_off: usize,
        blue_grade: usize,
        red_grade: usize,
    ) -> f64 {
        let board = net_live(
            self.board_value(leaf.blue, leaf.red),
            off_pool_cost,
            off_role_cost,
            blue_off,
            red_off,
            blue_grade,
            red_grade,
        );
        match (leaf.blue_feasible, leaf.red_feasible) {
            (false, true) => board - self.live_loss(),
            (true, false) => board + self.live_loss(),
            _ => board,
        }
    }
}

impl Objective for Universe {
    /// R1 (slice 4): `board − L·[Blue infeasible] + L·[Red infeasible]`; both infeasible → the board
    /// EXACTLY — one operation per case, because `(board − L) + L` is not `board` on floats (slice-5
    /// review: with L ≈ 1026 it is off by an ulp, which would rank a both-broken line above a feasible
    /// line with the same board).
    fn value(&self, leaf: &Leaf<'_>) -> f64 {
        let board = self.board_value(leaf.blue, leaf.red);
        match (leaf.blue_feasible, leaf.red_feasible) {
            (false, true) => board - self.loss(),
            (true, false) => board + self.loss(),
            _ => board,
        }
    }

    /// The gate rules are `value` itself (Tier A: bit-identical by construction); a live rule is
    /// `board + P·(red_off − blue_off) + Q/100·(red_grade − blue_grade)` with the caller's P and Q,
    /// then the R1 flags at L'. Under `PoolOrRoster` the caller's Q is 0 (G3), so the value is slice
    /// 7's bit for bit.
    fn value_under(
        &self,
        leaf: &Leaf<'_>,
        rule: FeasibilityRule,
        off_pool_cost: f64,
        off_role_cost: f64,
        blue_off: usize,
        red_off: usize,
        blue_grade: usize,
        red_grade: usize,
    ) -> f64 {
        match rule {
            FeasibilityRule::On | FeasibilityRule::Off => {
                debug_assert_eq!(
                    (blue_off, red_off, blue_grade, red_grade),
                    (0, 0, 0, 0),
                    "off-pool counts and grades are zero under the gate"
                );
                self.value(leaf)
            }
            FeasibilityRule::PoolOrRoster | FeasibilityRule::Roster => self.live_leaf_value(
                leaf,
                off_pool_cost,
                off_role_cost,
                blue_off,
                red_off,
                blue_grade,
                red_grade,
            ),
        }
    }
}
