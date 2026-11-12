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
    action_charge, arrangement, open_roles, placements, Charge, FeasibilityMemo, FeasibilityRule,
    Price, SidePlacement,
};
use super::live::LiveUniverse;
use super::node::LeafEnd;
use super::oracle::{Mode, OracleInput};
use super::search::{search, RankedAction, SearchOutcome, SearchParams, Shortlist};
use super::state::{Action, Entry, Pools, Position};
use super::tier_b::{
    Category, Label, Loaded, OptionKey, ResolvedVerdicts, TierBError, TierBFixture,
};
use super::tier_b_rule::{
    canonical_line, line_text, read_run, ArmInput, ArmRole, ArmSpec, Fold, LabelChange, PickChange,
    PositionInput, RBucket, Read, RevealRead, TopLine, FLOOR_RATIOS,
};
use super::tier_b_summary::metrics_json_of;
pub use super::tier_b_summary::{render_summary, summary_of};
use super::universe::{ChampionIdx, Universe, DEFAULT_OFF_POOL_COST, DEFAULT_OFF_ROLE_COST};
use crate::cancellation::CancelHandle;
use crate::draft_state::{ActionType, Side};
use crate::feasibility::ROLES;
use crate::pools::Role;
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
    /// Search the reference arm once more at `horizon + 1` and record per position whether it held.
    pub depth_check: bool,
    pub node_budget: u64,
    pub run_id: String,
    pub engine: EngineStamp,
    pub positions_patch: String,
    /// The meta's `sources.positions.playableRule`, verbatim (design § 3); `None` where the meta has none.
    pub playable_rule: Option<serde_json::Value>,
}

/// One rule and price. The ids are `pool_or_roster` and `roster:<P>:<Q>` with `f64`'s shortest display;
/// a weighted arm (a roster arm searched in a universe of synergy weight `w`) is `roster:<P>:<Q>:w<w>`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum ArmKind {
    PoolOrRoster,
    Roster { p: f64, q: f64 },
    Weighted { p: f64, q: f64, w: f64 },
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
            ArmKind::Weighted { p, q, w } => format!("roster:{p}:{q}:w{w}"),
        }
    }

    fn rule(self) -> FeasibilityRule {
        match self {
            ArmKind::PoolOrRoster => FeasibilityRule::PoolOrRoster,
            ArmKind::Roster { .. } | ArmKind::Weighted { .. } => FeasibilityRule::Roster,
        }
    }

    /// The memo price the arm's search prices at: what the class, the charge and every trace must read.
    fn price(self, universe: &Universe) -> Price {
        match self {
            ArmKind::PoolOrRoster => Price::of(universe.off_pool_cost(), 0.0),
            ArmKind::Roster { p, q } | ArmKind::Weighted { p, q, .. } => Price::of(p, q),
        }
    }

    /// A roster arm of the P x Q grid or a weighted one: both count in the catalog (`reach`, rows, the
    /// margin set), only the first is the rule's.
    fn is_roster_like(self) -> bool {
        matches!(self, ArmKind::Roster { .. } | ArmKind::Weighted { .. })
    }
}

/// `pool_or_roster`, then `roster` over Q-major, P-minor, then the reference arm if the grid lacks it.
/// Then one weighted arm per weighted weight, in the order given, at the reference arm's P and Q.
/// A repeated id is kept once.
fn build_arms(cfg: &ReviewConfig, weights: &[f64]) -> Vec<Arm> {
    let mut kinds = vec![ArmKind::PoolOrRoster];
    for q in &cfg.qs {
        for p in &cfg.ps {
            kinds.push(ArmKind::Roster { p: *p, q: *q });
        }
    }
    kinds.push(reference_kind());
    for w in weights {
        kinds.push(ArmKind::Weighted {
            p: DEFAULT_OFF_POOL_COST,
            q: DEFAULT_OFF_ROLE_COST,
            w: *w,
        });
    }
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
    /// The rule's reading of the run (design § 4), kept in memory, not serialised: `metrics` (below) is its view in the JSON.
    #[serde(skip)]
    pub read: Read,
    /// What the rule read, for the page's results tab and the summary (`tier_b_summary`). Additive to
    /// `tier-b-run/1`: absent when no position carries a label or an own pick.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<serde_json::Value>,
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
    /// The meta's `sources.positions.playableRule`, verbatim; skipped when the meta has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playable_rule: Option<serde_json::Value>,
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
    /// The synergy weight, on weighted arms only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
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

/// The reference arm searched one ply deeper (design § 2). `stable` is the same #1 and the same top-3
/// set by action; every reading is `null` where either search failed or was cut. `top_3` is the deeper
/// search's top three, so the page can name what moved in.
#[derive(Debug, Serialize)]
pub struct DepthCheckWire {
    pub horizon: usize,
    pub stable: Option<bool>,
    pub same_first: Option<bool>,
    pub same_top_3: Option<bool>,
    pub top_3: Vec<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct RankedActionWire {
    pub action: Vec<String>,
    pub rank: usize,
    pub value: f64,
}

#[derive(Debug, Serialize)]
pub struct MenuBest {
    pub option: String,
    pub rank: usize,
    pub gain_logit: Option<f64>,
    pub gain_pp: Option<f64>,
}

/// One pool champion for an open role: `status` is `open`, or what the board did with it (`banned`,
/// `picked`, `excluded`), and `best` is the best in-pool action carrying it at the reference arm
/// (`null` where the board took it or no such action was ranked).
#[derive(Debug, Serialize)]
pub struct MenuEntry {
    pub champion: String,
    pub status: &'static str,
    pub best: Option<MenuBest>,
}

/// The mover's pool per open role, in `ROLE_KEYS` order; a role that is not open is left out. Empty at
/// a ban root, for a list-form side and for a side with no valid arrangement.
#[derive(Debug, Default, Serialize)]
pub struct MenuWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<Vec<MenuEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jungle: Option<Vec<MenuEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid: Option<Vec<MenuEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adc: Option<Vec<MenuEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support: Option<Vec<MenuEntry>>,
}

/// The id's text between the `YYYY-MM-DD-` prefix and `-pinch` or `-slot-` (`supp`, `top`,
/// `synth-dme-adc`); the whole id when there is no date prefix, neither marker, or nothing between.
pub fn draft_of(id: &str) -> String {
    let b = id.as_bytes();
    let dated = b.len() > 11
        && b[..11].iter().enumerate().all(|(i, c)| match i {
            4 | 7 | 10 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    if !dated {
        return id.to_string();
    }
    let rest = &id[11..];
    match ["-pinch", "-slot-"]
        .iter()
        .filter_map(|m| rest.find(m))
        .min()
    {
        Some(at) if at > 0 => rest[..at].to_string(),
        _ => id.to_string(),
    }
}

#[derive(Debug, Serialize)]
pub struct PositionRead {
    pub id: String,
    pub draft: String,
    pub category: &'static str,
    pub notes: String,
    pub mover: String,
    pub slot: usize,
    pub kind: &'static str,
    /// Absent when the run was made without the depth check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_check: Option<DepthCheckWire>,
    pub board: Vec<BoardWire>,
    /// The fixture's `pools` as written (list or role map, authored order); `null` where absent.
    pub pools: serde_json::Value,
    pub exclusions: Vec<String>,
    pub actual_next: Option<Vec<String>>,
    /// The role sets the mover's locked picks leave open (`open_roles`); empty for a list-form side AND
    /// for a side with no valid arrangement: it does not say which.
    pub open_roles: Vec<Vec<&'static str>>,
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
    /// The reference arm's whole ranking, best first: an own pick anywhere has a rank. Empty where that
    /// search failed or was cut.
    pub reference_ranking: Vec<RankedActionWire>,
    pub menu: MenuWire,
    /// What the rule reads (design § 4), prepared before anything is pruned. In memory only.
    #[serde(skip)]
    pub scoring: PositionInput,
}

// ---- the run ----------------------------------------------------------------------------------------

/// Runs every loaded position at every arm and reads the results into one `ReviewRun`: no weighted arm.
pub fn run_review(
    loaded: &[Result<Loaded, TierBError>],
    live: &LiveUniverse,
    cfg: &ReviewConfig,
) -> ReviewRun {
    run_review_with(loaded, live, &[], cfg)
}

/// `run_review` with one weighted arm per `weighted` universe (design § 3), each searched in its own
/// universe at the reference arm's P and Q. Everything else reads `base`. A universe whose weight is
/// `base`'s adds no arm (that arm already exists).
pub fn run_review_with(
    loaded: &[Result<Loaded, TierBError>],
    base: &LiveUniverse,
    weighted: &[LiveUniverse],
    cfg: &ReviewConfig,
) -> ReviewRun {
    let live = base;
    // `+ 0.0` turns a `-0.0` into `0.0`, so no arm id reads `w-0`.
    let weights: Vec<f64> = weighted
        .iter()
        .map(|u| u.synergy_weight + 0.0)
        .filter(|w| *w != base.synergy_weight)
        .collect();
    let arms = build_arms(cfg, &weights);
    // The universe each arm is searched in: its own `w`'s, else the base.
    let arm_live: Vec<&LiveUniverse> = arms
        .iter()
        .map(|a| match a.kind {
            ArmKind::Weighted { w, .. } => weighted
                .iter()
                .find(|u| u.synergy_weight == w)
                .expect("a weighted arm is built from a weighted universe"),
            _ => base,
        })
        .collect();
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
        search_one(
            &oks[n / n_arms].fixture,
            arms[n % n_arms].kind,
            cfg.horizon,
            arm_live[n % n_arms],
            cfg,
        )
    });
    // The depth check: the reference arm once more, one ply deeper, after the grid.
    let deep = cfg.depth_check.then(|| {
        parallel_map(oks.len(), cfg.jobs, |i| {
            search_one(
                &oks[i].fixture,
                reference_kind(),
                cfg.horizon + 1,
                live,
                cfg,
            )
        })
    });
    let positions = parallel_map(oks.len(), cfg.jobs, |i| {
        read_position(
            oks[i],
            &searched[i * n_arms..(i + 1) * n_arms],
            deep.as_ref().map(|d| &d[i]),
            &arms,
            live,
            cfg,
        )
    });
    let mut run = ReviewRun {
        schema: SCHEMA,
        run: RunHeader {
            id: cfg.run_id.clone(),
            engine: cfg.engine.clone(),
            data: DataStamp {
                fm_version: live.fm_version.clone(),
                meta_version: live.meta_version.clone(),
                positions_patch: cfg.positions_patch.clone(),
                playable_rule: cfg.playable_rule.clone(),
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
                        ArmKind::Roster { p, .. } | ArmKind::Weighted { p, .. } => Some(p),
                        ArmKind::PoolOrRoster => None,
                    },
                    q: match a.kind {
                        ArmKind::Roster { q, .. } | ArmKind::Weighted { q, .. } => Some(q),
                        ArmKind::PoolOrRoster => None,
                    },
                    w: match a.kind {
                        ArmKind::Weighted { w, .. } => Some(w),
                        _ => None,
                    },
                })
                .collect(),
        },
        read: read_of(&positions, &arms, cfg.margin),
        positions,
        load_errors,
        metrics: None,
    };
    run.metrics = metrics_json_of(&run);
    run
}

/// The rule's reading of the whole run: the arms, then the floor rows, through `read_run`.
fn read_of(positions: &[PositionRead], arms: &[Arm], margin: f64) -> Read {
    let mut specs: Vec<ArmSpec> = arms
        .iter()
        .map(|a| match a.kind {
            ArmKind::PoolOrRoster => ArmSpec {
                id: a.id.clone(),
                role: ArmRole::PoolOrRoster,
                p: None,
                q: None,
                w: None,
            },
            ArmKind::Roster { p, q } => ArmSpec {
                id: a.id.clone(),
                role: ArmRole::Roster,
                p: Some(p),
                q: Some(q),
                w: None,
            },
            ArmKind::Weighted { p, q, w } => ArmSpec {
                id: a.id.clone(),
                role: ArmRole::Weight,
                p: Some(p),
                q: Some(q),
                w: Some(w),
            },
        })
        .collect();
    specs.extend(FLOOR_RATIOS.iter().map(|r| ArmSpec {
        id: floor_id(*r),
        role: ArmRole::Floor,
        p: None,
        q: None,
        w: None,
    }));
    let inputs: Vec<&PositionInput> = positions.iter().map(|p| &p.scoring).collect();
    read_run(&inputs, &specs, &reference_kind().id(), margin)
}

/// A floor row's id: `floor:0.1`, `floor:0.25`.
fn floor_id(ratio: f64) -> String {
    format!("floor:{ratio}")
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
    horizon: usize,
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
                ArmKind::Roster { p, q } | ArmKind::Weighted { p, q, .. } => (Some(p), Some(q)),
            };
            search(
                &OracleInput {
                    position: &position,
                    universe: u,
                    pools: &fx.root.pools,
                    objective: u,
                    feasibility: arm.rule(),
                    mode: Mode::Horizon(horizon),
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

/// How an action's placements read: in-pool; off-pool with a grade charged (a graded charge on the
/// action, or an off-pool placement of the action's own carrying a grade); off-pool without.
fn class_of(c: Charge, side: &[SidePlacement]) -> TopClassName {
    if c.is_in_pool() {
        TopClassName::InPool
    } else if c.d_grade != 0 || side.iter().any(|p| !p.locked && !p.in_pool && p.grade > 0) {
        TopClassName::Graded
    } else {
        TopClassName::Base
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

/// A placement's share ratio `r`: the champion's share in that role over its largest; `None` where the
/// meta lists no share.
fn share_ratio(u: &Universe, champion: ChampionIdx, role: Role) -> Option<f64> {
    match (u.share(champion, role), u.max_share(champion)) {
        (Some(s), Some(max)) if max > 0.0 => Some(s / max),
        _ => None,
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
            r: share_ratio(u, p.champion, p.role),
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

/// An option's gain over the arm's best in-pool option, mover-signed: in logits, and in win-probability
/// points. `+ 0.0` turns a Red `-0.0` into `0.0`.
fn gains(value: f64, best_in_pool: f64, mover: Side) -> (f64, f64) {
    (
        (value - best_in_pool) * mover_sign(mover) + 0.0,
        (mover_win(value, mover) - mover_win(best_in_pool, mover)) * 100.0 + 0.0,
    )
}

impl MenuWire {
    fn set(&mut self, role: Role, entries: Vec<MenuEntry>) {
        let slot = match role {
            Role::Top => &mut self.top,
            Role::Jungle => &mut self.jungle,
            Role::Middle => &mut self.mid,
            Role::Adc => &mut self.adc,
            Role::Support => &mut self.support,
        };
        *slot = Some(entries);
    }
}

/// The mover's pool for each open role, read from the reference arm's ranking (design § 2). Empty at a
/// ban root, for a list-form side, and where no role is open.
fn menu_of(
    view: &ArmView<'_>,
    position: &Position<'_>,
    open: &[Vec<Role>],
    pools: &Pools,
    u: &Universe,
) -> MenuWire {
    let mut menu = MenuWire::default();
    let Some(outcome) = view.searched.outcome.as_ref().ok().filter(|o| !o.partial) else {
        return menu;
    };
    let Some(mover) = position.mover() else {
        return menu;
    };
    let Some(tags) = pools.roles(mover) else {
        return menu;
    };
    let best_in = view.best_in_pool.map(|i| outcome.ranked[i].value);
    let mut memo = FeasibilityMemo::new(view.arm.kind.price(u));
    for role in ROLES {
        if !open.iter().any(|set| set.contains(&role)) {
            continue;
        }
        let entries = tags
            .for_role(role)
            .iter()
            .map(|c| {
                let status = board_status(position, c);
                let best = match (status, view.menu_best.get(&c)) {
                    (None, Some(i)) => {
                        let r = &outcome.ranked[*i];
                        let side = arrangement(&mut memo, mover, position, pools, u, r.action);
                        let key = OptionKey {
                            action: r.action,
                            comp: comp_of(&side),
                        };
                        let gain = best_in.map(|b| gains(r.value, b, mover));
                        Some(MenuBest {
                            option: key.id(u),
                            rank: view.ranks[*i],
                            gain_logit: gain.map(|g| g.0),
                            gain_pp: gain.map(|g| g.1),
                        })
                    }
                    _ => None,
                };
                MenuEntry {
                    champion: u.id(c).to_string(),
                    status: status.unwrap_or("open"),
                    best,
                }
            })
            .collect();
        menu.set(role, entries);
    }
    menu
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
    /// Reference arm at a pick root only: per champion, the index into `ranked` of the best in-pool
    /// action carrying it (what `menu` reads).
    menu_best: HashMap<ChampionIdx, usize>,
}

/// `(same #1, same top-3 set, stable)` of two rankings, each best first with ties in canonical order (the
/// search's order). The top 3 is the first three of the list, so a tie at #3 is resolved by that order,
/// not reported. `stable` is both.
fn same_top(a: &[Action], b: &[Action]) -> (bool, bool, bool) {
    let top3 = |list: &[Action]| list.iter().take(3).copied().collect::<BTreeSet<Action>>();
    let (first, set) = (a.first() == b.first(), top3(a) == top3(b));
    (first, set, first && set)
}

/// The depth check's reading of one position: both searches whole, then the same #1 and the same
/// top-3 set by action.
fn depth_check_of(
    base: &Searched,
    deep: &Searched,
    horizon: usize,
    u: &Universe,
) -> DepthCheckWire {
    let whole = |s: &Searched| {
        s.outcome
            .as_ref()
            .ok()
            .filter(|o| !o.partial)
            .map(|o| o.ranked.iter().map(|r| r.action).collect::<Vec<Action>>())
    };
    let (Some(a), Some(b)) = (whole(base), whole(deep)) else {
        return DepthCheckWire {
            horizon,
            stable: None,
            same_first: None,
            same_top_3: None,
            top_3: Vec::new(),
        };
    };
    let (same_first, same_top_3, stable) = same_top(&a, &b);
    DepthCheckWire {
        horizon,
        stable: Some(stable),
        same_first: Some(same_first),
        same_top_3: Some(same_top_3),
        top_3: b.iter().take(3).map(|x| ids(*x, u)).collect(),
    }
}

/// What the board did with a champion: `banned`, `picked`, `excluded` (taken but not on the board:
/// the fixture's cross-game exclusions), or `None` where it is open.
fn board_status(position: &Position<'_>, c: ChampionIdx) -> Option<&'static str> {
    for e in position.entries() {
        match e {
            Entry::Ban(b) if *b == c => return Some("banned"),
            Entry::Pick(p) if *p == c => return Some("picked"),
            _ => {}
        }
    }
    position.taken().contains(c).then_some("excluded")
}

fn read_position(
    loaded: &Loaded,
    searched: &[Searched],
    deep: Option<&Searched>,
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

    let reference_id = reference_kind().id();
    // One pass per arm over what the charge says: the in-pool ranking each arm's gains read from.
    let mut views: Vec<ArmView<'_>> = Vec::with_capacity(arms.len());
    let mut seeds: BTreeSet<Action> = BTreeSet::new();
    for (arm, s) in arms.iter().zip(searched) {
        let mut view = ArmView {
            arm,
            searched: s,
            ranks: Vec::new(),
            best_in_pool: None,
            menu_best: HashMap::new(),
        };
        // A cut search (`partial`) leaves the position out at that arm (design § 2): no seeds, no
        // best in-pool, no rows, no `reach`; its reading is kept, flagged, with an empty `ranked`.
        if let Some(o) = s.outcome.as_ref().ok().filter(|o| !o.partial) {
            let values: Vec<f64> = o.ranked.iter().map(|r| r.value).collect();
            view.ranks = ranks(&values);
            let top = rank_prefix(&view.ranks, cfg.k);
            seeds.extend(o.ranked.iter().take(top).map(|r| r.action));
            if arm.kind.is_roster_like() {
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
                // Every option `menu` references is in the catalog: seed each champion's best.
                if arm.id == reference_id {
                    for (i, r) in o.ranked.iter().enumerate() {
                        if charge.of(r.action).is_in_pool() {
                            for c in r.action.champions() {
                                view.menu_best.entry(c).or_insert(i);
                            }
                        }
                    }
                    seeds.extend(view.menu_best.values().map(|i| o.ranked[*i].action));
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
        let roster = arm.kind.is_roster_like();
        let margin = margin_len(outcome, cfg.margin);
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
                    (class_of(c, &side), c.d_off, c.d_grade)
                }
            };
            if view.best_in_pool == Some(i) {
                best_in_pool = Some(BestInPool {
                    option: id.clone(),
                    rank,
                    value: r.value,
                });
            }
            let (gain_logit, gain_pp) = match best_in.map(|b| gains(r.value, b.value, mover)) {
                Some((logit, pp)) => (Some(logit), Some(pp)),
                None => (None, None),
            };
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

    let open = open_roles(mover, &position, pools, u);
    let reference = views.iter().find(|v| v.arm.id == reference_id);
    let reference_ranking = reference
        .and_then(|v| {
            let o = v.searched.outcome.as_ref().ok().filter(|o| !o.partial)?;
            Some(
                o.ranked
                    .iter()
                    .zip(&v.ranks)
                    .map(|(r, rank)| RankedActionWire {
                        action: ids(r.action, u),
                        rank: *rank,
                        value: r.value,
                    })
                    .collect(),
            )
        })
        .unwrap_or_default();
    let menu = match reference {
        Some(v) if pick_root => menu_of(v, &position, &open, pools, u),
        _ => MenuWire::default(),
    };
    let depth_check = deep.and_then(|deep| {
        let at = arms.iter().position(|a| a.id == reference_id)?;
        Some(depth_check_of(&searched[at], deep, cfg.horizon + 1, u))
    });

    let scoring = scoring_of(
        fx,
        &position,
        mover,
        pick_root,
        &views,
        &catalog,
        depth_check.as_ref().and_then(|d| d.stable),
        &resolved,
        u,
    );

    PositionRead {
        id: fx.id.clone(),
        draft: draft_of(&fx.id),
        scoring,
        depth_check,
        open_roles: open
            .iter()
            .map(|set| set.iter().map(|r| role_key(*r)).collect())
            .collect(),
        reference_ranking,
        menu,
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

// ---- scoring a ranking (design § 4) ------------------------------------------------------------------

/// The cut-offs every metric is read at.
pub const SCORE_KS: [usize; 4] = [1, 3, 5, 10];

/// One entry of a full, mover-ordered ranking, as `score_ranking` reads it. This is the T12 seam: no
/// search or leaf type appears here. `option` is resolved wherever a label exists for the action and is
/// `None` otherwise (an unlabelled action needs no trace). `value` is Blue-perspective;
/// `opponent_charge` is the opponent's off-pool and grade charge only (never an infeasibility band,
/// which stays in `value`).
#[derive(Clone, Debug)]
pub struct ScoredAction {
    pub action: Action,
    pub value: f64,
    pub option: Option<OptionKey>,
    /// Must agree with `own_pick_in_pool` for the own pick's entry (debug-asserted there; nothing else
    /// reads it: the floor rows read the traced sides and `top_in_pool` reads `class`).
    pub in_pool: bool,
    pub class: TopClassName,
    pub opponent_charge: f64,
}

/// Where the reader's own pick stands. `NoPick` (no view, or not answered) takes the position out of the
/// pick metrics; `Absent` (the action is not in the ranking) is rank infinity, left out of regret and
/// counted.
#[derive(Clone, Debug, PartialEq)]
pub enum OwnPick {
    NoPick,
    Absent,
    /// `rank` is 1 + the number of strictly better values; `regret` the mover-signed logit gap from #1.
    Ranked {
        rank: usize,
        regret: f64,
    },
}

/// One k's reading of a position, so a caller does not index the `[bool; 4]`s by hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AtK {
    pub never: bool,
    pub near: bool,
    pub unjudged: bool,
    pub play: bool,
    pub no_play: bool,
    pub neither_play: bool,
    pub pick: bool,
    pub pick_off: bool,
}

impl PositionScore {
    /// The metrics at `k`, one of `SCORE_KS`; `None` for any other k.
    pub fn at(&self, k: usize) -> Option<AtK> {
        let j = SCORE_KS.iter().position(|&x| x == k)?;
        Some(AtK {
            never: self.never[j],
            near: self.near[j],
            unjudged: self.unjudged[j],
            play: self.play[j],
            no_play: self.no_play[j],
            neither_play: self.neither_play[j],
            pick: self.pick[j],
            pick_off: self.pick_off[j],
        })
    }
}

impl OwnPick {
    /// The rank as the median reads it: infinity when absent, `None` (outside the metric) with no pick.
    pub fn rank_for_median(&self) -> Option<f64> {
        match self {
            OwnPick::NoPick => None,
            OwnPick::Absent => Some(f64::INFINITY),
            OwnPick::Ranked { rank, .. } => Some(*rank as f64),
        }
    }
}

/// One position's reading of one ranking. Every `[bool; 4]` is indexed like `SCORE_KS`.
#[derive(Clone, Debug, PartialEq)]
pub struct PositionScore {
    pub never: [bool; 4],
    pub near: [bool; 4],
    pub unjudged: [bool; 4],
    pub play: [bool; 4],
    pub no_play: [bool; 4],
    /// In neither `play` nor `no_play`: an unlabelled option is in range and no `play` is.
    pub neither_play: [bool; 4],
    pub pick: [bool; 4],
    /// `pick`, only where the own pick is off-pool (`pick_off_eligible`).
    pub pick_off: [bool; 4],
    pub pick_off_eligible: bool,
    pub own: OwnPick,
    /// The #1 changes when the opponent's leaf charges are taken out of the values.
    pub opp_lead: bool,
    pub class_at_1: Option<TopClassName>,
}

/// Scores a full, mover-ordered (best first for the mover; debug-asserted) ranking against the resolved labels (design § 4). Values are
/// Blue-perspective, so every comparison reads `sign * value`; every `margin` bound is inclusive.
pub fn score_ranking(
    mover: Side,
    ranking: &[ScoredAction],
    labels: &HashMap<OptionKey, Label>,
    own_pick: Option<Action>,
    own_pick_in_pool: bool,
    margin: f64,
) -> PositionScore {
    let sign = mover_sign(mover);
    let signed: Vec<f64> = ranking.iter().map(|a| sign * a.value).collect();
    debug_assert!(
        signed.windows(2).all(|w| w[0] >= w[1]),
        "the ranking must be best-first for the mover"
    );
    let rank = ranks(&signed);
    let label = |a: &ScoredAction| a.option.as_ref().and_then(|o| labels.get(o)).copied();

    // A clear `never` at k, with unlabelled options read as `never` or not.
    let clear = |k: usize, unlabelled_never: bool| -> bool {
        let is_never = |a: &ScoredAction| match label(a) {
            Some(l) => l == Label::Never,
            None => unlabelled_never,
        };
        let Some(best) = ranking.iter().position(is_never) else {
            return false;
        };
        let floor = signed[best] - margin;
        let count = ranking
            .iter()
            .enumerate()
            .filter(|(i, a)| !is_never(a) && (*i < best || signed[*i] >= floor))
            .count();
        count < k
    };

    let mut score = PositionScore {
        never: [false; 4],
        near: [false; 4],
        unjudged: [false; 4],
        play: [false; 4],
        no_play: [false; 4],
        neither_play: [false; 4],
        pick: [false; 4],
        pick_off: [false; 4],
        pick_off_eligible: own_pick.is_some() && !own_pick_in_pool,
        own: OwnPick::NoPick,
        opp_lead: false,
        class_at_1: ranking.first().map(|a| a.class),
    };

    let own_index = own_pick.and_then(|p| ranking.iter().position(|a| a.action == p));
    debug_assert!(
        own_index.is_none_or(|i| ranking[i].in_pool == own_pick_in_pool),
        "own_pick_in_pool must agree with the ranked entry's in_pool"
    );
    if own_pick.is_some() {
        score.own = match own_index {
            Some(i) => OwnPick::Ranked {
                rank: rank[i],
                regret: signed[0] - signed[i] + 0.0,
            },
            None => OwnPick::Absent,
        };
    }

    for (j, &k) in SCORE_KS.iter().enumerate() {
        let as_never = clear(k, true);
        let as_not = clear(k, false);
        score.never[j] = as_never && as_not;
        score.unjudged[j] = as_never != as_not;

        let top = rank_prefix(&rank, k);
        let top_labels: Vec<Option<Label>> = ranking[..top].iter().map(label).collect();
        score.play[j] = top_labels.contains(&Some(Label::Play));
        score.no_play[j] = top > 0 && top_labels.iter().all(|l| l.is_some()) && !score.play[j];
        score.neither_play[j] = !score.play[j] && !score.no_play[j];
        score.near[j] =
            top_labels.contains(&Some(Label::Never)) && !score.never[j] && !score.unjudged[j];

        if let Some(i) = own_index {
            // Within ε of the k-th entry's value, or in the top k by rank.
            let kth = signed[k.min(signed.len()) - 1];
            score.pick[j] = rank[i] <= k || signed[i] >= kth - margin;
            score.pick_off[j] = score.pick[j] && score.pick_off_eligible;
        }
    }

    // The #1 with the opponent's leaf charges taken out, re-ordered for the mover; a tie keeps the
    // original #1.
    // `sign * (value - sign * charge)` is `sign * value - charge`.
    let adjusted = |i: usize| signed[i] - ranking[i].opponent_charge;
    let mut lead = 0;
    for i in 1..ranking.len() {
        if adjusted(i) > adjusted(lead) {
            lead = i;
        }
    }
    score.opp_lead = lead != 0;
    score
}

// ---- what the rule reads (design § 4), prepared before anything is pruned ----------------------------

/// What a leaf end charges the mover's opponent: that side's off-pool count × P plus its grade units ×
/// Q/100, at the arm's price. Never the infeasibility band: an infeasible end's `L'` lives in the value
/// and is not charge, so taking the opponent's charge out of the value must not take the band with it.
pub fn opponent_charge(ends: &LeafEnd, mover: Side, price: Price) -> f64 {
    let (off, grade) = match mover {
        Side::Blue => (ends.red_off_pool, ends.red_grade),
        Side::Red => (ends.blue_off_pool, ends.blue_grade),
    };
    off as f64 * price.p + grade as f64 * price.q_unit
}

/// One arm's full ranking as `score_ranking` reads it, with the trace each entry came from.
struct ArmData {
    input: ArmInput,
    keys: Vec<OptionKey>,
    sides: Vec<Vec<SidePlacement>>,
}

fn silent(id: &str) -> ArmInput {
    ArmInput {
        id: id.to_string(),
        speaks: false,
        ranking: Vec::new(),
        own_in_pool: Vec::new(),
        top_line: None,
        unknown_r_kept: 0,
    }
}

/// The #1's line, or `None` where the continuation is empty (slot 19: no line to judge, design § 1).
fn top_line_of(key: &OptionKey, ranked: &RankedAction, u: &Universe) -> Option<TopLine> {
    let turns: Vec<Vec<String>> = ranked.continuation.iter().map(|a| ids(*a, u)).collect();
    (!turns.is_empty()).then(|| TopLine {
        option: key.clone(),
        option_id: key.id(u),
        line: line_text(&turns),
    })
}

/// Traces `arrangement` for every action of the arm's whole ranking at the arm's price, so the class,
/// the option and (at the reference arm) the floor rows read every action, a moved locked pick
/// included. `option` is set only where the traced key carries a label in some fold: an arrangement
/// that differs from the labelled comp reads unlabelled (the fail-safe).
#[allow(clippy::too_many_arguments)]
fn arm_data(
    arm: &Arm,
    outcome: &SearchOutcome,
    position: &Position<'_>,
    mover: Side,
    pools: &Pools,
    labels: &HashMap<OptionKey, Label>,
    picks: &[Action],
    u: &Universe,
) -> ArmData {
    let price = arm.kind.price(u);
    let mut memo = FeasibilityMemo::new(price);
    let charge = action_charge(&mut memo, arm.kind.rule(), mover, position, pools, u);
    let mut trace_memo = FeasibilityMemo::new(price);
    let mut ranking = Vec::with_capacity(outcome.ranked.len());
    let mut keys = Vec::with_capacity(outcome.ranked.len());
    let mut sides = Vec::with_capacity(outcome.ranked.len());
    for r in &outcome.ranked {
        let side = arrangement(&mut trace_memo, mover, position, pools, u, r.action);
        let key = OptionKey {
            action: r.action,
            comp: comp_of(&side),
        };
        let c = charge.of(r.action);
        ranking.push(ScoredAction {
            action: r.action,
            value: r.value,
            option: labels.contains_key(&key).then(|| key.clone()),
            in_pool: c.is_in_pool(),
            class: class_of(c, &side),
            opponent_charge: opponent_charge(&r.ends, mover, price),
        });
        keys.push(key);
        sides.push(side);
    }
    let top_line = outcome
        .ranked
        .first()
        .and_then(|r| top_line_of(&keys[0], r, u));
    ArmData {
        input: ArmInput {
            id: arm.id.clone(),
            speaks: true,
            ranking,
            own_in_pool: picks
                .iter()
                .map(|a| (*a, charge.of(*a).is_in_pool()))
                .collect(),
            top_line,
            unknown_r_kept: 0,
        },
        keys,
        sides,
    }
}

/// Which options a floor keeps: the indices of those whose sides hold no off-pool placement of known
/// share ratio below `ratio` (a moved locked pick included), and how many kept ones hold an off-pool
/// placement of unknown ratio. `r_of` reads a placement's ratio.
pub fn floor_keep(
    sides: &[Vec<SidePlacement>],
    ratio: f64,
    r_of: impl Fn(&SidePlacement) -> Option<f64>,
) -> (Vec<usize>, usize) {
    let mut kept = Vec::new();
    let mut unknown = 0;
    for (i, side) in sides.iter().enumerate() {
        let off: Vec<Option<f64>> = side.iter().filter(|p| !p.in_pool).map(&r_of).collect();
        if off.iter().any(|r| r.is_some_and(|r| r < ratio)) {
            continue;
        }
        unknown += usize::from(off.iter().any(Option::is_none));
        kept.push(i);
    }
    (kept, unknown)
}

/// The reference ranking with every option holding an off-pool placement below share ratio `ratio`
/// removed (root-only, no re-search): a moved locked pick counts, a placement of unknown ratio is kept
/// and counted.
fn floor_input(ratio: f64, reference: &ArmData, outcome: &SearchOutcome, u: &Universe) -> ArmInput {
    let (kept, unknown) = floor_keep(&reference.sides, ratio, |p| {
        share_ratio(u, p.champion, p.role)
    });
    ArmInput {
        id: floor_id(ratio),
        // A floor that removes every option does not speak: it must not read as a clean position.
        speaks: !kept.is_empty(),
        ranking: kept
            .iter()
            .map(|i| reference.input.ranking[*i].clone())
            .collect(),
        own_in_pool: reference.input.own_in_pool.clone(),
        top_line: kept
            .first()
            .and_then(|i| top_line_of(&reference.keys[*i], &outcome.ranked[*i], u)),
        unknown_r_kept: unknown,
    }
}

/// An action's own-pick text in a change record: its ids sorted and `+`-joined; `None` is "no view".
fn pick_text(pick: Option<Action>, u: &Universe) -> Option<String> {
    pick.map(|action| OptionKey { action, comp: None }.id(u))
}

/// Everything the rule needs of one position, before the catalog prunes anything (design § 4: "it runs
/// in memory inside `tier_b_review`, before the catalog prunes anything").
#[allow(clippy::too_many_arguments)]
fn scoring_of(
    fx: &TierBFixture,
    position: &Position<'_>,
    mover: Side,
    pick_root: bool,
    views: &[ArmView<'_>],
    catalog: &Catalog,
    stable: Option<bool>,
    resolved: &ResolvedVerdicts,
    u: &Universe,
) -> PositionInput {
    let pools = &fx.root.pools;

    // The rule's fold is blind; an option labelled only after the reveal reads its current label (and is
    // counted), likewise an own pick first given after it.
    let mut rule_labels = resolved.current.clone();
    let mut label_fallbacks = 0;
    for (key, label) in rule_labels.iter_mut() {
        match resolved.blind.get(key) {
            Some(blind) => *label = *blind,
            None => label_fallbacks += 1,
        }
    }
    let current_pick = resolved.current_pick.flatten();
    let (rule_pick, pick_fallback) = match resolved.blind_pick {
        Some(pick) => (pick, false),
        // Counted also where the answer given after the reveal is "no view".
        None => (current_pick, resolved.current_pick.is_some()),
    };
    let mut picks: Vec<Action> = [rule_pick, current_pick].into_iter().flatten().collect();
    picks.dedup();

    let lines: HashMap<(OptionKey, String), bool> = resolved
        .lines
        .iter()
        .map(|l| ((l.option.clone(), canonical_line(&l.line)), l.ok))
        .collect();

    let reference_id = reference_kind().id();
    let mut arm_inputs = Vec::with_capacity(views.len() + FLOOR_RATIOS.len());
    let mut floors: Vec<ArmInput> = FLOOR_RATIOS.iter().map(|r| silent(&floor_id(*r))).collect();
    for view in views {
        let spoken = view
            .searched
            .outcome
            .as_ref()
            .ok()
            .filter(|o| !o.partial && pick_root);
        let Some(outcome) = spoken else {
            arm_inputs.push(silent(&view.arm.id));
            continue;
        };
        let data = arm_data(
            view.arm,
            outcome,
            position,
            mover,
            pools,
            &resolved.current,
            &picks,
            u,
        );
        if view.arm.id == reference_id {
            floors = FLOOR_RATIOS
                .iter()
                .map(|r| floor_input(*r, &data, outcome, u))
                .collect();
        }
        arm_inputs.push(data.input);
    }
    arm_inputs.extend(floors);

    let unlabelled_rows = catalog
        .entries
        .iter()
        .filter(|e| e.row && !rule_labels.contains_key(&e.key))
        .map(|e| e.key.id(u))
        .collect();

    // Options with exactly one off-pool placement, by that placement's share ratio.
    let r_labels = catalog
        .entries
        .iter()
        .filter_map(|e| {
            let label = rule_labels.get(&e.key)?;
            let mut off = e.side.iter().filter(|p| !p.in_pool);
            let only = off.next()?;
            off.next().is_none().then(|| {
                (
                    RBucket::of(share_ratio(u, only.champion, only.role)),
                    *label,
                )
            })
        })
        .collect();

    let mut label_changes: Vec<LabelChange> = resolved
        .blind
        .iter()
        .filter_map(|(key, blind)| {
            let current = resolved.current.get(key)?;
            (current != blind).then(|| LabelChange {
                option: key.id(u),
                blind: *blind,
                current: *current,
            })
        })
        .collect();
    label_changes.sort_by(|a, b| a.option.cmp(&b.option));
    let pick_change = resolved
        .blind_pick
        .filter(|blind| Some(*blind) != resolved.current_pick)
        .map(|blind| PickChange {
            blind: pick_text(blind, u),
            current: pick_text(current_pick, u),
        });

    PositionInput {
        id: fx.id.clone(),
        draft: draft_of(&fx.id),
        mover,
        stable,
        rule: Fold {
            labels: rule_labels,
            own_pick: rule_pick,
        },
        current: Fold {
            labels: resolved.current.clone(),
            own_pick: current_pick,
        },
        label_fallbacks,
        pick_fallback,
        lines,
        arms: arm_inputs,
        unlabelled_rows,
        r_labels,
        reveal: RevealRead {
            revealed: resolved.revealed,
            blind_labels: resolved.blind.len(),
            blind_pick: resolved.blind_pick.is_some(),
            label_changes,
            pick_change,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{parallel_map, rank_prefix, ranks, same_top};
    use crate::reference::state::Action;
    use crate::reference::universe::ChampionIdx;
    use std::time::Duration;

    fn picks(ids: &[u8]) -> Vec<Action> {
        ids.iter().map(|i| Action::Pick(ChampionIdx(*i))).collect()
    }

    /// `stable` is the same #1 AND the same top-3 set. Kills: `stable` reading only #1, only the set,
    /// either (`||`); a set of 4; an order-sensitive set.
    #[test]
    fn the_depth_check_compares_the_first_and_the_top_three_set() {
        let stable = |a: &[u8], b: &[u8]| same_top(&picks(a), &picks(b));
        // Both hold, also with #2 and #3 swapped (a set, not an order).
        assert_eq!(stable(&[1, 2, 3, 4], &[1, 3, 2, 4]), (true, true, true));
        // #1 moved, the set the same: not stable.
        assert_eq!(stable(&[1, 2, 3, 4], &[2, 1, 3, 4]), (false, true, false));
        // #1 held, the set moved (4 in for 3): not stable.
        assert_eq!(stable(&[1, 2, 3, 4], &[1, 2, 4, 3]), (true, false, false));
        // A change only at #4 or below: stable (kills a set of 4).
        assert_eq!(
            stable(&[1, 2, 3, 4, 5], &[1, 2, 3, 5, 4]),
            (true, true, true)
        );
        assert_eq!(stable(&[1, 2, 3, 4], &[1, 2, 3, 9]), (true, true, true));
        // A tie at #3 is resolved by list order (canonical): a tie between 3 and 4 listed 3 first on one
        // side and 4 first on the other reads as a moved set; the check does not report the tie.
        assert_eq!(stable(&[1, 2, 3, 4], &[1, 2, 4, 3]), (true, false, false));
        // Fewer than three: compared as they stand; empty lists agree.
        assert_eq!(stable(&[1, 2], &[1, 2]), (true, true, true));
        assert_eq!(stable(&[], &[]), (true, true, true));
    }

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
