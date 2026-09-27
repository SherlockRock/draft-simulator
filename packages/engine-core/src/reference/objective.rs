//! The utility (design § 3, D3): the antisymmetric FM structural logit over the picks on the
//! board, Blue-perspective, with the leaf-carried additive feasibility rule (slice-4 R1: a side
//! that cannot complete five roles pays L at the leaf; play never stops early). A trait so tests
//! can wrap it (the strict-transform invariant) and so slice 4's alpha-beta consumes the same
//! surface.

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
}
