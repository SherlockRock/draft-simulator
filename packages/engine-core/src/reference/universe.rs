//! A universe (design § 3, D1; slice-5 design § 2–3): champions with positions and a linear term,
//! a symmetric synergy table and an antisymmetric counter table. Ids are interned to `u8`
//! indices; sets are 256-bit bitmasks. Strings appear only at the JSON boundary and in messages.
//!
//! Two constructors: [`Universe::new`] from a fixture's entry lists (Tier A) and
//! [`Universe::from_tables`] from dense matrices (the live universe, `super::live`).

use crate::feasibility::{champion_role_mask, roles_mask, RoleMask, ROLES};
use crate::pools::Role;
use crate::role_solver::ChampionMeta;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// The off-pool cost P under `FeasibilityRule::Roster` (B-proper design B5, § 3): blue-win logits,
/// about 2.5 percentage points of win probability near an even game. First calibrated 2026-09-29 on
/// list pools (seven verdicts, P > 0.09 and P < 0.11; the user chose 0.10 over the 0.15 assumption).
/// Recalibrated 2026-10-04 on ROLE MAPS (role-aware pools, slice 7), where an off-role pilot costs P
/// too: the corpus `fixtures/tier-b/2026-09-29-*` + `2026-10-04-*` — 21 positions of the user's
/// Kittens vs DME pinch drafts (the five parked September boards as recorded, three continuations
/// re-derived under role maps and vetted, six engine-selected earlier stops), 20 verdicts after one
/// was dropped as unable to bound P. Nineteen are consistent with 0.10 < P < 0.11 at a 0.01 sweep
/// step (reports `docs/plans/2026-10-04-engine-recalibration/report-4-verdicts-prefix.txt`,
/// `report-5-verdicts-fine.txt`); the one kept conflict (the re-derived supp-19, "stay" against a
/// 3.9 pp gain) would need P > 0.155. The user kept 0.10: the lower edge, which leans toward leaving
/// as the verdicts did. Caveats recorded with the verdicts: the user read the engine's scores
/// (not blind) and reports some inaccuracy, and the meta's position lists are loose (Syndra, Hwei
/// and Katarina at BOTTOM, Camille at SUPPORT), so roster options the user would never play reach
/// the ranking — a secondary-role option was the engine's top on 4 of the 21 positions. That is
/// what the graded off-role cost prices (`DEFAULT_OFF_ROLE_COST`, engine slice 8; the champion-meta
/// `playable` floor is NOT the fix — it only widens the mask); re-read P once Q is calibrated (the
/// report, the same files). The one kept conflict is a role question: under the grade Zyra-at-adc
/// pays for its secondary role and Ashe is the top from Q ≈ 0.077.
pub const DEFAULT_OFF_POOL_COST: f64 = 0.10;

/// The graded off-role cost Q under `FeasibilityRule::Roster` (engine-role-grade design G4): blue-win
/// logits per 100 grade units — a champion placed outside its pool entries in a secondary meta role
/// pays, beside P, `Q · (1 − share(role) / share(primary))` (`Universe::grade`). An ASSUMPTION, not a
/// calibration: 0.05 is half of P, chosen so that the roster fan's secondary-role options are priced
/// without being priced out (at 0.05 the supp-19 Zyra-at-adc line stays ahead of Ashe; it flips at
/// Q > 0.077 — design fact 6). To be calibrated on Tier B by the verdict-interval procedure at
/// P = 0.105 (`TIER_B_Q`, `fixtures/tier-b/README.md` "Calibrating Q"), after the positions refresh
/// re-exports with its recency rule. `pool_or_roster` charges Q = 0; list-form sides are never graded.
pub const DEFAULT_OFF_ROLE_COST: f64 = 0.05;

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
    /// The Master+ play share of each listed role, aligned with `positions`, or empty = unknown
    /// (engine-role-grade design § 1, G10). Tier A fixtures omit it; the live universe copies
    /// `ChampionMeta::position_shares`. `from_tables` validates it (one finite share in (0, 1] per
    /// position, the maximum first — `positions[0]` is the primary by construction) and precomputes
    /// each role's grade from it.
    #[serde(default)]
    pub shares: Vec<f64>,
    /// The engine's legality set (champion-meta.json's `playable`, champion-role-shares design
    /// § 4.1), or empty = unknown → the positions. Tier A fixtures omit it; the live universe copies
    /// `ChampionMeta::playable`. Read by the TAGGED path alone (`Universe::playable_mask`, U2): the
    /// positions-only meta map serves list-form sides and every `tags_for` = `None` context.
    #[serde(default)]
    pub playable: Vec<Role>,
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
    /// `Champion::shares` is neither empty nor one finite share in (0, 1] per listed position with the
    /// maximum first (engine-role-grade design § 1).
    #[error("{0:?}: shares must be empty or one finite share in (0, 1] per listed position, the maximum first")]
    Shares(String),
    /// `Champion::playable` is non-empty and lacks a listed position (the fallback assumes
    /// `positions ⊆ playable`; champion-role-shares design § 4.1).
    #[error("{0:?}: playable must be empty or contain every listed position")]
    Playable(String),
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
    /// by index — the positions (role-aware pools design § 1).
    role_masks: Vec<RoleMask>,
    /// Each champion's legality mask, by index: its `playable`, or its positions when the meta has
    /// none (champion-role-shares design § 4.1, U2) — what a role-tagged side is read against.
    playable_masks: Vec<RoleMask>,
    /// Each champion's grade per role, bit `i` = `ROLES[i]` (engine-role-grade design G1): 0 at the
    /// primary, `round(100 · (1 − share(role) / share(primary)))` at another listed role, 100 at a role
    /// never played; all 0 when the shares are unknown. Read only for a placement outside the side's
    /// pool entries in a meta role (`reference::feasibility`).
    grades: Vec<[u8; 5]>,
}

/// `x` as a `u8` for an integral `x` in `0..=100` (a rounded, clamped grade), without a numeric cast.
fn grade_unit(x: f64) -> u8 {
    (0..=100u8)
        .find(|g| f64::from(*g) == x)
        .expect("a rounded, clamped grade is an integer in 0..=100")
}

/// G1 for one champion: the grade of every role from its shares. `f64::round` — half away from zero:
/// shares `[0.8, 0.1]` grade the second role 88, not 87 (`1 − 0.125 = 0.875`, exactly representable).
fn grades_of(c: &Champion) -> Result<[u8; 5], UniverseError> {
    if c.shares.is_empty() {
        return Ok([0; 5]);
    }
    let primary = c.shares[0];
    let well_formed = c.shares.len() == c.positions.len()
        && c.shares
            .iter()
            .all(|s| s.is_finite() && *s > 0.0 && *s <= 1.0 && *s <= primary);
    if !well_formed {
        return Err(UniverseError::Shares(c.id.clone()));
    }
    let mut grades = [100u8; 5];
    for (bit, role) in ROLES.iter().enumerate() {
        if let Some(i) = c.positions.iter().position(|r| r == role) {
            let shortfall = (100.0 * (1.0 - c.shares[i] / primary)).round();
            grades[bit] = grade_unit(shortfall.clamp(0.0, 100.0));
        }
    }
    Ok(grades)
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
            if !c.playable.is_empty() && c.positions.iter().any(|p| !c.playable.contains(p)) {
                return Err(UniverseError::Playable(c.id.clone()));
            }
        }
        let grades = champions
            .iter()
            .map(grades_of)
            .collect::<Result<Vec<_>, _>>()?;
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
        let playable_masks = champions
            .iter()
            .map(|c| {
                roles_mask(if c.playable.is_empty() {
                    &c.positions
                } else {
                    &c.playable
                })
            })
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
            playable_masks,
            grades,
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
    /// than the gap between any two feasible live leaves, off-pool and grade terms included, for every
    /// P + Q ≤ L (`objective.rs`, `live_leaf_value`; feasible live leaves span `board ± 5(P + Q) ⊂
    /// board ± 5L`; `oracle::resolve_off_role_cost` refuses P + Q > L);
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

    /// Positions only — `playable` is NOT carried here (U2); every other `ChampionMeta` field is
    /// `Default`. The string predicates' input: `can_complete_roles`, `max_role_matching` and
    /// `max_role_assignment` on list-form sides and every `tags_for` = `None` context
    /// (`reference::feasibility::{locked_matchable, can_complete_from, role_rank, critical_pool}`).
    /// `role_solver::solve` is never called on this map.
    pub fn champion_meta(&self) -> &HashMap<String, ChampionMeta> {
        &self.meta
    }

    /// The meta's roles for `c` as a mask (bit `i` = `crate::feasibility::ROLES[i]`): the positions.
    pub(crate) fn role_mask(&self, c: ChampionIdx) -> RoleMask {
        self.role_masks[usize::from(c.0)]
    }

    /// The roles a role-tagged side may seat `c` in (champion-role-shares design § 4.1): its
    /// `playable`, or its positions when the meta has none — bit `i` = `ROLES[i]`.
    pub(crate) fn playable_mask(&self, c: ChampionIdx) -> RoleMask {
        self.playable_masks[usize::from(c.0)]
    }

    /// `playable_mask` read for one role.
    pub fn is_playable(&self, c: ChampionIdx, role: Role) -> bool {
        let bit = ROLES
            .iter()
            .position(|r| *r == role)
            .expect("ROLES holds every Role");
        (self.playable_mask(c) >> bit) & 1 == 1
    }

    /// `c`'s grade in `role` (engine-role-grade design G1, `Universe::grades`): 0 at the primary and
    /// whenever the shares are unknown, 100 at a role never played.
    pub fn grade(&self, c: ChampionIdx, role: Role) -> u8 {
        let bit = ROLES
            .iter()
            .position(|r| *r == role)
            .expect("ROLES holds every Role");
        self.grades[usize::from(c.0)][bit]
    }

    /// `c`'s grades, bit `i` = `ROLES[i]` — the solver's form (`reference::feasibility::Profile`).
    pub(crate) fn grades(&self, c: ChampionIdx) -> [u8; 5] {
        self.grades[usize::from(c.0)]
    }

    /// `c`'s Master+ play share in `role` (`Champion::shares`): `None` when the shares are unknown or
    /// the role is not listed. The report prints `r = share(role) / share(primary)` beside a graded
    /// placement.
    pub fn share(&self, c: ChampionIdx, role: Role) -> Option<f64> {
        let champion = &self.champions[usize::from(c.0)];
        if champion.shares.len() != champion.positions.len() {
            return None;
        }
        champion
            .positions
            .iter()
            .position(|r| *r == role)
            .map(|i| champion.shares[i])
    }

    /// `c`'s primary role: `positions[0]`, the argmax share by construction (positions refresh slice 1).
    pub fn primary(&self, c: ChampionIdx) -> Role {
        self.champions[usize::from(c.0)].positions[0]
    }

    pub fn names(&self, champions: &[ChampionIdx]) -> Vec<String> {
        champions.iter().map(|c| self.id(*c).to_string()).collect()
    }

    pub fn names_of(&self, set: ChampionSet) -> Vec<String> {
        set.iter().map(|c| self.id(c).to_string()).collect()
    }
}
