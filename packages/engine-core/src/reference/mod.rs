//! The reference model of the draft (design docs/designs/engine-tier-a-fixtures-design.md;
//! spec: Obsidian `draft-simulator-engine-target` § 6, D1–D10).
//!
//! One utility, Blue maximises, Red minimises (D3):
//!
//! ```text
//! U = Σ lin(b) + Σ_{b<b'} syn(b,b') − Σ lin(r) − Σ_{r<r'} syn(r,r') + Σ_{b,r} ctr(b,r),   ctr(b,r) = −ctr(r,b)
//! ```
//!
//! over the picks on the board; bans have no term. A position where a side cannot complete
//! five roles is terminal: `+L` if Red cannot, `−L` if Blue cannot, `0` if neither can, with
//! `L` larger than any reachable |U| (D3 ii, via `crate::feasibility::can_complete_roles`).
//!
//! Two checks per Tier A fixture (D6): (1) the oracle's top set equals the author's intended
//! set — proves the fixture; (2) a candidate engine's top action is in the oracle's top set —
//! proves the engine. Check 2 has no candidate until slice 4 and is a stub in `tests/tier_a.rs`.
//!
//! This module sits beside the incumbent search and removes nothing from it.

pub mod feasibility;
pub mod fixture;
pub mod format;
pub mod objective;
pub mod state;
pub mod universe;
