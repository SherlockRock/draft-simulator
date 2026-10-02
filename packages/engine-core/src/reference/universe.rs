//! A universe (design § 3, D1; slice-5 design § 2–3): champions with positions and a linear term,
//! a symmetric synergy table and an antisymmetric counter table. Ids are interned to `u8`
//! indices; sets are 256-bit bitmasks. Strings appear only at the JSON boundary and in messages.
//!
//! Two constructors: [`Universe::new`] from a fixture's entry lists (Tier A) and
//! [`Universe::from_tables`] from dense matrices (the live universe, `super::live`).

use crate::feasibility::{champion_role_mask, RoleMask};
use crate::pools::Role;
use crate::role_solver::ChampionMeta;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// The off-pool cost P under `FeasibilityRule::Roster` (B-proper design B5, § 3): blue-win logits,
/// about 2.5 percentage points of win probability near an even game. Calibrated 2026-09-29 on the
/// Tier B authoring corpus (`fixtures/tier-b/2026-09-29-*`, the user's Kittens vs DME pinch drafts):
/// seven usable verdicts put P > 0.09 and P < 0.11 at a 0.01 sweep step (report `docs/plans/
/// 2026-09-28-tier-b-authoring/report-2.txt`; the coarse sweep, `report-1.txt`, read 0.08–0.12), and
/// the user chose 0.10 after reading the scored options — lower than the 0.15 assumption it replaces. PROVISIONAL: pools are
/// sets, not roles (design § 9, "Role-aware pools") — five of the twelve positions were parked for it,
/// and making off-role count as off-pool re-prices every off-pool line; recalibrate after it lands.
pub const DEFAULT_OFF_POOL_COST: f64 = 0.10;

pub const MAX_CHAMPIONS: usize = 256;
const WORDS: usize = 4;

/// Index into the universe's champion list. Both constructors refuse more than `MAX_CHAMPIONS`
/// (256), so every index they hand out addresses a bit of `ChampionSet` by construction (R10, U1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChampionIdx(pub u8);

/// A set of champion indices: four 64-bit words (U1). `Hash`/`Eq` make it a key in its own right
/// (`transposition::Key`, `FeasibilityMemo`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ChampionSet([u64; WORDS]);

impl ChampionSet {
    pub const EMPTY: Self = Self([0; WORDS]);

    fn place(c: ChampionIdx) -> (usize, u64) {
        let i = usize::from(c.0);
        (i / 64, 1u64 << (i % 64))
    }

    pub fn with(mut self, c: ChampionIdx) -> Self {
        let (word, bit) = Self::place(c);
        self.0[word] |= bit;
        self
    }

    pub fn without(mut self, c: ChampionIdx) -> Self {
        let (word, bit) = Self::place(c);
        self.0[word] &= !bit;
        self
    }

    pub fn contains(self, c: ChampionIdx) -> bool {
        let (word, bit) = Self::place(c);
        self.0[word] & bit != 0
    }

    pub fn union(mut self, other: Self) -> Self {
        for (a, b) in self.0.iter_mut().zip(other.0) {
            *a |= b;
        }
        self
    }

    pub fn intersect(mut self, other: Self) -> Self {
        for (a, b) in self.0.iter_mut().zip(other.0) {
            *a &= b;
        }
        self
    }

    pub fn minus(mut self, other: Self) -> Self {
        for (a, b) in self.0.iter_mut().zip(other.0) {
            *a &= !b;
        }
        self
    }

    pub fn len(self) -> usize {
        self.0
            .iter()
            .map(|w| usize::try_from(w.count_ones()).expect("a u32 count fits usize"))
            .sum()
    }

    pub fn is_empty(self) -> bool {
        self.0 == [0; WORDS]
    }

    /// Ascending index order, set bits only (no scan of the 256 positions).
    pub fn iter(self) -> impl Iterator<Item = ChampionIdx> {
        self.0.into_iter().enumerate().flat_map(|(word, mut bits)| {
            std::iter::from_fn(move || {
                if bits == 0 {
                    return None;
                }
                let bit = usize::try_from(bits.trailing_zeros()).expect("a u32 fits usize");
                bits &= bits - 1;
                Some(ChampionIdx(
                    u8::try_from(word * 64 + bit).expect("four words hold 256 indices"),
                ))
            })
        })
    }
}

impl FromIterator<ChampionIdx> for ChampionSet {
    fn from_iter<I: IntoIterator<Item = ChampionIdx>>(iter: I) -> Self {
        iter.into_iter().fold(Self::EMPTY, Self::with)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Champion {
    pub id: String,
    pub positions: Vec<Role>,
    pub linear: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SynergyEntry {
    pub pair: [String; 2],
    pub value: f64,
}

/// `of` counters `over` by `value`; the reverse direction is `-value` (D3: antisymmetric).
#[derive(Clone, Debug, Deserialize)]
pub struct CounterEntry {
    pub of: String,
    pub over: String,
    pub value: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UniverseSpec {
    pub champions: Vec<Champion>,
    #[serde(default)]
    pub synergy: Vec<SynergyEntry>,
    #[serde(default)]
    pub counter: Vec<CounterEntry>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum UniverseError {
    #[error("more than {MAX_CHAMPIONS} champions")]
    TooMany,
    #[error("duplicate champion id {0:?}")]
    DuplicateChampion(String),
    #[error("unknown champion id {0:?}")]
    UnknownChampion(String),
    #[error("{0:?} paired with itself")]
    SelfPair(String),
    #[error("duplicate table entry for {0:?} and {1:?}")]
    DuplicateEntry(String, String),
    #[error("non-finite parameter on {0:?}")]
    NonFinite(String),
    #[error("{0:?} lists no position")]
    NoPositions(String),
    /// `from_tables`: a table is not `n × n` for the `n` champions given.
    #[error("{0} table is not {1}×{1}")]
    Shape(&'static str, usize),
}

#[derive(Clone, Debug)]
pub struct Universe {
    champions: Vec<Champion>,
    index: HashMap<String, ChampionIdx>,
    synergy: Vec<Vec<f64>>,
    counter: Vec<Vec<f64>>,
    loss: f64,
    off_pool_cost: f64,
    live_loss: f64,
    meta: HashMap<String, ChampionMeta>,
    /// Each champion's meta roles as the incumbent's mask (`crate::feasibility::champion_role_mask`),
    /// by index — what a role-tagged pool is read against (role-aware pools design § 1).
    role_masks: Vec<RoleMask>,
}

/// Interns ids in list order; refuses more than `MAX_CHAMPIONS` and duplicate ids. Shared by both
/// constructors so the cap and the index arithmetic live in one place.
fn intern(champions: &[Champion]) -> Result<HashMap<String, ChampionIdx>, UniverseError> {
    let n = champions.len();
    if n > MAX_CHAMPIONS {
        return Err(UniverseError::TooMany);
    }
    let mut index = HashMap::with_capacity(n);
    for (i, c) in champions.iter().enumerate() {
        let idx = ChampionIdx(u8::try_from(i).expect("capped at MAX_CHAMPIONS"));
        if index.insert(c.id.clone(), idx).is_some() {
            return Err(UniverseError::DuplicateChampion(c.id.clone()));
        }
    }
    Ok(index)
}

impl Universe {
    /// A fixture's entry lists (Tier A). Unknown ids, self-pairs and duplicate entries are
    /// rejected here; the dense checks are `from_tables`'.
    pub fn new(spec: UniverseSpec) -> Result<Self, UniverseError> {
        let n = spec.champions.len();
        let index = intern(&spec.champions)?;
        let lookup = |id: &str| -> Result<usize, UniverseError> {
            index
                .get(id)
                .map(|c| usize::from(c.0))
                .ok_or_else(|| UniverseError::UnknownChampion(id.to_string()))
        };

        let mut synergy = vec![vec![0.0; n]; n];
        let mut seen = HashSet::new();
        for e in &spec.synergy {
            let (a, b) = (lookup(&e.pair[0])?, lookup(&e.pair[1])?);
            if a == b {
                return Err(UniverseError::SelfPair(e.pair[0].clone()));
            }
            if !e.value.is_finite() {
                return Err(UniverseError::NonFinite(format!(
                    "syn({}, {})",
                    e.pair[0], e.pair[1]
                )));
            }
            if !seen.insert((a.min(b), a.max(b))) {
                return Err(UniverseError::DuplicateEntry(
                    e.pair[0].clone(),
                    e.pair[1].clone(),
                ));
            }
            synergy[a][b] = e.value;
            synergy[b][a] = e.value;
        }

        let mut counter = vec![vec![0.0; n]; n];
        let mut seen = HashSet::new();
        for e in &spec.counter {
            let (of, over) = (lookup(&e.of)?, lookup(&e.over)?);
            if of == over {
                return Err(UniverseError::SelfPair(e.of.clone()));
            }
            if !e.value.is_finite() {
                return Err(UniverseError::NonFinite(format!(
                    "ctr({} over {})",
                    e.of, e.over
                )));
            }
            if !seen.insert((of.min(over), of.max(over))) {
                return Err(UniverseError::DuplicateEntry(e.of.clone(), e.over.clone()));
            }
            counter[of][over] = e.value;
            counter[over][of] = -e.value;
        }

        Self::from_tables(spec.champions, &synergy, &counter)
    }

    /// Dense form (U2). Only the upper triangle (`a < b`) of each table is read: the lower
    /// triangle is written as `synergy[a][b]` and `-counter[a][b]`, so symmetry and antisymmetry
    /// hold by construction. Diagonals are ignored. Checks, in order: the cap, each champion's
    /// linear term finite and positions non-empty, duplicate ids, table shape, each read entry
    /// finite, and a finite `L`.
    pub fn from_tables(
        champions: Vec<Champion>,
        synergy: &[Vec<f64>],
        counter: &[Vec<f64>],
    ) -> Result<Self, UniverseError> {
        let n = champions.len();
        if n > MAX_CHAMPIONS {
            return Err(UniverseError::TooMany);
        }
        for c in &champions {
            if !c.linear.is_finite() {
                return Err(UniverseError::NonFinite(c.id.clone()));
            }
            if c.positions.is_empty() {
                return Err(UniverseError::NoPositions(c.id.clone()));
            }
        }
        let index = intern(&champions)?;
        if synergy.len() != n || synergy.iter().any(|row| row.len() != n) {
            return Err(UniverseError::Shape("synergy", n));
        }
        if counter.len() != n || counter.iter().any(|row| row.len() != n) {
            return Err(UniverseError::Shape("counter", n));
        }

        let mut syn = vec![vec![0.0; n]; n];
        let mut ctr = vec![vec![0.0; n]; n];
        let mut magnitude = 0.0;
        for c in &champions {
            magnitude += c.linear.abs();
        }
        for a in 0..n {
            for b in (a + 1)..n {
                let s = synergy[a][b];
                if !s.is_finite() {
                    return Err(UniverseError::NonFinite(format!(
                        "syn({}, {})",
                        champions[a].id, champions[b].id
                    )));
                }
                let k = counter[a][b];
                if !k.is_finite() {
                    return Err(UniverseError::NonFinite(format!(
                        "ctr({} over {})",
                        champions[a].id, champions[b].id
                    )));
                }
                syn[a][b] = s;
                syn[b][a] = s;
                ctr[a][b] = k;
                ctr[b][a] = -k;
                magnitude += s.abs() + k.abs();
            }
        }
        // R1: with the board added to a broken side's ±L, separating "feasible" from "this side infeasible"
        // needs L larger than the largest GAP between two boards (≤ 2·max|U|), not the largest board.
        let loss = 1.0 + 2.0 * magnitude;
        // Individual entries were checked finite above; their SUM can still overflow (e.g. two champions
        // each with a finite-but-huge `linear`). A non-finite L makes a both-infeasible leaf's board ± L
        // ± L evaluate to NaN downstream (search.rs, the oracle) — reject it here instead.
        if !loss.is_finite() {
            return Err(UniverseError::NonFinite("L".to_string()));
        }
        // U10: the flat off-pool cost P = L (the user's choice; `off_pool_cost`'s doc), and the live
        // rule's infeasibility band L' = L + 10·P, computed FROM P so the band follows the cost if P
        // ever moves, and written as that sum so `live_loss == loss + 10·off_pool_cost` holds bit for
        // bit for every L (11·L can differ from L + 10·L by an ulp). A finite L' is not enough on its
        // own: the largest live leaf is |board| + 5P + L' (a side broken alone with off-pool picks
        // made), so that bound must be finite too, or a leaf could reach +∞ and break the objective's
        // finite contract.
        let off_pool_cost = loss;
        let live_loss = loss + 10.0 * off_pool_cost;
        if !live_loss.is_finite() || !(magnitude + 5.0 * off_pool_cost + live_loss).is_finite() {
            return Err(UniverseError::NonFinite("L'".to_string()));
        }

        let meta: HashMap<String, ChampionMeta> = champions
            .iter()
            .map(|c| {
                (
                    c.id.clone(),
                    ChampionMeta {
                        id: c.id.clone(),
                        positions: c.positions.clone(),
                        ..Default::default()
                    },
                )
            })
            .collect();
        let role_masks = champions
            .iter()
            .map(|c| champion_role_mask(&c.id, &meta))
            .collect();

        Ok(Self {
            champions,
            index,
            synergy: syn,
            counter: ctr,
            loss,
            off_pool_cost,
            live_loss,
            meta,
            role_masks,
        })
    }

    pub fn len(&self) -> usize {
        self.champions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.champions.is_empty()
    }

    pub fn index(&self, id: &str) -> Option<ChampionIdx> {
        self.index.get(id).copied()
    }

    pub fn id(&self, c: ChampionIdx) -> &str {
        &self.champions[usize::from(c.0)].id
    }

    pub fn linear(&self, c: ChampionIdx) -> f64 {
        self.champions[usize::from(c.0)].linear
    }

    pub fn synergy(&self, a: ChampionIdx, b: ChampionIdx) -> f64 {
        self.synergy[usize::from(a.0)][usize::from(b.0)]
    }

    /// `ctr(blue, red)`: positive when the Blue champion counters the Red one.
    pub fn counter(&self, blue: ChampionIdx, red: ChampionIdx) -> f64 {
        self.counter[usize::from(blue.0)][usize::from(red.0)]
    }

    /// `L` (R1): strictly larger than the gap between any two reachable board values in this universe.
    pub fn loss(&self) -> f64 {
        self.loss
    }

    /// `pool_or_roster`'s off-pool cost P (slice-5 U10, the user's flat choice): `P = L > 2Σ`, so one
    /// off-pool pick outweighs any board difference and that rule is LEXICOGRAPHIC — the engine never
    /// prefers an off-pool pick while the pool can finish, however strong the champion; breaking
    /// one's own pool never pays; forcing the opponent off-pool is worth P per pick. A board-comparable
    /// P is NOT a constant change to that rule: legality stays gated while the pool can finish, so a
    /// lower P only makes breaking one's own pool the way to a strong roster champion (round 5
    /// measured it: at P = 0.1·L "ban your own support" is the top action and denial inverts). The
    /// board-comparable rule is `FeasibilityRule::Roster` (B-proper): always-widened legality with a
    /// P the caller passes per search (`OracleInput::off_pool_cost`, `DEFAULT_OFF_POOL_COST`).
    pub fn off_pool_cost(&self) -> f64 {
        self.off_pool_cost
    }

    /// `L'` (slice-5 U10): the infeasibility band under the live rules, `L + 10·L` — strictly larger
    /// than the gap between any two feasible live leaves, off-pool term included, for every P ≤ L
    /// (`objective.rs`, `live_leaf_value`; feasible live leaves span `board ± 5P ⊂ board ± 5L`);
    /// `from_tables` also guarantees that the largest live leaf, `Σ + 5L + L'`, is finite. Tier A's
    /// `loss` is unchanged.
    pub fn live_loss(&self) -> f64 {
        self.live_loss
    }

    pub fn all(&self) -> ChampionSet {
        (0..self.champions.len())
            .map(|i| ChampionIdx(u8::try_from(i).expect("capped at MAX_CHAMPIONS")))
            .collect()
    }

    /// Positions only; every other `ChampionMeta` field is `Default`. `role_solver::solve` is never
    /// called on this map — only `feasibility::can_complete_roles` reads it.
    pub fn champion_meta(&self) -> &HashMap<String, ChampionMeta> {
        &self.meta
    }

    /// The meta's roles for `c` as a mask (bit `i` = `crate::feasibility::ROLES[i]`).
    pub(crate) fn role_mask(&self, c: ChampionIdx) -> RoleMask {
        self.role_masks[usize::from(c.0)]
    }

    pub fn names(&self, champions: &[ChampionIdx]) -> Vec<String> {
        champions.iter().map(|c| self.id(*c).to_string()).collect()
    }

    pub fn names_of(&self, set: ChampionSet) -> Vec<String> {
        set.iter().map(|c| self.id(c).to_string()).collect()
    }
}
