//! UCT selection + the public Mcts entry point.

use crate::draft_state::{is_taken, picks_remaining, ActionType, DraftState, Side};

use super::feasibility_cache::FeasibilityCache;
use super::rng::SplitMix64;
use super::rollout::{play_to_terminal, FeasibilityMode, RolloutPolicy};
use super::tree::{MoveId, Node, NodeId, Tree};
use super::{side_to_move, terminal_eval, SpikeFixture, ValueVector};

const UCT_C: f64 = std::f64::consts::SQRT_2;

#[derive(Clone, Debug)]
pub struct McTsConfig {
    pub policy: RolloutPolicy,
    pub feasibility_mode: FeasibilityMode,
    pub seed: u64,
}

pub struct Mcts<'a> {
    fixture: &'a SpikeFixture,
    cache: FeasibilityCache,
    cfg: McTsConfig,
    rng: SplitMix64,
    /// The original root state. Kept for diagnostics / re-derivation; not
    /// used in the hot path after `active_root` was introduced.
    original_root_state: DraftState,
    /// Logical root for the current iteration. Reroot moves this down to a
    /// child; uproot moves it back up. Tree storage is unchanged.
    active_root: NodeId,
    /// Projected state at `active_root`. Cloned per iteration in `select`.
    active_root_state: DraftState,
    /// Snapshot of `active_root.visits` taken the moment we last rerooted.
    /// Surfaced into the trajectory CSV as `inherited_visits`.
    inherited_visits_at_reroot: u32,
    /// Stack of (active_root, state, inherited_visits_snapshot) frames
    /// pushed at each reroot. `uproot()` pops to walk back up.
    history: Vec<(NodeId, DraftState, u32)>,
    tree: Tree,
}

impl<'a> Mcts<'a> {
    pub fn new(fixture: &'a SpikeFixture, root_state: DraftState, cfg: McTsConfig) -> Self {
        let cache = FeasibilityCache::build(&fixture.meta);
        let rng = SplitMix64::new(cfg.seed);
        let mut root_node = Node {
            parent: None,
            move_from_parent: None,
            children: Vec::new(),
            untried: Vec::new(),
            visits: 0,
            value_sum: ValueVector::zero(),
            side_to_move: side_to_move(&root_state),
        };
        root_node.untried = legal_moves(&root_state, fixture, &cache, cfg.feasibility_mode);
        let tree = Tree::new(root_node);
        let active_root = tree.root();
        Self {
            fixture,
            cache,
            cfg,
            rng,
            original_root_state: root_state.clone(),
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
                let untried_for_child =
                    legal_moves(&state, self.fixture, &self.cache, self.cfg.feasibility_mode);
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
                let mean_composite = child.value_sum.composite() / visits;
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
}

fn apply_move(state: &mut DraftState, mv: &MoveId) {
    let Some(turn) = state.current_turn() else {
        return;
    };
    match (turn.side, mv.is_pick) {
        (Side::Blue, true) => state.blue_picks.push(mv.champion.clone()),
        (Side::Red, true) => state.red_picks.push(mv.champion.clone()),
        (Side::Blue, false) => state.blue_bans.push(mv.champion.clone()),
        (Side::Red, false) => state.red_bans.push(mv.champion.clone()),
    }
}

fn legal_moves(
    state: &DraftState,
    fixture: &SpikeFixture,
    cache: &FeasibilityCache,
    fmode: FeasibilityMode,
) -> Vec<MoveId> {
    let Some(turn) = state.current_turn() else {
        return Vec::new();
    };
    let is_pick = turn.action_type == ActionType::Pick;
    let mut out: Vec<MoveId> = fixture
        .all_champions
        .iter()
        .filter(|c| !is_taken(c, state))
        .map(|c| MoveId {
            champion: c.clone(),
            is_pick,
        })
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
        let mut hypo_locked = locked.clone();
        hypo_locked.push(mv.champion.clone());
        let pool: Vec<String> = fixture
            .all_champions
            .iter()
            .filter(|c| !is_taken(c, state) && *c != &mv.champion)
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
