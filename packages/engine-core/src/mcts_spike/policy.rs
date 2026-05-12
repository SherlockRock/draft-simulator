//! UCT selection + the public Mcts entry point.

use crate::draft_state::{is_taken, picks_remaining, ActionType, DraftState, Side};
use crate::evaluator::EvalContext;

use super::eval_ctx::build_spike_eval_ctx;
use super::feasibility_cache::FeasibilityCache;
use super::prior::{enumerate_pair_candidates, shortlist_top_k, ShortlistInput};
use super::rng::SplitMix64;
use super::rollout::{play_to_terminal, FeasibilityMode, RolloutPolicy};
use super::tree::{MoveId, Node, NodeId, Tree};
use super::{side_to_move, terminal_eval, PoolContext, SpikeFixture, ValueVector};

const UCT_C: f64 = std::f64::consts::SQRT_2;

#[derive(Clone, Debug)]
pub struct McTsConfig {
    pub policy: RolloutPolicy,
    pub feasibility_mode: FeasibilityMode,
    pub seed: u64,
    /// Optional root-level shortlist size. `None` keeps the full
    /// feasibility-filtered move list (v1 behavior). `Some(k)` truncates
    /// the root's `untried` to the top-k by static-eval prior, then
    /// intersected with the feasibility-legal set.
    pub root_shortlist_k: Option<usize>,
    /// Weight on the spike's `flex` axis when computing the UCT-selection
    /// composite. Default 1.0 preserves v4 behavior (equal-weight
    /// winrate + coverage + flex). 0.0 disables the flex axis at selection.
    /// Phase 6 measurement knob — see docs/plans/2026-05-11-mcts-phase-6.
    /// Note: `ValueVector::composite()` is unchanged (still equal-weight)
    /// so Pareto-front and trajectory CSV consume the canonical composite.
    pub flex_weight: f64,
}

pub struct Mcts<'a> {
    fixture: &'a SpikeFixture,
    cache: FeasibilityCache,
    cfg: McTsConfig,
    rng: SplitMix64,
    /// EvalContext built once from the fixture. Per-node scoring swaps
    /// perspective via `ctx.for_perspective(turn.side, state, turn.phase)`.
    ctx: EvalContext,
    /// Logical root for the current iteration. Reroot moves this down to a
    /// child; uproot moves it back up. Tree storage is unchanged.
    active_root: NodeId,
    /// Projected state at `active_root`. Cloned per iteration in `select`.
    active_root_state: DraftState,
    /// Visit count of the current `active_root` snapshotted at the moment
    /// of the most recent reroot — i.e. iterations carried over from the
    /// parent's prior search. Surfaced into the trajectory CSV as
    /// `inherited_visits`.
    inherited_visits_at_reroot: u32,
    /// Stack of (prev_active_root, prev_state, prev_inherited_visits)
    /// frames pushed at each reroot. `uproot()` pops to walk back up.
    history: Vec<(NodeId, DraftState, u32)>,
    tree: Tree,
}

impl<'a> Mcts<'a> {
    /// Convenience constructor: full pool for both sides (v1-v4 behavior).
    pub fn new(fixture: &'a SpikeFixture, root_state: DraftState, cfg: McTsConfig) -> Self {
        let pools = PoolContext::full(fixture);
        Self::with_pools(fixture, root_state, &pools, cfg)
    }

    /// Pool-aware constructor: candidate enumeration scopes to the picking
    /// side's `pool.search` at every turn. Use this for v5 phase 1+ runs.
    pub fn with_pools(
        fixture: &'a SpikeFixture,
        root_state: DraftState,
        pools: &PoolContext,
        cfg: McTsConfig,
    ) -> Self {
        let cache = FeasibilityCache::build(&fixture.meta);
        let rng = SplitMix64::new(cfg.seed);
        let our_side = root_state
            .current_turn()
            .map(|t| t.side)
            .unwrap_or(Side::Blue);
        let ctx = build_spike_eval_ctx(fixture, &root_state, our_side, pools);
        let mut root_node = Node {
            parent: None,
            move_from_parent: None,
            children: Vec::new(),
            untried: Vec::new(),
            visits: 0,
            value_sum: ValueVector::zero(),
            side_to_move: side_to_move(&root_state),
        };
        let mut full_legal =
            legal_moves(&root_state, fixture, &cache, cfg.feasibility_mode, &ctx);
        if let Some(k) = cfg.root_shortlist_k {
            if let Some(turn) = root_state.current_turn() {
                let sub_ctx = ctx.for_perspective(turn.side, &root_state, turn.phase);
                let priored = shortlist_top_k(
                    &root_state,
                    fixture,
                    &sub_ctx,
                    ShortlistInput { side: turn.side, action_type: turn.action_type },
                    k,
                );
                // Intersect with the feasibility-legal set (prior may rank
                // champs that fail feasibility — `legal_moves` already pruned
                // those; we keep only priored moves that are also legal).
                let legal_set: std::collections::HashSet<&MoveId> = full_legal.iter().collect();
                let mut intersected: Vec<MoveId> = priored
                    .into_iter()
                    .filter(|mv| legal_set.contains(mv))
                    .collect();
                if intersected.is_empty() {
                    // Defensive: fall back to full legal moves if intersection
                    // collapses (e.g. impossible feasibility/prior interaction).
                    intersected = full_legal.clone();
                }
                full_legal = intersected;
            }
        }
        root_node.untried = full_legal;
        let tree = Tree::new(root_node);
        let active_root = tree.root();
        Self {
            fixture,
            cache,
            cfg,
            rng,
            ctx,
            active_root,
            active_root_state: root_state,
            inherited_visits_at_reroot: 0,
            history: Vec::new(),
            tree,
        }
    }

    pub fn iterate(&mut self) {
        // 1. Selection: descend via UCT until a node with untried moves OR terminal.
        let (path, mut state, mut leaf) = self.select();

        // 2. Expansion: if not terminal, pop one untried move and create a child.
        if !state.is_complete() {
            let untried = self.tree.get(leaf).untried.clone();
            if !untried.is_empty() {
                let pick_idx = self.rng.gen_range(untried.len());
                let mv = untried[pick_idx].clone();
                self.tree.get_mut(leaf).untried.remove(pick_idx);
                apply_move(&mut state, &mv);
                let child_id = self.tree.add_child(leaf, mv, side_to_move(&state));
                let untried_for_child = legal_moves(
                    &state,
                    self.fixture,
                    &self.cache,
                    self.cfg.feasibility_mode,
                    &self.ctx,
                );
                self.tree.get_mut(child_id).untried = untried_for_child;
                leaf = child_id;
            }
        }

        // 3. Simulation: rollout to terminal.
        play_to_terminal(
            &mut state,
            self.fixture,
            &self.cache,
            self.cfg.policy,
            self.cfg.feasibility_mode,
            &mut self.rng,
        );
        let value = terminal_eval(&state, self.fixture);

        // 4. Backprop: walk parent links, accumulate vector value.
        let mut path_with_leaf = path;
        path_with_leaf.push(leaf);
        for node_id in path_with_leaf.into_iter().rev() {
            let node = self.tree.get_mut(node_id);
            node.visits += 1;
            node.value_sum.add_assign(value);
        }
    }

    /// (visited_path_excluding_leaf, projected_state_at_leaf, leaf_id)
    fn select(&mut self) -> (Vec<NodeId>, DraftState, NodeId) {
        let mut path = Vec::new();
        let mut current = self.active_root;
        let mut state = self.active_root_state.clone();

        loop {
            let node = self.tree.get(current);
            // Stop at a node with untried moves or no children (or terminal).
            if !node.untried.is_empty() || node.children.is_empty() || state.is_complete() {
                return (path, state, current);
            }
            // UCT-pick a child.
            path.push(current);
            let parent_visits = node.visits.max(1) as f64;
            let maximize = match node.side_to_move {
                Some(Side::Blue) => true,
                Some(Side::Red) => false,
                None => true, // terminal — shouldn't happen here, defensive
            };
            let mut best_idx = 0usize;
            let mut best_score = f64::NEG_INFINITY;
            for (i, (_, child_id)) in node.children.iter().enumerate() {
                let child = self.tree.get(*child_id);
                let visits = child.visits.max(1) as f64;
                let mean_winrate = child.value_sum.winrate / visits;
                let mean_coverage = child.value_sum.coverage / visits;
                let mean_flex = child.value_sum.flex / visits;
                let mean_composite =
                    mean_winrate + mean_coverage + self.cfg.flex_weight * mean_flex;
                let oriented = if maximize { mean_composite } else { -mean_composite };
                let exploration = UCT_C * (parent_visits.ln() / visits).sqrt();
                let score = oriented + exploration;
                if score > best_score {
                    best_score = score;
                    best_idx = i;
                }
            }
            let (mv, child_id) = node.children[best_idx].clone();
            apply_move(&mut state, &mv);
            current = child_id;
        }
    }

    /// (move, visits, mean_value_vector), sorted by visits desc.
    pub fn root_visit_distribution(&self) -> Vec<(MoveId, u32, ValueVector)> {
        let root = self.tree.get(self.active_root);
        let mut out: Vec<(MoveId, u32, ValueVector)> = root
            .children
            .iter()
            .map(|(mv, id)| {
                let n = self.tree.get(*id);
                let mean = if n.visits == 0 {
                    ValueVector::zero()
                } else {
                    n.value_sum.mean(n.visits)
                };
                (mv.clone(), n.visits, mean)
            })
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1));
        out
    }

    pub fn total_iterations(&self) -> u32 {
        self.tree.get(self.active_root).visits
    }

    /// Promote a child of the current active root to be the new active root.
    /// For pair moves the child is matched by full canonical MoveId equality
    /// (champion_ids in canonical order + is_pick) — partial-pair reroot is
    /// out of scope (deferred to v5).
    pub fn reroot_to(&mut self, mv: &MoveId) -> Result<(), &'static str> {
        let root = self.tree.get(self.active_root);
        let child = root
            .children
            .iter()
            .find(|(m, _)| m == mv)
            .map(|(_, id)| *id);
        let Some(child_id) = child else {
            return Err("move not found among active root's children");
        };
        let prev_state = self.active_root_state.clone();
        let prev_active = self.active_root;
        let prev_inherited = self.inherited_visits_at_reroot;
        self.history
            .push((prev_active, prev_state.clone(), prev_inherited));

        let mut new_state = prev_state;
        apply_move(&mut new_state, mv);
        self.active_root = child_id;
        self.active_root_state = new_state;
        self.inherited_visits_at_reroot = self.tree.get(child_id).visits;
        Ok(())
    }

    /// Walk back to the previous active root. Errors if we're already at the
    /// original root (no history to pop).
    pub fn uproot(&mut self) -> Result<(), &'static str> {
        let Some((prev_active, prev_state, prev_inherited)) = self.history.pop() else {
            return Err("already at original root — no uproot frame to pop");
        };
        self.active_root = prev_active;
        self.active_root_state = prev_state;
        self.inherited_visits_at_reroot = prev_inherited;
        Ok(())
    }

    /// Snapshot of the new active_root's visit count at the moment of the
    /// most recent reroot (i.e. iterations carried over from the parent's
    /// prior search). Reset to 0 at construction.
    pub fn inherited_visits_at_reroot(&self) -> u32 {
        self.inherited_visits_at_reroot
    }

    /// Number of root-level untried-or-explored moves. Equals
    /// `cfg.root_shortlist_k` when shortlisting was applied, else the full
    /// feasibility-filtered count seeded at construction. After iterations
    /// have run, `untried` shrinks as moves expand into children — this sum
    /// gives the total breadth seeded at the root.
    pub fn root_shortlist_size(&self) -> usize {
        let root = self.tree.get(self.active_root);
        root.children.len() + root.untried.len()
    }
}

/// Apply a move to `state`. Singleton: push 1 champion at the current turn.
/// Pair: push BOTH champions to the same side, advancing 2 slots. Pair turns
/// are always picks and always same-side (slots 7-8, 9-10, 17-18 in
/// TURN_SEQUENCE), so pushing both to `turn.side` is correct.
pub(crate) fn apply_move(state: &mut DraftState, mv: &MoveId) {
    let Some(turn) = state.current_turn() else {
        return;
    };
    for c in &mv.champion_ids {
        match (turn.side, mv.is_pick) {
            (Side::Blue, true) => state.blue_picks.push(c.clone()),
            (Side::Red, true) => state.red_picks.push(c.clone()),
            (Side::Blue, false) => state.blue_bans.push(c.clone()),
            (Side::Red, false) => state.red_bans.push(c.clone()),
        }
    }
}

/// Legal moves at this turn. Singleton (most turns): one MoveId per legal
/// champion, feasibility-filtered for picks. Pair_start (slots 7, 9, 17):
/// pair candidates via `enumerate_pair_candidates` — already feasibility-
/// filtered there.
fn legal_moves(
    state: &DraftState,
    fixture: &SpikeFixture,
    cache: &FeasibilityCache,
    fmode: FeasibilityMode,
    ctx: &EvalContext,
) -> Vec<MoveId> {
    let Some(turn) = state.current_turn() else {
        return Vec::new();
    };

    if turn.action_type == ActionType::Pick && turn.pair_start {
        let sub_ctx = ctx.for_perspective(turn.side, state, turn.phase);
        let pairs = enumerate_pair_candidates(
            state,
            fixture,
            &sub_ctx,
            turn.action_type,
            turn.side,
            turn.phase,
        );
        return pairs
            .into_iter()
            .map(|(first, second, _)| MoveId::pair(first, second))
            .collect();
    }

    let is_pick = turn.action_type == ActionType::Pick;
    // Picking-side pool: candidate enumeration must scope to it (v5 phase 1).
    // Bans use the same pool as picks — production's `collect_candidates`
    // does the same; ban targeting from outside one's own pool isn't a
    // concept the spike supports today.
    let sub_ctx = ctx.for_perspective(turn.side, state, turn.phase);
    let pool_search: &[String] = &sub_ctx.our_pool.search;
    let mut out: Vec<MoveId> = pool_search
        .iter()
        .filter(|c| !is_taken(c, state))
        .map(|c| MoveId::single(c.clone(), is_pick))
        .collect();
    if !is_pick {
        return out;
    }
    let locked: Vec<String> = match turn.side {
        Side::Blue => state.blue_picks.clone(),
        Side::Red => state.red_picks.clone(),
    };
    let remaining_after = picks_remaining(state, turn.side).saturating_sub(1);
    out.retain(|mv| {
        let cand = mv.first();
        let mut hypo_locked = locked.clone();
        hypo_locked.push(cand.to_string());
        // Feasibility pool: champs the picking side can fill remaining roles
        // with. Scoped to picking-side pool, minus already-taken and the
        // hypothetical pick itself.
        let pool: Vec<String> = pool_search
            .iter()
            .filter(|c| !is_taken(c, state) && c.as_str() != cand)
            .cloned()
            .collect();
        match fmode {
            FeasibilityMode::Uncached => crate::feasibility::can_complete_roles(
                &hypo_locked,
                &pool,
                remaining_after,
                &fixture.meta,
            ),
            FeasibilityMode::Cached => {
                cache.can_complete_roles_cached(&hypo_locked, &pool, remaining_after)
            }
        }
    });
    out
}
