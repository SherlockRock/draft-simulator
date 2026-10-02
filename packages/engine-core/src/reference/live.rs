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

use super::entries::{board_picks, pool_set_lenient};
use super::format::Format;
use super::state::{Entry, Pools, Position, PositionError};
use super::universe::{Champion, ChampionSet, Universe, UniverseError};
use crate::draft_state::{ActionType, DraftState, Side};
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

/// Slot by slot over `Format::standard()` up to the state's turn index, taking the next id from
/// the list the slot's side and kind name (U6).
pub fn entries_from_draft_state(
    state: &DraftState,
    universe: &Universe,
) -> Result<Vec<Entry>, LiveError> {
    let format = Format::standard();
    let filled = state.turn_index();
    let slots = format.slots().len();
    if filled > slots {
        return Err(LiveError::TooManyEntries {
            count: filled,
            slots,
        });
    }
    let mut cursors = [0usize; 4];
    let mut entries = Vec::with_capacity(filled);
    for i in 0..filled {
        let slot = format.slot(i).expect("i < slots");
        let (list, cursor) = match (slot.side, slot.action) {
            (Side::Blue, ActionType::Ban) => (&state.blue_bans, &mut cursors[0]),
            (Side::Red, ActionType::Ban) => (&state.red_bans, &mut cursors[1]),
            (Side::Blue, ActionType::Pick) => (&state.blue_picks, &mut cursors[2]),
            (Side::Red, ActionType::Pick) => (&state.red_picks, &mut cursors[3]),
        };
        let id = list.get(*cursor).ok_or(LiveError::Inconsistent {
            slot: i,
            side: slot.side,
            kind: slot.action,
        })?;
        *cursor += 1;
        let idx = universe
            .index(id)
            .ok_or_else(|| LiveError::UnknownChampion {
                field: format!("position[{i}]"),
                id: id.clone(),
            })?;
        entries.push(match slot.action {
            ActionType::Ban => Entry::Ban(idx),
            ActionType::Pick => Entry::Pick(idx),
        });
    }
    Ok(entries)
}

/// Which request list an unknown id came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownList {
    PoolsBlue,
    PoolsRed,
    Exclusions,
}

impl std::fmt::Display for UnknownList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            UnknownList::PoolsBlue => "pools.blue",
            UnknownList::PoolsRed => "pools.red",
            UnknownList::Exclusions => "exclusions",
        })
    }
}

/// A pool or exclusion id the universe does not know (U5): a typo, or a champion in
/// `LiveUniverse::dropped` — the caller has both lists and decides which it was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownId {
    pub list: UnknownList,
    pub id: String,
}

/// The pools of a live request (U5): each side's set = its search ids ∪ its own picks on the board;
/// `excluded` = the cross-game exclusions (folded into the position by `Position::with_excluded`).
/// Ids the universe does not know are collected in `unknown`, never refused — a root refusal that
/// follows (`RootInfeasible` after a dropped id emptied a role) should be reported together with it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResolvedPools {
    pub pools: Pools,
    pub excluded: ChampionSet,
    pub unknown: Vec<UnknownId>,
}

pub fn pools_from_search(
    blue_search: &[String],
    red_search: &[String],
    exclusions: &[String],
    entries: &[Entry],
    format: &Format,
    universe: &Universe,
) -> ResolvedPools {
    let mut unknown = Vec::new();
    let mut resolve = |list: UnknownList, ids: &[String]| {
        let (set, missing) = pool_set_lenient(ids, universe);
        unknown.extend(missing.into_iter().map(|id| UnknownId { list, id }));
        set
    };
    let blue = resolve(UnknownList::PoolsBlue, blue_search).union(board_picks(
        entries,
        format,
        Side::Blue,
    ));
    let red =
        resolve(UnknownList::PoolsRed, red_search).union(board_picks(entries, format, Side::Red));
    let excluded = resolve(UnknownList::Exclusions, exclusions);
    ResolvedPools {
        pools: Pools {
            blue,
            red,
            ..Pools::default()
        },
        excluded,
        unknown,
    }
}

/// A converted root: the standard format, the entries, the pools and the ids that were not
/// resolved. Validated by `Position::new` at construction, so `position` cannot be the first thing
/// to fail. **`position()` is the only constructor that carries `excluded`**: a `Position` rebuilt
/// from `entries` with `Position::new` alone has no exclusions.
#[derive(Clone, Debug)]
pub struct LiveRoot {
    pub format: Format,
    pub entries: Vec<Entry>,
    pub pools: Pools,
    /// Cross-game exclusions, applied to every `position()` (`Position::with_excluded`).
    pub excluded: ChampionSet,
    /// Pool / exclusion ids the universe does not know (U5) — reported, not refused.
    pub unknown: Vec<UnknownId>,
}

impl LiveRoot {
    pub fn from_draft_state(
        state: &DraftState,
        blue_search: &[String],
        red_search: &[String],
        exclusions: &[String],
        universe: &Universe,
    ) -> Result<Self, LiveError> {
        let format = Format::standard();
        let entries = entries_from_draft_state(state, universe)?;
        let resolved = pools_from_search(
            blue_search,
            red_search,
            exclusions,
            &entries,
            &format,
            universe,
        );
        Position::new(&format, &entries, &resolved.pools, universe)?;
        Ok(Self {
            format,
            entries,
            pools: resolved.pools,
            excluded: resolved.excluded,
            unknown: resolved.unknown,
        })
    }

    pub fn position<'f>(&'f self, universe: &Universe) -> Result<Position<'f>, PositionError> {
        Position::new(&self.format, &self.entries, &self.pools, universe)
            .map(|p| p.with_excluded(self.excluded))
    }
}
