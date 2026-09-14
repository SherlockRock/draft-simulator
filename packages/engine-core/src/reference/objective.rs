//! The utility (design § 3, D3): the antisymmetric FM structural logit over the picks on the
//! board, Blue-perspective, with the feasibility terminal rule. A trait so tests can wrap it
//! (the strict-transform invariant) and so slice 4's alpha-beta consumes the same surface.

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
    /// one.
    fn value(&self, leaf: &Leaf<'_>) -> f64;
}

impl Universe {
    /// `Σ lin(b) + Σ_{b<b'} syn(b,b') − Σ lin(r) − Σ_{r<r'} syn(r,r') + Σ_{b,r} ctr(b,r)`.
    /// Bans have no term (D3 iii); nothing here reads them.
    pub fn board_value(&self, blue: &[ChampionIdx], red: &[ChampionIdx]) -> f64 {
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
    fn value(&self, leaf: &Leaf<'_>) -> f64 {
        match (leaf.blue_feasible, leaf.red_feasible) {
            (false, false) => 0.0,
            (true, false) => self.loss(),
            (false, true) => -self.loss(),
            (true, true) => self.board_value(leaf.blue, leaf.red),
        }
    }
}
