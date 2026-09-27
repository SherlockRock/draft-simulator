//! The live universe and the `DraftState` → reference converter (slice-5 design § 3–5; U2–U6).
//!
//! `LiveUniverse::build` derives the D3 tables from the shipped FM exactly: `lin(c) =
//! linear_expected`, `syn(a, b) = s_a · s_b`, `ctr(b, r) = a_b · b_r − b_b · a_r` (antisymmetric by
//! construction). Summing the incumbent's per-champion allocations Blue minus Red reproduces the
//! D3 objective term for term (design § 3), so `board_value` equals the FM's structural logit.
//! The FM's `scale` and `0.5 +` offset are a strictly increasing transform and are not applied (D3 vi).
//!
//! The converter walks `Format::standard()` slot by slot over a count-positional `DraftState`;
//! it never produces `Skip` (no product surface records one, D5). It never refuses a compute over
//! a pool or exclusion id it does not know: those are reported in `LiveRoot::unknown` (U5).

use super::state::PositionError;
use super::universe::{Champion, Universe, UniverseError};
use crate::draft_state::{ActionType, Side};
use crate::fm::{dot, FmWeights, RANK};
use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum LiveError {
    /// A champion ON THE BOARD the universe does not know: the position cannot be represented.
    #[error("{field}: unknown champion {id:?}")]
    UnknownChampion { field: String, id: String },
    /// The state's per-side lists disagree with the standard sequence: the slot's list ran out.
    #[error("slot {slot}: the format expects a {side:?} {kind:?} but the state has none left")]
    Inconsistent {
        slot: usize,
        side: Side,
        kind: ActionType,
    },
    #[error("{count} entries but the standard format has {slots} slots")]
    TooManyEntries { count: usize, slots: usize },
    #[error(transparent)]
    Universe(#[from] UniverseError),
    #[error(transparent)]
    Position(#[from] PositionError),
}

/// Why a champion was left out of the live universe (U4). Either way a request naming it fails on
/// its own as `UnknownChampion` instead of every request failing at build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropReason {
    /// In the FM but not in champion-meta: feasibility is undefined without positions.
    NotInChampionMeta,
    /// In champion-meta with an empty `positions` list (a positions refresh can floor a new
    /// champion to none): `Universe::from_tables` would refuse it as `NoPositions`.
    NoPositions,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub id: String,
    pub reason: DropReason,
}

/// The whole roster (U2), built once per data load and shared.
#[derive(Clone, Debug)]
pub struct LiveUniverse {
    pub universe: Universe,
    pub fm_version: String,
    pub meta_version: String,
    /// Champion-meta champions the FM does not know: zero rows, legal picks if pooled (U4, the
    /// incumbent's UNKNOWN padding). Sorted. Empty on the shipped files.
    pub padded: Vec<String>,
    /// Champions left OUT of the universe, with the reason (U4). Sorted by id. Empty on the shipped
    /// files. Never a build error: the build fails only on a non-finite FM parameter.
    pub dropped: Vec<Dropped>,
}

impl LiveUniverse {
    /// Ids = (FM aliases ∪ champion-meta ids) ∩ champion-meta ids, **sorted** — index order is also
    /// the canonical action order and the tie-break, so it must not depend on `HashMap` iteration.
    pub fn build(
        fm: &FmWeights,
        meta_version: &str,
        meta: &HashMap<String, ChampionMeta>,
    ) -> Result<Self, LiveError> {
        let mut dropped: Vec<Dropped> = fm
            .aliases()
            .filter(|id| !meta.contains_key(*id))
            .map(|id| Dropped {
                id: id.to_string(),
                reason: DropReason::NotInChampionMeta,
            })
            .chain(
                meta.iter()
                    .filter(|(_, m)| m.positions.is_empty())
                    .map(|(id, _)| Dropped {
                        id: id.clone(),
                        reason: DropReason::NoPositions,
                    }),
            )
            .collect();
        dropped.sort_by(|a, b| a.id.cmp(&b.id));
        let mut ids: Vec<String> = meta
            .iter()
            .filter(|(_, m)| !m.positions.is_empty())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        let mut padded: Vec<String> = ids
            .iter()
            .filter(|id| fm.champion(id).is_none())
            .cloned()
            .collect();
        padded.sort();

        let zero = [0.0; RANK];
        let n = ids.len();
        let mut champions = Vec::with_capacity(n);
        let mut rows: Vec<(&[f64; RANK], &[f64; RANK], &[f64; RANK])> = Vec::with_capacity(n);
        for id in &ids {
            let positions = meta
                .get(id)
                .map(|m| m.positions.clone())
                .expect("ids are champion-meta keys with positions");
            let (linear, s, a, b) = match fm.champion(id) {
                Some(c) => (c.linear_expected, &c.synergy, &c.counter_a, &c.counter_b),
                None => (0.0, &zero, &zero, &zero),
            };
            champions.push(Champion {
                id: id.clone(),
                positions,
                linear,
            });
            rows.push((s, a, b));
        }

        let mut synergy = vec![vec![0.0; n]; n];
        let mut counter = vec![vec![0.0; n]; n];
        for x in 0..n {
            for y in (x + 1)..n {
                synergy[x][y] = dot(rows[x].0, rows[y].0);
                counter[x][y] = dot(rows[x].1, rows[y].2) - dot(rows[x].2, rows[y].1);
            }
        }
        let universe = Universe::from_tables(champions, &synergy, &counter)?;
        Ok(Self {
            universe,
            fm_version: fm.version.clone(),
            meta_version: meta_version.to_string(),
            padded,
            dropped,
        })
    }
}
