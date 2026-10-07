//! The reference search (design docs/designs/engine-reference-search-design.md § 3; R3, R4, R6, R8):
//! iterative-deepening alpha-beta on the Blue-perspective D3 value. Every ROOT child is searched with a
//! full window, so every root value is exact and the ranked list can be compared to the oracle's; interior
//! nodes prune with static move ordering and memoise exact values in the transposition table. Depth
//! iteration, node budget, deadline, cancel and per-depth partials go through the incumbent's
//! `iterative_deepening::deepen_with_hook` and `cancellation::CancelHandle`, unchanged — the target note's
//! § 2 contract, met by reuse. B-proper (design `engine-b-proper-design.md` § 2) adds the static
//! shortlist: with `SearchParams::shortlist` set, a pick node's children are the best `width` by the
//! same static ordering (`static_order`, `truncate_children`), the root keeps every in-pool action plus
//! the best off-pool ones (`root_shortlist`), and `SearchOutcome::root_fan` says what was left out.
//! Truncation is not exact; `None` is the exact search of slice 4.

use super::feasibility::{
    action_charge, critical_pool, locked_matchable, side_feasible, tags_for, ActionCharge,
    FeasibilityMemo, FeasibilityRule, Price,
};
use super::format::Slot;
use super::node::{classify, legal_actions_under, ClassifyError, LeafEnd, LeafKind, NodeKind};
use super::objective::{Leaf, Objective};
use super::oracle::{
    check_role_tags, resolve_off_pool_cost, resolve_off_role_cost, Mode, OracleError, OracleInput,
};
use super::state::{Action, Pools, Position};
use super::transposition::{Entry, Key, TranspositionTable};
use super::universe::{ChampionSet, Universe};
use crate::cancellation::{ensure_not_cancelled, CancelHandle};
use crate::draft_state::{ActionType, Side};
use crate::engine::EngineError;
use crate::iterative_deepening::{deepen_with_hook, SearchResult};
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// B-proper § 2: the static shortlist's widths. `None` on `SearchParams::shortlist` = no truncation
/// anywhere (Tier A, the oracle-equality tests, the exact search of slice 4). Every width ≥ 1
/// (`search` refuses 0). Truncation is NOT exact: `SearchOutcome::root_fan` says how many root
/// actions were legal beside how many were ranked. The oracle never shortlists (D8 1). Bans are never
/// truncated (no static term; a ban fan is ≤ 173).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shortlist {
    /// Children kept at an interior single-pick node.
    pub singles: usize,
    /// Children kept at an interior pair node.
    pub pairs: usize,
    /// Off-pool actions kept at a pick root beside EVERY in-pool action (design B6).
    pub root_off_pool: usize,
}

#[derive(Clone, Debug)]
pub struct SearchParams {
    /// Cumulative across iterations (the same quantity as `Progress.nodes`): the iteration that pushes the
    /// total past it is cut and the previous depth is returned `partial`.
    pub node_budget: Option<u64>,
    /// `false`: no cutoffs. Must reproduce the oracle's node and leaf counts (with the table off).
    pub prune: bool,
    /// `false`: no transposition table.
    pub transposition: bool,
    /// Handed to `deepen_with_hook` as its wall-clock budget. Its two time-based stop paths (budget spent,
    /// the 2× cost heuristic) are reachable only if an iteration takes a third of this; the tests pass a day.
    pub wall_budget: Duration,
    /// `deepen_with_hook`'s floor on the bail heuristic.
    pub min_completed_depth: usize,
    /// B-proper § 2: `Some` truncates every pick fan (see `Shortlist`); `None` is exact.
    pub shortlist: Option<Shortlist>,
    /// The snipe-aware ordering key (design `engine-snipe-key-design.md`): `false` = today's ordering,
    /// byte for byte; `true` = wherever the off-pool term rides the key, each champion an action takes
    /// from the opponent's critical pool (`feasibility::critical_pool`) adds P in the mover's favour —
    /// the opponent's forced-term delta. An ordering heuristic: truncation is still not exact, and the
    /// leaves are priced as before.
    pub snipe_key: bool,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            node_budget: None,
            prune: true,
            transposition: true,
            wall_budget: Duration::from_secs(86_400),
            min_completed_depth: 1,
            shortlist: None,
            snipe_key: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RankedAction {
    pub action: Action,
    /// Exact, Blue-perspective (as `Evaluation::value`).
    pub value: f64,
    /// The principal variation below `action`: the mover-best action at every node down to the leaf.
    pub continuation: Vec<Action>,
    /// How the replayed continuation ends — the S11 guard: a continuation ending with a side (or both)
    /// infeasible says so here.
    pub ends: LeafEnd,
}

impl RankedAction {
    /// The S11 guard: the mover's own side cannot complete five roles at the end of this line. A line
    /// that breaks only the opponent is a denial, not a defect.
    pub fn breaks_mover(&self, mover: Side) -> bool {
        !match mover {
            Side::Blue => self.ends.blue_feasible,
            Side::Red => self.ends.red_feasible,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchOutcome {
    pub mover: Side,
    /// The completed depth the ranking comes from.
    pub depth: usize,
    /// A deeper iteration was cut by the node budget, the deadline, or a cancel that arrived INSIDE an
    /// iteration. A cancel that arrives between iterations is `Err(Cancelled)` (the driver's contract).
    pub partial: bool,
    pub value: f64,
    /// Best-first for the mover; ties in canonical order (as the oracle).
    pub ranked: Vec<RankedAction>,
    /// Within `epsilon` of the best, canonical order (as the oracle).
    pub top_set: Vec<Action>,
    /// Legal root actions (B-proper § 2): `ranked.len()` of them were searched; the rest were cut by
    /// `SearchParams::shortlist` (never any without it, and never at a ban root).
    pub root_fan: usize,
    /// This depth's iteration alone, with the oracle's definitions: `nodes` = positions visited below the
    /// root, `leaves` = objective calls at leaves. `orderings` = objective calls spent ordering children;
    /// `table_hits` = lookups answered from the table during this iteration.
    pub nodes: u64,
    pub leaves: u64,
    pub orderings: u64,
    pub cutoffs: u64,
    pub table_hits: u64,
    /// Children this iteration whose ordering key took the snipe term (`SearchParams::snipe_key`);
    /// 0 with the flag off or where the key does not ride.
    pub snipe_charged: u64,
    /// Every iteration so far — what `node_budget` is measured against.
    pub nodes_total: u64,
    /// Table lookups answered over the whole search (the table lives across iterations).
    pub table_hits_total: u64,
    /// Entries in the table after this iteration.
    pub table_entries: u64,
    pub elapsed: Duration,
}

/// The iteration ceiling: `Horizon(h)` → `min(h, turns_remaining)`; `FullRemainder` → `turns_remaining`.
pub fn max_depth_for(input: &OracleInput<'_>) -> usize {
    let remaining = input
        .position
        .format()
        .turns_remaining(input.position.slot_index());
    match input.mode {
        Mode::FullRemainder => remaining,
        Mode::Horizon(h) => h.min(remaining),
    }
}

fn invalid(err: impl std::fmt::Display) -> EngineError {
    EngineError::InvalidInput {
        path: vec![err.to_string()],
    }
}

/// R4's static ordering as a free function (B-proper § 2): `actions` by the static utility of the
/// child position, best first for `side`, equal values in canonical order. `off_pool` is the mover's
/// action charge, built at the memo's price, where the caller charges the off-pool term — under
/// `Roster` always, under `PoolOrRoster` when a shortlist is set (`Iteration::order` decides) — and
/// each off-pool pick an action adds then costs P in the KEY (Blue subtracts, Red adds), and each grade
/// unit Q/100 (engine-role-grade design § 5: `Charge::key_charge`), so an off-pool child is ordered net
/// of its cost: on a list pool one P per champion the action names outside the pool, on a role-tagged
/// one the rise in the mover's weighted cheapest arrangement (`feasibility::ActionCharge`; role-aware
/// pools design § 2); `None` gives the board alone, as slice 4 built it. `snipe` is the opponent's critical
/// pool (`feasibility::critical_pool`) where the snipe-aware key applies: each champion of the action
/// in it adds the same P in the mover's favour (Blue adds, Red subtracts) — the opponent's forced-term
/// delta, exact for any two critical champions (design fact 3); it rides only with `off_pool`, whose P
/// it reads, and `None` is the function as B-proper built it. With `snipe` set, equal keys order the
/// child with fewer off-pool picks first, then canonically (the dry run, 2026-09-30): an off-pool
/// snipe is P-neutral in the key (made P against the victim's forced P), so it ties an in-pool move of
/// equal board, and the key cannot see the victim's roster replacement that makes the snipe weakly
/// worse. The mover's own forced term and the feasibility flags stay out of the key (cost; both stay
/// leaf-priced). A pure function of its arguments: the purity the transposition table needs (slice-5
/// § 8).
pub fn static_order(
    objective: &dyn Objective,
    position: &Position<'_>,
    side: Side,
    actions: Vec<Action>,
    off_pool: Option<ActionCharge<'_>>,
    snipe: Option<ChampionSet>,
) -> Vec<Action> {
    // (key, the snipe tie-break's off-pool count — 0 without `snipe`, so equal keys stay canonical —,
    // the action).
    let mut keyed: Vec<(f64, usize, Action)> = actions
        .into_iter()
        .map(|a| {
            let child = position.apply(a);
            let mut tie = 0;
            let mut v = objective.value(&Leaf {
                blue: child.picks(Side::Blue),
                red: child.picks(Side::Red),
                blue_feasible: true,
                red_feasible: true,
            });
            if let Some(charge) = off_pool {
                let c = charge.of(a);
                if snipe.is_some() {
                    tie = c.d_off;
                }
                // The charge's own arithmetic (engine-role-grade G7): the off and grade deltas priced
                // from integers at the memo's price, each term skipped on a zero delta or unit, clamped
                // at 0; a zero charge adds nothing (today's `made > 0` guard, so a `−0.0` board stays).
                let key = c.key_charge();
                if key != 0.0 {
                    v = match side {
                        Side::Blue => v - key,
                        Side::Red => v + key,
                    };
                }
                if let Some(critical) = snipe {
                    let sniped = a.champions().filter(|c| critical.contains(*c)).count();
                    if sniped > 0 {
                        // `sniped · P` with P from the same price (not exact under weights, G9).
                        let gain = f64::from(u8::try_from(sniped).unwrap_or(u8::MAX)) * c.price().p;
                        v = match side {
                            Side::Blue => v + gain,
                            Side::Red => v - gain,
                        };
                    }
                }
            }
            (v, tie, a)
        })
        .collect();
    keyed.sort_by(|x, y| {
        let by_value = match side {
            Side::Blue => y.0.partial_cmp(&x.0),
            Side::Red => x.0.partial_cmp(&y.0),
        };
        by_value
            .expect("objective values are finite (Objective contract)")
            .then(x.1.cmp(&y.1))
            .then(x.2.cmp(&y.2))
    });
    keyed.into_iter().map(|(_, _, a)| a).collect()
}

/// What the shortlist's feasibility filter reads (B-proper § 2): the rule (the filter runs under the
/// live rules only), the search's feasibility memo (`FeasibilityMemo.locked`), the universe, and the
/// pools — a role-tagged side's locked picks are matched on its playable roles (`tags_for`).
pub struct Filter<'a> {
    pub rule: FeasibilityRule,
    pub memo: &'a mut FeasibilityMemo,
    pub universe: &'a Universe,
    pub pools: &'a Pools,
}

/// B-proper § 2: the shortlist's truncation, a pure function of its arguments. `ordered` is a pick
/// node's children best first (`static_order`). Under a live rule the first `width` children whose
/// locked picks (the parent's plus the action's) still form a role matching are kept, in order
/// (`feasibility::locked_matchable`, ≤ 5 names); if fewer than `width` pass, the best failures fill
/// the width, so a side whose comp is already broken still has moves (L' ranks them). Under `On` /
/// `Off` the first `width`. A list no longer than `width` is returned as is.
pub fn truncate_children(
    position: &Position<'_>,
    side: Side,
    ordered: Vec<Action>,
    width: usize,
    filter: &mut Filter<'_>,
) -> Vec<Action> {
    if ordered.len() <= width {
        return ordered;
    }
    if !filter.rule.is_live() {
        let mut ordered = ordered;
        ordered.truncate(width);
        return ordered;
    }
    let tags = tags_for(filter.rule, side, position, filter.pools);
    let mut keep = vec![false; ordered.len()];
    let mut kept = 0;
    for (i, a) in ordered.iter().enumerate() {
        if kept == width {
            break;
        }
        let child = position.apply(*a);
        if locked_matchable(filter.memo, side, child.picks(side), tags, filter.universe) {
            keep[i] = true;
            kept += 1;
        }
    }
    if kept < width {
        for k in keep.iter_mut() {
            if kept == width {
                break;
            }
            if !*k {
                *k = true;
                kept += 1;
            }
        }
    }
    ordered
        .into_iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(a, _)| a)
        .collect()
}

/// B-proper § 2 (B6): a pick root's fan under a shortlist — EVERY in-pool action (one that adds no
/// off-pool pick, `ActionCharge::of` = 0: on a list pool each champion it names is in the mover's
/// pool and a mixed pair is off-pool; on a role-tagged one it can be placed in-role beside the locked
/// picks) plus the best `off_pool_width` off-pool ones, chosen as `truncate_children` chooses
/// (feasible first under a live rule, failures fill). Order is `ordered`'s. Under the gate no off-pool
/// action is legal, so the root is the full gate fan.
pub fn root_shortlist(
    position: &Position<'_>,
    side: Side,
    ordered: Vec<Action>,
    charge: &ActionCharge<'_>,
    off_pool_width: usize,
    filter: &mut Filter<'_>,
) -> Vec<Action> {
    let in_pool = |a: &Action| charge.of(*a).is_in_pool();
    let off: Vec<Action> = ordered.iter().copied().filter(|a| !in_pool(a)).collect();
    let kept: HashSet<Action> = truncate_children(position, side, off, off_pool_width, filter)
        .into_iter()
        .collect();
    ordered
        .into_iter()
        .filter(|a| in_pool(a) || kept.contains(a))
        .collect()
}

/// Shared across iterations of one `search` call.
struct Shared {
    memo: FeasibilityMemo,
    table: TranspositionTable,
    nodes_total: u64,
    /// P and Q for this search (`oracle::resolve_off_pool_cost`, `resolve_off_role_cost`), fixed
    /// before the first iteration; the memo above was built at the same price.
    off_pool_cost: f64,
    off_role_cost: f64,
}

/// One iteration at `depth`. Two lifetimes on purpose: `'i` is this iteration's borrows (the driver's
/// per-iteration cancel handle, the shared state), `'a` is the caller's input.
struct Iteration<'i, 'a> {
    input: &'i OracleInput<'a>,
    params: &'i SearchParams,
    cancel: &'i CancelHandle,
    depth: usize,
    shared: &'i mut Shared,
    nodes: u64,
    leaves: u64,
    orderings: u64,
    cutoffs: u64,
    table_hits: u64,
    snipe_charged: u64,
}

impl Iteration<'_, '_> {
    fn classify(
        &mut self,
        position: &Position<'_>,
        turns_used: usize,
    ) -> Result<NodeKind, EngineError> {
        classify(
            position,
            turns_used,
            Some(self.depth),
            self.input.universe,
            self.input.pools,
            self.input.feasibility,
            &mut self.shared.memo,
        )
        .map_err(|e: ClassifyError| invalid(e))
    }

    fn leaf_value(&self, position: &Position<'_>, end: LeafEnd) -> f64 {
        self.input.objective.value_under(
            &Leaf {
                blue: position.picks(Side::Blue),
                red: position.picks(Side::Red),
                blue_feasible: end.blue_feasible,
                red_feasible: end.red_feasible,
            },
            self.input.feasibility,
            self.shared.off_pool_cost,
            self.shared.off_role_cost,
            end.blue_off_pool,
            end.red_off_pool,
            end.blue_grade,
            end.red_grade,
        )
    }

    /// R4: children by the static utility of the child position, best first for the mover; equal values
    /// keep canonical order (`static_order`; under `Roster` the key carries the off-pool term, and with
    /// `SearchParams::snipe_key` the opponent's critical pool wherever that term rides). Bans have no
    /// term (D3 iii), so a ban slot's children are all equal: they are returned in canonical order
    /// without evaluating anything.
    fn order(&mut self, position: &Position<'_>, slot: Slot, actions: Vec<Action>) -> Vec<Action> {
        if slot.action == ActionType::Ban {
            return actions;
        }
        self.orderings += u64::try_from(actions.len()).unwrap_or(u64::MAX);
        // The off-pool term rides the key under `Roster` always, and under `PoolOrRoster` whenever a
        // shortlist is set (review round 1): at a widened node the board-best children can all be
        // count-suboptimal, and a truncation that dropped the count-minimal child would move values by
        // whole multiples of L and could flip the root. Without a shortlist nothing is dropped, and
        // the board-only key keeps `pool_or_roster`'s counts byte-identical to slice 5.
        let charged = match self.input.feasibility {
            FeasibilityRule::Roster => true,
            FeasibilityRule::PoolOrRoster => self.params.shortlist.is_some(),
            FeasibilityRule::On | FeasibilityRule::Off => false,
        };
        // The charge carries the memo's price — the one source the key reads P and Q from.
        let off_pool = charged.then(|| {
            action_charge(
                &mut self.shared.memo,
                self.input.feasibility,
                slot.side,
                position,
                self.input.pools,
                self.input.universe,
            )
        });
        // The snipe-aware key (design `engine-snipe-key-design.md` § 1): once per node, the opponent's
        // critical pool; memoised on the opponent's state, so the table is never read.
        let snipe = (charged && self.params.snipe_key).then(|| {
            critical_pool(
                &mut self.shared.memo,
                slot.side.opposite(),
                position,
                self.input.pools,
                self.input.universe,
            )
        });
        if let Some(critical) = snipe.filter(|c| !c.is_empty()) {
            let sniping = actions
                .iter()
                .filter(|a| a.champions().any(|c| critical.contains(c)))
                .count();
            self.snipe_charged += u64::try_from(sniping).unwrap_or(u64::MAX);
        }
        static_order(
            self.input.objective,
            position,
            slot.side,
            actions,
            off_pool,
            snipe,
        )
    }

    /// An interior pick node's children under the shortlist (B-proper § 2); every child without one.
    fn shortlisted(
        &mut self,
        position: &Position<'_>,
        slot: Slot,
        ordered: Vec<Action>,
    ) -> Vec<Action> {
        match self.params.shortlist {
            Some(sl) if slot.action == ActionType::Pick => {
                let width = if slot.pair_start {
                    sl.pairs
                } else {
                    sl.singles
                };
                truncate_children(
                    position,
                    slot.side,
                    ordered,
                    width,
                    &mut Filter {
                        rule: self.input.feasibility,
                        memo: &mut self.shared.memo,
                        universe: self.input.universe,
                        pools: self.input.pools,
                    },
                )
            }
            _ => ordered,
        }
    }

    /// Alpha-beta value of `position` and its principal continuation. `turns_used` turns below the root.
    /// Fail-soft: the returned value is exact iff it lies strictly inside `(alpha0, beta0)`; only then is it
    /// stored. The continuation is the line through the child `best` currently holds — the LAST child that
    /// strictly improved it — which is exact whenever the node's value is (it was strictly inside the
    /// window it was searched with, or it could not have improved `best` strictly inside this one).
    fn value(
        &mut self,
        position: &Position<'_>,
        turns_used: usize,
        alpha0: f64,
        beta0: f64,
    ) -> Result<(f64, Vec<Action>), EngineError> {
        self.nodes += 1;
        self.shared.nodes_total += 1;
        self.cancel.count_node();
        ensure_not_cancelled(self.cancel)?;
        if let Some(budget) = self.params.node_budget {
            if self.shared.nodes_total > budget {
                return Err(EngineError::Timeout(self.depth));
            }
        }
        let (slot, actions) = match self.classify(position, turns_used)? {
            NodeKind::Leaf(end) => {
                self.leaves += 1;
                return Ok((self.leaf_value(position, end), Vec::new()));
            }
            NodeKind::Interior { slot, actions } => (slot, actions),
        };
        let key = self
            .params
            .transposition
            .then(|| Key::of(position, self.depth - turns_used));
        if let Some(key) = &key {
            if let Some(entry) = self.shared.table.get(key) {
                self.table_hits += 1;
                return Ok((entry.value, entry.continuation.clone()));
            }
        }
        let ordered = self.order(position, slot, actions);
        let ordered = self.shortlisted(position, slot, ordered);
        let (mut alpha, mut beta) = (alpha0, beta0);
        let mut best: Option<(f64, Vec<Action>)> = None;
        for action in ordered {
            let child = position.apply(action);
            let (v, pv) = self.value(&child, turns_used + 1, alpha, beta)?;
            let improves = match &best {
                None => true,
                Some((b, _)) => match slot.side {
                    Side::Blue => v > *b,
                    Side::Red => v < *b,
                },
            };
            if improves {
                let mut line = Vec::with_capacity(pv.len() + 1);
                line.push(action);
                line.extend(pv);
                best = Some((v, line));
            }
            match slot.side {
                Side::Blue => alpha = alpha.max(v),
                Side::Red => beta = beta.min(v),
            }
            if self.params.prune && alpha >= beta {
                self.cutoffs += 1;
                break;
            }
        }
        let (v, pv) = best.expect("Interior carries at least one action");
        if let Some(key) = key {
            self.shared.table.store_if_exact(
                key,
                Entry {
                    value: v,
                    continuation: pv.clone(),
                },
                alpha0,
                beta0,
            );
        }
        Ok((v, pv))
    }

    /// R8: replay `action ++ continuation` from the root through `classify`, so the reported ending and the
    /// leaf's value are computed from the game, not read out of the search. A continuation that does not
    /// follow legal interior nodes to a leaf is a programming error.
    fn replay(
        &mut self,
        root: &Position<'_>,
        action: Action,
        continuation: &[Action],
    ) -> Result<(LeafEnd, f64), EngineError> {
        let mut position = root.apply(action);
        let mut turns_used = 1;
        for a in continuation {
            match self.classify(&position, turns_used)? {
                NodeKind::Interior { actions, .. } if actions.contains(a) => {}
                other => {
                    return Err(EngineError::Internal(format!(
                        "principal continuation step {a:?} is not a legal interior move (node was {other:?})"
                    )))
                }
            }
            position = position.apply(*a);
            turns_used += 1;
        }
        match self.classify(&position, turns_used)? {
            NodeKind::Leaf(end) => Ok((end, self.leaf_value(&position, end))),
            NodeKind::Interior { .. } => Err(EngineError::Internal(
                "principal continuation ends before a leaf".into(),
            )),
        }
    }

    fn run(mut self) -> Result<SearchOutcome, EngineError> {
        let root = self.input.position;
        let (slot, actions) = match self.classify(root, 0)? {
            NodeKind::Interior { slot, actions } => (slot, actions),
            // Unreachable: `search` checks the root before deepening. Named anyway so a lie is impossible.
            NodeKind::Leaf(end) => {
                return Err(invalid(match end.kind {
                    LeafKind::Complete => OracleError::DraftComplete,
                    LeafKind::DryPool => OracleError::NoLegalAction {
                        slot: root.slot_index(),
                    },
                    LeafKind::Horizon => OracleError::HorizonZero,
                }))
            }
        };
        // Root children are searched with a full window each, so their order changes no value and no ranking.
        // With the table off it changes no count either; with the table on it decides which subtree populates
        // the table first, so node, cutoff and hit counts are root-order dependent while values are not.
        let ordered = self.order(root, slot, actions);
        let root_fan = ordered.len();
        // B-proper § 2 (B6): under a shortlist a pick root keeps every in-pool action plus the best
        // off-pool ones; a ban root and an unshortlisted search keep the whole fan.
        let ordered = match self.params.shortlist {
            Some(sl) if slot.action == ActionType::Pick => root_shortlist(
                root,
                slot.side,
                ordered,
                &action_charge(
                    &mut self.shared.memo,
                    self.input.feasibility,
                    slot.side,
                    root,
                    self.input.pools,
                    self.input.universe,
                ),
                sl.root_off_pool,
                &mut Filter {
                    rule: self.input.feasibility,
                    memo: &mut self.shared.memo,
                    universe: self.input.universe,
                    pools: self.input.pools,
                },
            ),
            _ => ordered,
        };
        let mut ranked = Vec::with_capacity(ordered.len());
        for action in ordered {
            let child = root.apply(action);
            let (value, continuation) = self.value(&child, 1, f64::NEG_INFINITY, f64::INFINITY)?;
            let (ends, replayed) = self.replay(root, action, &continuation)?;
            debug_assert_eq!(
                replayed, value,
                "the principal continuation must reproduce its value"
            );
            ranked.push(RankedAction {
                action,
                value,
                continuation,
                ends,
            });
        }
        ranked.sort_by(|x, y| {
            let by_value = match slot.side {
                Side::Blue => y.value.partial_cmp(&x.value),
                Side::Red => x.value.partial_cmp(&y.value),
            };
            by_value
                .expect("root values are finite")
                .then(x.action.cmp(&y.action))
        });
        let value = ranked[0].value;
        let mut top_set: Vec<Action> = ranked
            .iter()
            .filter(|r| (r.value - value).abs() <= self.input.epsilon)
            .map(|r| r.action)
            .collect();
        top_set.sort();
        Ok(SearchOutcome {
            mover: slot.side,
            depth: self.depth,
            partial: false,
            value,
            ranked,
            top_set,
            root_fan,
            nodes: self.nodes,
            leaves: self.leaves,
            orderings: self.orderings,
            cutoffs: self.cutoffs,
            table_hits: self.table_hits,
            snipe_charged: self.snipe_charged,
            nodes_total: self.shared.nodes_total,
            table_hits_total: self.shared.table.hits(),
            table_entries: u64::try_from(self.shared.table.len()).unwrap_or(u64::MAX),
            elapsed: Duration::ZERO,
        })
    }
}

/// Root checks (the oracle's, as `InvalidInput`), then iterative deepening to `max_depth_for(input)`.
/// `on_depth` fires with each completed depth that is followed by a deeper one (`deepen_with_hook`'s
/// contract); the returned outcome carries `partial`/`depth` from the driver.
pub fn search(
    input: &OracleInput<'_>,
    params: &SearchParams,
    cancel: &CancelHandle,
    mut on_depth: impl FnMut(&SearchOutcome),
) -> Result<SearchOutcome, EngineError> {
    let started = Instant::now();
    let position = input.position;
    if position.next_slot().is_none() {
        return Err(invalid(OracleError::DraftComplete));
    }
    if input.mode == Mode::Horizon(0) {
        return Err(invalid(OracleError::HorizonZero));
    }
    if let Some(sl) = params.shortlist {
        if sl.singles == 0 || sl.pairs == 0 || sl.root_off_pool == 0 {
            return Err(invalid(format!(
                "shortlist: every width must be at least 1 (singles {}, pairs {}, root_off_pool {})",
                sl.singles, sl.pairs, sl.root_off_pool
            )));
        }
    }
    let off_pool_cost = resolve_off_pool_cost(input).map_err(invalid)?;
    let off_role_cost = resolve_off_role_cost(input, off_pool_cost).map_err(invalid)?;
    check_role_tags(input).map_err(invalid)?;
    // The search's ONLY memo: priced, so every leaf and key below reads this search's (P, Q).
    let mut shared = Shared {
        memo: FeasibilityMemo::new(Price::of(off_pool_cost, off_role_cost)),
        table: TranspositionTable::default(),
        nodes_total: 0,
        off_pool_cost,
        off_role_cost,
    };
    let feasible = |memo: &mut FeasibilityMemo, side| {
        side_feasible(
            memo,
            input.feasibility,
            side,
            position,
            input.pools,
            input.universe,
        )
    };
    let (blue_feasible, red_feasible) = (
        feasible(&mut shared.memo, Side::Blue),
        feasible(&mut shared.memo, Side::Red),
    );
    // The gate refuses a root a side cannot finish from (slice 4, R3). Under a live rule (U10,
    // B-proper) only locked picks that cannot fill five roles are infeasible — a fact on the board,
    // often the OPPONENT's (a pair of two ADC-only champions), and the draft goes on: that side is
    // priced at L' on every leaf, a constant, so the ranking is the board's and the off-pool term's
    // (round 5).
    let gated = !input.feasibility.is_live();
    if gated && !(blue_feasible && red_feasible) {
        return Err(invalid(OracleError::RootInfeasible {
            blue_feasible,
            red_feasible,
        }));
    }
    if legal_actions_under(
        position,
        input.universe,
        input.pools,
        input.feasibility,
        &mut shared.memo,
    )
    .is_empty()
    {
        return Err(invalid(OracleError::NoLegalAction {
            slot: position.slot_index(),
        }));
    }
    let max_depth = max_depth_for(input);
    let result = deepen_with_hook(
        |depth, handle| {
            let outcome = Iteration {
                input,
                params,
                cancel: handle,
                depth,
                shared: &mut shared,
                nodes: 0,
                leaves: 0,
                orderings: 0,
                cutoffs: 0,
                table_hits: 0,
                snipe_charged: 0,
            }
            .run()?;
            Ok(SearchResult {
                score: outcome.value,
                depth,
                partial: false,
                payload: outcome,
            })
        },
        max_depth,
        params.wall_budget,
        params.min_completed_depth,
        cancel,
        |r| on_depth(&r.payload),
    )?;
    let mut outcome = result.payload;
    outcome.depth = result.depth;
    outcome.partial = result.partial;
    outcome.elapsed = started.elapsed();
    Ok(outcome)
}
