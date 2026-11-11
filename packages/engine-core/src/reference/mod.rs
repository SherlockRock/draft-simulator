//! The reference model of the draft (design docs/designs/engine-tier-a-fixtures-design.md;
//! spec: Obsidian `draft-simulator-engine-target` § 6, D1–D10).
//!
//! One utility, Blue maximises, Red minimises (D3):
//!
//! ```text
//! U = Σ lin(b) + Σ_{b<b'} syn(b,b') − Σ lin(r) − Σ_{r<r'} syn(r,r') + Σ_{b,r} ctr(b,r),   ctr(b,r) = −ctr(r,b)
//! ```
//!
//! over the picks on the board; bans have no term. A side that cannot complete five roles pays
//! `L` at the leaf — `U_leaf = U − L·[Blue infeasible] + L·[Red infeasible]`, both infeasible →
//! `U` — and play never stops early; `L = 1 + 2·(Σ|lin| + Σ|syn| + Σ|ctr|)` separates the three
//! bands (slice-4 R1, via `crate::feasibility::can_complete_roles`).
//!
//! Two checks per Tier A fixture (D6): (1) the oracle's top set equals the author's intended
//! set — proves the fixture; (2) a candidate engine's top action is in the oracle's top set —
//! proves the engine. Check 2 runs the reference search (`search`) against the oracle's top set in `tests/tier_a.rs`.
//!
//! This module sits beside the incumbent search and removes nothing from it.

pub mod entries;
pub mod feasibility;
pub mod fixture;
pub mod format;
pub mod live;
pub mod node;
pub mod objective;
pub mod oracle;
pub mod search;
pub mod state;
pub mod tier_b;
pub mod tier_b_review;
pub mod transposition;
pub mod universe;
