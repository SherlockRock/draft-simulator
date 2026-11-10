//! The Tier B review runner (design docs/designs/tier-b-review-tool-design.md § 2): every (position,
//! arm) searched in parallel, the engine's options read back with the whole side each one makes, and
//! one versioned JSON, `tier-b-run/1`, out of it. The old report (`render_report`) is not touched.
//!
//! Two passes. First every search runs, `std::thread::scope` over an atomic job index with results
//! merged by index, so the output does not depend on which thread finished first. Then, per position,
//! the catalog is built from the full `ranked` lists: seeded from every source the design names, then
//! each seeded action is traced at each arm and matched on its complete key (action and comp).
//!
//! The wire structs here convert at the boundary: `Action`, `LeafEnd` and champion indices do not
//! derive `Serialize`, and champions go out as ids. The `f64`s serialise as they are.

use super::entries::role_key;
use super::feasibility::{
    action_charge, arrangement, placements, FeasibilityMemo, FeasibilityRule, Price, SidePlacement,
};
use super::live::LiveUniverse;
use super::oracle::{Mode, OracleInput};
use super::search::{search, RankedAction, SearchOutcome, SearchParams, Shortlist};
use super::state::{Action, Entry, Pools, Position};
use super::tier_b::{Category, Label, Loaded, OptionKey, TierBError, TierBFixture};
use super::universe::{ChampionIdx, Universe, DEFAULT_OFF_POOL_COST, DEFAULT_OFF_ROLE_COST};
use crate::cancellation::CancelHandle;
use crate::draft_state::{ActionType, Side};
use crate::feasibility::ROLES;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The near-tie margin ε of the design's Definitions: 0.01 logit, pre-registered, never a tuned knob.
pub const NEAR_TIE_MARGIN: f64 = 0.01;

/// The contract's name; additive changes keep `/1`.
pub const SCHEMA: &str = "tier-b-run/1";

/// Which engine produced a run: the binary fills `commit` and `dirty` (`None` where git is not there).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EngineStamp {
    pub name: String,
    pub commit: Option<String>,
    pub dirty: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct ReviewConfig {
    pub ps: Vec<f64>,
    pub qs: Vec<f64>,
    pub shortlist: Shortlist,
    pub horizon: usize,
    pub k: usize,
    pub margin: f64,
    pub jobs: usize,
    /// Read by the depth check (Task 4); the runner proper does not use it.
    pub depth_check: bool,
    pub node_budget: u64,
    pub run_id: String,
    pub engine: EngineStamp,
    pub positions_patch: String,
}

/// One rule and price. The ids are `pool_or_roster` and `roster:<P>:<Q>` with `f64`'s shortest display.
#[derive(Clone, Copy, Debug, PartialEq)]
enum ArmKind {
    PoolOrRoster,
    Roster { p: f64, q: f64 },
}

#[derive(Clone, Debug)]
struct Arm {
    id: String,
    kind: ArmKind,
}

impl ArmKind {
    fn id(self) -> String {
        match self {
            ArmKind::PoolOrRoster => "pool_or_roster".to_string(),
            ArmKind::Roster { p, q } => format!("roster:{p}:{q}"),
        }
    }

    fn rule(self) -> FeasibilityRule {
        match self {
            ArmKind::PoolOrRoster => FeasibilityRule::PoolOrRoster,
            ArmKind::Roster { .. } => FeasibilityRule::Roster,
        }
    }

    /// The memo price the arm's search prices at: what the class, the charge and every trace must read.
    fn price(self, universe: &Universe) -> Price {
        match self {
            ArmKind::PoolOrRoster => Price::of(universe.off_pool_cost(), 0.0),
            ArmKind::Roster { p, q } => Price::of(p, q),
        }
    }
}

/// `pool_or_roster`, then `roster` over Q-major, P-minor, then the reference arm if the grid lacks it.
/// A repeated id is kept once.
fn build_arms(cfg: &ReviewConfig) -> Vec<Arm> {
    let mut kinds = vec![ArmKind::PoolOrRoster];
    for q in &cfg.qs {
        for p in &cfg.ps {
            kinds.push(ArmKind::Roster { p: *p, q: *q });
        }
    }
    kinds.push(reference_kind());
    let mut arms: Vec<Arm> = Vec::new();
    for kind in kinds {
        let id = kind.id();
        if !arms.iter().any(|a| a.id == id) {
            arms.push(Arm { id, kind });
        }
    }
    arms
}

fn reference_kind() -> ArmKind {
    ArmKind::Roster {
        p: DEFAULT_OFF_POOL_COST,
        q: DEFAULT_OFF_ROLE_COST,
    }
}

// ---- the wire ---------------------------------------------------------------------------------------

/// How a top action's placements read (`tests/tier_b.rs`'s rule): in-pool; off-pool with a grade
/// charged (a graded charge on the action or an off-pool placement carrying a grade); off-pool without.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum TopClassName {
    #[serde(rename = "in-pool")]
    InPool,
    #[serde(rename = "off-pool base")]
    Base,
    #[serde(rename = "off-pool graded")]
    Graded,
}

#[derive(Debug, Serialize)]
pub struct ReviewRun {
    pub schema: &'static str,
    pub run: RunHeader,
    pub positions: Vec<PositionRead>,
    /// A malformed fixture is reported here, in its place: the rest of the corpus still runs.
    pub load_errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RunHeader {
    pub id: String,
    pub engine: EngineStamp,
    pub data: DataStamp,
    pub search: SearchStamp,
    pub k: usize,
    pub margin: f64,
    pub reference_arm: String,
    pub arms: Vec<ArmWire>,
}

#[derive(Debug, Serialize)]
pub struct DataStamp {
    pub fm_version: String,
    pub meta_version: String,
    pub positions_patch: String,
}

#[derive(Debug, Serialize)]
pub struct SearchStamp {
    pub horizon: usize,
    pub widths: WidthsWire,
    pub node_budget: u64,
    pub jobs: usize,
}

#[derive(Debug, Serialize)]
pub struct WidthsWire {
    pub singles: usize,
    pub pairs: usize,
    pub root_off_pool: usize,
}

#[derive(Debug, Serialize)]
pub struct ArmWire {
    pub id: String,
    pub rule: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct BoardWire {
    pub slot: usize,
    pub side: String,
    pub kind: &'static str,
    pub champion: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RoleVerdictWire {
    pub action: Vec<String>,
    pub roles: Vec<&'static str>,
    pub ok: bool,
}

/// The frozen legacy fields, read as they are.
#[derive(Debug, Serialize)]
pub struct LegacyWire {
    pub off_pool: Option<bool>,
    pub role_verdict: Option<RoleVerdictWire>,
}

#[derive(Debug, Serialize)]
pub struct LabelPair {
    /// Absent where the option has no blind label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blind: Option<&'static str>,
    pub current: &'static str,
}

/// The own pick per fold. A key absent: never answered. `null`: "no view". An array: the pick.
#[derive(Debug, Default, Serialize)]
pub struct PickPair {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blind: Option<Option<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<Option<Vec<String>>>,
}

/// The comp: role to champion id, in `ROLE_KEYS` order, a role the side has not filled left out.
#[derive(Debug, Serialize)]
pub struct CompWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jungle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SideWire {
    pub champion: String,
    pub role: &'static str,
    pub locked: bool,
    pub in_pool: bool,
    pub grade: u8,
    /// The placed role's share over the champion's largest; `null` where the shares are unknown.
    pub r: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct OptionRead {
    pub action: Vec<String>,
    pub comp: Option<CompWire>,
    /// The option's best rank over the roster arms; `null` where none of them ranked it.
    pub reach: Option<usize>,
    /// `reach` at most K, or in a roster arm's margin set at 3: the options a label is asked for.
    pub row: bool,
    /// In at least one roster arm's margin set at 3 (#3 or above, or within ε below #3, inclusive).
    /// `row` is `reach <= K || margin`.
    pub margin: bool,
    pub side: Vec<SideWire>,
}

#[derive(Debug, Serialize)]
pub struct BestInPool {
    pub option: String,
    pub rank: usize,
    pub value: f64,
}

#[derive(Debug, Serialize)]
pub struct EndsWire {
    pub kind: String,
    pub blue_feasible: bool,
    pub red_feasible: bool,
    pub blue_off_pool: usize,
    pub red_off_pool: usize,
    pub blue_grade: usize,
    pub red_grade: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct LineSideWire {
    pub champion: String,
    pub role: &'static str,
}

/// One continuation action of a line, with the side whose turn it is at the replay position and what
/// that step places (empty for a ban or an unarrangeable step). `line_side` is these placements
/// concatenated.
#[derive(Debug, Serialize)]
pub struct LineStepWire {
    pub side: String,
    pub kind: &'static str,
    pub champions: Vec<String>,
    pub placements: Vec<LineSideWire>,
}

#[derive(Debug, Serialize)]
pub struct RankedRead {
    pub option: String,
    pub rank: usize,
    pub value: f64,
    pub class: TopClassName,
    pub d_off: usize,
    pub d_grade: i16,
    /// Over the arm's best in-pool option, mover-signed; `null` where no in-pool action was ranked.
    pub gain_logit: Option<f64>,
    pub gain_pp: Option<f64>,
    pub mover_win_pct: f64,
    pub ends: EndsWire,
    pub line: Vec<Vec<String>>,
    pub line_side: Vec<LineSideWire>,
    pub line_steps: Vec<LineStepWire>,
}

#[derive(Debug, Serialize)]
pub struct Reading {
    pub arm: String,
    pub depth: Option<usize>,
    pub partial: Option<bool>,
    /// The search's failure, named; the other fields are then `null` and `ranked` is empty.
    pub error: Option<String>,
    pub seconds: f64,
    pub searched: Option<usize>,
    pub fan: Option<usize>,
    pub top_set: Option<usize>,
    pub best_in_pool: Option<BestInPool>,
    pub ranked: Vec<RankedRead>,
}

#[derive(Debug, Serialize)]
pub struct PositionRead {
    pub id: String,
    pub category: &'static str,
    pub notes: String,
    pub mover: String,
    pub slot: usize,
    pub kind: &'static str,
    pub board: Vec<BoardWire>,
    /// The fixture's `pools` as written (list or role map, authored order); `null` where absent.
    pub pools: serde_json::Value,
    pub exclusions: Vec<String>,
    pub actual_next: Option<Vec<String>>,
    pub warnings: Vec<String>,
    pub loader_notes: Vec<String>,
    pub review: String,
    pub legacy: LegacyWire,
    /// The fixture's entries, verbatim.
    pub verdicts: Vec<serde_json::Value>,
    /// How many entries the fixture held at this run (all of them, even where none is read).
    pub base: usize,
    pub labels: BTreeMap<String, LabelPair>,
    pub would_pick: PickPair,
    pub options: BTreeMap<String, OptionRead>,
    pub readings: Vec<Reading>,
}

// ---- the run ----------------------------------------------------------------------------------------

/// Runs every loaded position at every arm and reads the results into one `ReviewRun`.
pub fn run_review(
    loaded: &[Result<Loaded, TierBError>],
    live: &LiveUniverse,
    cfg: &ReviewConfig,
) -> ReviewRun {
    let arms = build_arms(cfg);
    let mut oks: Vec<&Loaded> = Vec::new();
    let mut load_errors = Vec::new();
    for l in loaded {
        match l {
            Ok(l) => oks.push(l),
            Err(e) => load_errors.push(e.to_string()),
        }
    }
    let n_arms = arms.len();
    let searched = parallel_map(oks.len() * n_arms, cfg.jobs, |n| {
        search_one(&oks[n / n_arms].fixture, arms[n % n_arms].kind, live, cfg)
    });
    let positions = parallel_map(oks.len(), cfg.jobs, |i| {
        read_position(
            oks[i],
            &searched[i * n_arms..(i + 1) * n_arms],
            &arms,
            live,
            cfg,
        )
    });
    ReviewRun {
        schema: SCHEMA,
        run: RunHeader {
            id: cfg.run_id.clone(),
            engine: cfg.engine.clone(),
            data: DataStamp {
                fm_version: live.fm_version.clone(),
                meta_version: live.meta_version.clone(),
                positions_patch: cfg.positions_patch.clone(),
            },
            search: SearchStamp {
                horizon: cfg.horizon,
                widths: WidthsWire {
                    singles: cfg.shortlist.singles,
                    pairs: cfg.shortlist.pairs,
                    root_off_pool: cfg.shortlist.root_off_pool,
                },
                node_budget: cfg.node_budget,
                jobs: cfg.jobs,
            },
            k: cfg.k,
            margin: cfg.margin,
            reference_arm: reference_kind().id(),
            arms: arms
                .iter()
                .map(|a| ArmWire {
                    id: a.id.clone(),
                    rule: a.kind.rule().wire_name(),
                    p: match a.kind {
                        ArmKind::Roster { p, .. } => Some(p),
                        ArmKind::PoolOrRoster => None,
                    },
                    q: match a.kind {
                        ArmKind::Roster { q, .. } => Some(q),
                        ArmKind::PoolOrRoster => None,
                    },
                })
                .collect(),
        },
        positions,
        load_errors,
    }
}

/// `f(0..n)` on `jobs` threads, an atomic index handing out the work, results in index order: the
/// output is the same whichever thread finishes first.
fn parallel_map<T: Send>(n: usize, jobs: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<(usize, T)>> = Mutex::new(Vec::with_capacity(n));
    std::thread::scope(|scope| {
        for _ in 0..jobs.clamp(1, n.max(1)) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= n {
                    break;
                }
                let value = f(i);
                done.lock()
                    .expect("a worker panicked holding the lock")
                    .push((i, value));
            });
        }
    });
    let mut all = done
        .into_inner()
        .expect("a worker panicked holding the lock");
    all.sort_by_key(|(i, _)| *i);
    all.into_iter().map(|(_, v)| v).collect()
}

struct Searched {
    outcome: Result<SearchOutcome, String>,
    seconds: f64,
}

fn search_one(
    fx: &TierBFixture,
    arm: ArmKind,
    live: &LiveUniverse,
    cfg: &ReviewConfig,
) -> Searched {
    let u = &live.universe;
    let started = Instant::now();
    let outcome = match fx.root.position(u) {
        Err(e) => Err(e.to_string()),
        Ok(position) => {
            let (off_pool_cost, off_role_cost) = match arm {
                ArmKind::PoolOrRoster => (None, None),
                ArmKind::Roster { p, q } => (Some(p), Some(q)),
            };
            search(
                &OracleInput {
                    position: &position,
                    universe: u,
                    pools: &fx.root.pools,
                    objective: u,
                    feasibility: arm.rule(),
                    mode: Mode::Horizon(cfg.horizon),
                    epsilon: 1e-9,
                    off_pool_cost,
                    off_role_cost,
                },
                &SearchParams {
                    node_budget: Some(cfg.node_budget),
                    wall_budget: Duration::from_secs(300),
                    shortlist: Some(cfg.shortlist),
                    ..SearchParams::default()
                },
                &CancelHandle::new(),
                |_| {},
            )
            .map_err(|e| e.to_string())
        }
    };
    Searched {
        outcome,
        seconds: started.elapsed().as_secs_f64(),
    }
}

// ---- reading one position ---------------------------------------------------------------------------

fn ids(action: Action, u: &Universe) -> Vec<String> {
    action.champions().map(|c| u.id(c).to_string()).collect()
}

fn category_name(category: Category) -> &'static str {
    match category {
        Category::ProReplay => "pro-replay",
        Category::CounterPick => "counter-pick",
        Category::FlexRetention => "flex-retention",
        Category::PairCoherence => "pair-coherence",
        Category::EdgeCase => "edge-case",
        Category::OffPool => "off-pool",
    }
}

fn comp_of(side: &[SidePlacement]) -> Option<[Option<ChampionIdx>; 5]> {
    if side.is_empty() {
        return None;
    }
    let mut comp = [None; 5];
    for p in side {
        if let Some(bit) = ROLES.iter().position(|r| *r == p.role) {
            comp[bit] = Some(p.champion);
        }
    }
    Some(comp)
}

fn comp_wire(comp: &[Option<ChampionIdx>; 5], u: &Universe) -> CompWire {
    let at = |i: usize| comp[i].map(|c| u.id(c).to_string());
    CompWire {
        top: at(0),
        jungle: at(1),
        mid: at(2),
        adc: at(3),
        support: at(4),
    }
}

fn side_wire(side: &[SidePlacement], u: &Universe) -> Vec<SideWire> {
    side.iter()
        .map(|p| SideWire {
            champion: u.id(p.champion).to_string(),
            role: role_key(p.role),
            locked: p.locked,
            in_pool: p.in_pool,
            grade: p.grade,
            r: match (u.share(p.champion, p.role), u.max_share(p.champion)) {
                (Some(s), Some(max)) if max > 0.0 => Some(s / max),
                _ => None,
            },
        })
        .collect()
}

/// The side a hand-written comp makes, for a labelled option no arm's trace produced: the locked
/// picks first, then the action's, each in the role the comp gives it.
fn side_of_comp(
    key: &OptionKey,
    mover: Side,
    mover_picks: &[ChampionIdx],
    pools: &Pools,
    u: &Universe,
) -> Vec<SidePlacement> {
    let Some(comp) = &key.comp else {
        return Vec::new();
    };
    mover_picks
        .iter()
        .copied()
        .map(|c| (c, true))
        .chain(key.action.champions().map(|c| (c, false)))
        .filter_map(|(champion, locked)| {
            let bit = comp.iter().position(|slot| *slot == Some(champion))?;
            let role = ROLES[bit];
            let in_pool = match pools.roles(mover) {
                Some(tags) => tags.for_role(role).contains(champion),
                None => pools.for_side(mover).contains(champion),
            };
            Some(SidePlacement {
                champion,
                role,
                grade: if in_pool { 0 } else { u.grade(champion, role) },
                in_pool,
                locked,
            })
        })
        .collect()
}

/// The mover's win probability from a Blue-perspective logit. The clamp is `scored_options_roles.py`'s:
/// the L' band (about 11 000) would overflow the exponential.
fn mover_win(value: f64, mover: Side) -> f64 {
    let blue = 1.0 / (1.0 + (-value.clamp(-60.0, 60.0)).exp());
    match mover {
        Side::Blue => blue,
        Side::Red => 1.0 - blue,
    }
}

fn mover_sign(mover: Side) -> f64 {
    match mover {
        Side::Blue => 1.0,
        Side::Red => -1.0,
    }
}

/// 1 + the number of strictly better values, as `tests/tier_b.rs` does: a tie reads as a tie. The list
/// is best-first, so a run of equal values shares its first rank.
fn ranks(values: &[f64]) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::with_capacity(values.len());
    for (i, v) in values.iter().enumerate() {
        match (i.checked_sub(1), out.last()) {
            (Some(prev), Some(rank)) if values[prev] == *v => out.push(*rank),
            _ => out.push(i + 1),
        }
    }
    out
}

/// How many leading entries have rank at most `k`: the top K by rank, so an action tied with #K that
/// sits at list position K + 1 is in it, as the rows (which read ranks) count it.
fn rank_prefix(ranks: &[usize], k: usize) -> usize {
    ranks.iter().take_while(|r| **r <= k).count()
}

/// The margin set at 3: the options ranked at or above #3, or within `margin` below its value (the
/// bound is inclusive). The list is best-first for the mover, so it is a prefix.
fn margin_len(outcome: &SearchOutcome, margin: f64) -> usize {
    let sign = mover_sign(outcome.mover);
    let Some(third) = outcome.ranked.get(2).or(outcome.ranked.last()) else {
        return 0;
    };
    let floor = sign * third.value - margin;
    outcome
        .ranked
        .iter()
        .take_while(|r| sign * r.value >= floor)
        .count()
        .max(outcome.ranked.len().min(3))
}

/// The placements of every continuation action, read at the position that action is played from: the
/// ranked root action is replayed, then each continuation action's side is the replay's next slot.
fn line_steps(
    position: &Position<'_>,
    pools: &Pools,
    u: &Universe,
    memo: &mut FeasibilityMemo,
    ranked: &RankedAction,
) -> Vec<LineStepWire> {
    let mut out = Vec::new();
    let mut replay = position.apply(ranked.action);
    for action in &ranked.continuation {
        let Some(slot) = replay.next_slot() else {
            break;
        };
        out.push(LineStepWire {
            side: format!("{:?}", slot.side),
            kind: match action {
                Action::Ban(_) => "ban",
                Action::Pick(_) | Action::Pair(..) => "pick",
            },
            champions: ids(*action, u),
            placements: placements(memo, slot.side, &replay, pools, u, *action)
                .into_iter()
                .map(|p| LineSideWire {
                    champion: u.id(p.champion).to_string(),
                    role: role_key(p.role),
                })
                .collect(),
        });
        replay = replay.apply(*action);
    }
    out
}

/// What the catalog knows of one option while it is built.
struct CatalogEntry {
    key: OptionKey,
    side: Vec<SidePlacement>,
    reach: Option<usize>,
    row: bool,
    margin: bool,
}

#[derive(Default)]
struct Catalog {
    at: HashMap<OptionKey, usize>,
    entries: Vec<CatalogEntry>,
}

impl Catalog {
    fn entry(&mut self, key: &OptionKey, side: impl FnOnce() -> Vec<SidePlacement>) -> usize {
        if let Some(i) = self.at.get(key) {
            return *i;
        }
        self.entries.push(CatalogEntry {
            key: key.clone(),
            side: side(),
            reach: None,
            row: false,
            margin: false,
        });
        self.at.insert(key.clone(), self.entries.len() - 1);
        self.entries.len() - 1
    }
}

/// One arm's search, with the charge's reading of its ranked list.
struct ArmView<'a> {
    arm: &'a Arm,
    searched: &'a Searched,
    /// `rank` per ranked action, when the search succeeded.
    ranks: Vec<usize>,
    /// Index into `ranked` of the first in-pool action, at a pick root.
    best_in_pool: Option<usize>,
}

fn read_position(
    loaded: &Loaded,
    searched: &[Searched],
    arms: &[Arm],
    live: &LiveUniverse,
    cfg: &ReviewConfig,
) -> PositionRead {
    let fx = &loaded.fixture;
    let u = &live.universe;
    let pools = &fx.root.pools;
    let position = fx
        .root
        .position(u)
        .expect("a loaded position builds: the loader built it once");
    let root = position
        .next_slot()
        .expect("a loaded position has a next slot");
    let mover = root.side;
    let pick_root = root.action == ActionType::Pick;
    let kind = if !pick_root {
        "ban"
    } else if root.pair_start {
        "pair"
    } else {
        "single"
    };
    let mover_picks = position.picks(mover);
    let resolved = fx.resolved();

    // One pass per arm over what the charge says: the in-pool ranking each arm's gains read from.
    let mut views: Vec<ArmView<'_>> = Vec::with_capacity(arms.len());
    let mut seeds: BTreeSet<Action> = BTreeSet::new();
    for (arm, s) in arms.iter().zip(searched) {
        let mut view = ArmView {
            arm,
            searched: s,
            ranks: Vec::new(),
            best_in_pool: None,
        };
        // A cut search (`partial`) leaves the position out at that arm (design § 2): no seeds, no
        // best in-pool, no rows, no `reach`; its reading is kept, flagged, with an empty `ranked`.
        if let Some(o) = s.outcome.as_ref().ok().filter(|o| !o.partial) {
            let values: Vec<f64> = o.ranked.iter().map(|r| r.value).collect();
            view.ranks = ranks(&values);
            let top = rank_prefix(&view.ranks, cfg.k);
            seeds.extend(o.ranked.iter().take(top).map(|r| r.action));
            if matches!(arm.kind, ArmKind::Roster { .. }) {
                let m = margin_len(o, cfg.margin);
                seeds.extend(o.ranked.iter().take(m).map(|r| r.action));
            }
            if pick_root {
                let mut memo = FeasibilityMemo::new(arm.kind.price(u));
                let charge = action_charge(&mut memo, arm.kind.rule(), mover, &position, pools, u);
                view.best_in_pool = o
                    .ranked
                    .iter()
                    .position(|r| charge.of(r.action).is_in_pool());
                if let Some(i) = view.best_in_pool {
                    seeds.insert(o.ranked[i].action);
                }
            }
        }
        views.push(view);
    }
    // The rest of the design's sources: every labelled option, the line verdicts, `actual_next`, both
    // own picks.
    seeds.extend(resolved.current.keys().map(|k| k.action));
    seeds.extend(resolved.blind.keys().map(|k| k.action));
    seeds.extend(resolved.lines.iter().map(|l| l.option.action));
    seeds.extend(fx.actual_next);
    for pick in [resolved.blind_pick, resolved.current_pick] {
        seeds.extend(pick.flatten());
    }

    // Trace every seeded action at every arm that ranked it and match the complete keys.
    let mut catalog = Catalog::default();
    let mut readings = Vec::with_capacity(views.len());
    for view in &views {
        let arm = view.arm;
        let seconds = view.searched.seconds;
        let outcome = match &view.searched.outcome {
            Err(message) => {
                readings.push(Reading {
                    arm: arm.id.clone(),
                    depth: None,
                    partial: None,
                    error: Some(message.clone()),
                    seconds,
                    searched: None,
                    fan: None,
                    top_set: None,
                    best_in_pool: None,
                    ranked: Vec::new(),
                });
                continue;
            }
            Ok(o) => o,
        };
        if outcome.partial {
            readings.push(Reading {
                arm: arm.id.clone(),
                depth: Some(outcome.depth),
                partial: Some(true),
                error: None,
                seconds,
                searched: Some(outcome.ranked.len()),
                fan: Some(outcome.root_fan),
                top_set: Some(outcome.top_set.len()),
                best_in_pool: None,
                ranked: Vec::new(),
            });
            continue;
        }
        let price = arm.kind.price(u);
        let mut memo = FeasibilityMemo::new(price);
        let charge = pick_root
            .then(|| action_charge(&mut memo, arm.kind.rule(), mover, &position, pools, u));
        let mut trace_memo = FeasibilityMemo::new(price);
        let roster = matches!(arm.kind, ArmKind::Roster { .. });
        let margin = margin_len(outcome, cfg.margin);
        let sign = mover_sign(mover);
        let best_in = view.best_in_pool.map(|i| &outcome.ranked[i]);
        let mut best_in_pool = None;
        let mut ranked_read = Vec::new();
        for (i, r) in outcome.ranked.iter().enumerate() {
            if !seeds.contains(&r.action) {
                continue;
            }
            let side = if pick_root {
                arrangement(&mut trace_memo, mover, &position, pools, u, r.action)
            } else {
                Vec::new()
            };
            let key = OptionKey {
                action: r.action,
                comp: comp_of(&side),
            };
            let id = key.id(u);
            let at = catalog.entry(&key, || side.clone());
            let rank = view.ranks[i];
            if roster {
                let e = &mut catalog.entries[at];
                e.reach = Some(e.reach.map_or(rank, |best| best.min(rank)));
                e.margin |= i < margin;
                e.row |= rank <= cfg.k || i < margin;
            }
            let (class, d_off, d_grade) = match &charge {
                None => (TopClassName::InPool, 0, 0),
                Some(charge) => {
                    let c = charge.of(r.action);
                    let class = if c.is_in_pool() {
                        TopClassName::InPool
                    } else if c.d_grade != 0
                        || side.iter().any(|p| !p.locked && !p.in_pool && p.grade > 0)
                    {
                        TopClassName::Graded
                    } else {
                        TopClassName::Base
                    };
                    (class, c.d_off, c.d_grade)
                }
            };
            if view.best_in_pool == Some(i) {
                best_in_pool = Some(BestInPool {
                    option: id.clone(),
                    rank,
                    value: r.value,
                });
            }
            // `+ 0.0` turns a Red `-0.0` into `0.0`.
            let gain_logit = best_in.map(|b| (r.value - b.value) * sign + 0.0);
            let gain_pp = best_in
                .map(|b| (mover_win(r.value, mover) - mover_win(b.value, mover)) * 100.0 + 0.0);
            let steps = line_steps(&position, pools, u, &mut trace_memo, r);
            ranked_read.push(RankedRead {
                option: id,
                rank,
                value: r.value,
                class,
                d_off,
                d_grade,
                gain_logit,
                gain_pp,
                mover_win_pct: mover_win(r.value, mover) * 100.0,
                ends: EndsWire {
                    kind: format!("{:?}", r.ends.kind),
                    blue_feasible: r.ends.blue_feasible,
                    red_feasible: r.ends.red_feasible,
                    blue_off_pool: r.ends.blue_off_pool,
                    red_off_pool: r.ends.red_off_pool,
                    blue_grade: r.ends.blue_grade,
                    red_grade: r.ends.red_grade,
                },
                line: r.continuation.iter().map(|a| ids(*a, u)).collect(),
                line_side: steps
                    .iter()
                    .flat_map(|s| s.placements.iter().cloned())
                    .collect(),
                line_steps: steps,
            });
        }
        readings.push(Reading {
            arm: arm.id.clone(),
            depth: Some(outcome.depth),
            partial: Some(outcome.partial),
            error: None,
            seconds,
            searched: Some(outcome.ranked.len()),
            fan: Some(outcome.root_fan),
            top_set: Some(outcome.top_set.len()),
            best_in_pool,
            ranked: ranked_read,
        });
    }
    // Every labelled option is in the catalog as written, also where no arm's arrangement matches it:
    // a label is matched by id, never carried to another arrangement.
    let labelled = resolved
        .current
        .keys()
        .chain(resolved.blind.keys())
        .chain(resolved.lines.iter().map(|l| &l.option));
    for key in labelled {
        catalog.entry(key, || side_of_comp(key, mover, mover_picks, pools, u));
    }

    let mut labels = BTreeMap::new();
    for (key, label) in &resolved.current {
        labels.insert(
            key.id(u),
            LabelPair {
                blind: resolved.blind.get(key).map(|l| Label::name(*l)),
                current: label.name(),
            },
        );
    }
    let pick = |p: Option<Option<Action>>| p.map(|inner| inner.map(|a| ids(a, u)));
    let options = catalog
        .entries
        .iter()
        .map(|e| {
            (
                e.key.id(u),
                OptionRead {
                    action: ids(e.key.action, u),
                    comp: e.key.comp.as_ref().map(|c| comp_wire(c, u)),
                    reach: e.reach,
                    row: e.row,
                    margin: e.margin,
                    side: side_wire(&e.side, u),
                },
            )
        })
        .collect();

    PositionRead {
        id: fx.id.clone(),
        category: category_name(fx.category),
        notes: fx.notes.clone(),
        mover: format!("{mover:?}"),
        slot: position.slot_index(),
        kind,
        board: fx
            .root
            .entries
            .iter()
            .enumerate()
            .map(|(slot, e)| BoardWire {
                slot,
                side: fx
                    .root
                    .format
                    .slot(slot)
                    .map_or_else(String::new, |s| format!("{:?}", s.side)),
                kind: match e {
                    Entry::Ban(_) => "ban",
                    Entry::Pick(_) => "pick",
                    Entry::Skip => "skip",
                },
                champion: match e {
                    Entry::Ban(c) | Entry::Pick(c) => Some(u.id(*c).to_string()),
                    Entry::Skip => None,
                },
            })
            .collect(),
        pools: fx.pools_raw.clone().unwrap_or(serde_json::Value::Null),
        exclusions: u.names_of(fx.root.excluded),
        actual_next: fx.actual_next.map(|a| ids(a, u)),
        warnings: loaded.warnings.clone(),
        loader_notes: loaded.notes.clone(),
        review: fx.review.clone(),
        legacy: LegacyWire {
            off_pool: fx.verdict.map(|v| v.off_pool),
            role_verdict: fx.role_verdict.as_ref().map(|v| RoleVerdictWire {
                action: ids(v.action, u),
                roles: v.roles.iter().map(|r| role_key(*r)).collect(),
                ok: v.ok,
            }),
        },
        verdicts: fx.verdicts_raw.clone(),
        base: fx.verdicts_raw.len(),
        labels,
        would_pick: PickPair {
            blind: pick(resolved.blind_pick),
            current: pick(resolved.current_pick),
        },
        options,
        readings,
    }
}

#[cfg(test)]
mod tests {
    use super::{parallel_map, rank_prefix, ranks};
    use std::time::Duration;

    /// The first job sleeps longest, so with one worker per job the results complete in reverse index
    /// order; the output must still be in index order. Kills: results merged in completion order (the
    /// sort removed fails this every time).
    #[test]
    fn parallel_map_returns_results_in_index_order_whatever_finishes_first() {
        let got = parallel_map(8, 8, |i| {
            std::thread::sleep(Duration::from_millis(
                15 * (8 - u64::try_from(i).unwrap_or(0)),
            ));
            i
        });
        assert_eq!(got, (0..8).collect::<Vec<_>>());
        assert_eq!(parallel_map(0, 4, |i| i), Vec::<usize>::new());
        assert_eq!(parallel_map(3, 1, |i| i * 2), [0, 2, 4]);
    }

    /// Ties share their first rank, and the top K by rank takes an action tied with #K that sits at
    /// list position K + 1. Kills: seeding by list position (`take(k)`).
    #[test]
    fn a_tie_with_the_kth_is_in_the_top_k_by_rank() {
        let r = ranks(&[3.0, 2.0, 2.0, 2.0, 1.0]);
        assert_eq!(r, [1, 2, 2, 2, 5]);
        assert_eq!(rank_prefix(&r, 3), 4);
        assert_eq!(rank_prefix(&r, 1), 1);
        assert_eq!(rank_prefix(&r, 5), 5);
        assert_eq!(rank_prefix(&[], 3), 0);
    }
}
