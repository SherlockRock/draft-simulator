//! Arena-allocated tree. Node ids are indices into Tree::nodes — keeps the
//! borrow checker out of our way during recursive descent.

use crate::draft_state::Side;
use super::ValueVector;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeId(pub u32);

/// A move at one MCTS turn. `champion_ids` carries 1 element for singleton
/// moves (bans + non-pair-start picks) and 2 elements for pair-pick moves
/// (both halves of the pair, in canonical alphabetical order, both pushed
/// to the same side). Mirrors production `TreeNode::champion_ids`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MoveId {
    pub champion_ids: Vec<String>,
    pub is_pick: bool, // false => ban
}

impl MoveId {
    pub fn single(champion: impl Into<String>, is_pick: bool) -> Self {
        Self { champion_ids: vec![champion.into()], is_pick }
    }

    /// Build a pair move in canonical alphabetical order. Both halves are
    /// pushed to the same side at apply time.
    pub fn pair(a: impl Into<String>, b: impl Into<String>) -> Self {
        let a = a.into();
        let b = b.into();
        let champion_ids = if a <= b { vec![a, b] } else { vec![b, a] };
        Self { champion_ids, is_pick: true }
    }

    pub fn is_pair(&self) -> bool {
        self.champion_ids.len() == 2
    }

    /// First champion in the move. Always present — `champion_ids` is never empty.
    pub fn first(&self) -> &str {
        self.champion_ids.first().expect("MoveId has no champions").as_str()
    }

    /// `P:Garen` or `B:Darius` for singletons; `P:Garen+Sett` for pairs.
    pub fn label(&self) -> String {
        let prefix = if self.is_pick { "P" } else { "B" };
        format!("{}:{}", prefix, self.champion_ids.join("+"))
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub parent: Option<NodeId>,
    pub move_from_parent: Option<MoveId>,
    pub children: Vec<(MoveId, NodeId)>,
    pub untried: Vec<MoveId>,
    pub visits: u32,
    /// Sum of terminal `ValueVector` evaluations propagated through this
    /// node. Each dim is `blue - red`; UCT and Pareto extraction divide by
    /// `visits` to get means.
    pub value_sum: ValueVector,
    pub side_to_move: Option<Side>,
}

#[derive(Clone, Debug, Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
}

impl Tree {
    pub fn new(root: Node) -> Self {
        Self { nodes: vec![root] }
    }

    pub fn root(&self) -> NodeId {
        NodeId(0)
    }

    pub fn get(&self, id: NodeId) -> &Node {
        &self.nodes[id.0 as usize]
    }

    pub fn get_mut(&mut self, id: NodeId) -> &mut Node {
        &mut self.nodes[id.0 as usize]
    }

    pub fn add_child(&mut self, parent: NodeId, mv: MoveId, side_to_move: Option<Side>) -> NodeId {
        let new_id = NodeId(self.nodes.len() as u32);
        self.nodes.push(Node {
            parent: Some(parent),
            move_from_parent: Some(mv.clone()),
            children: Vec::new(),
            untried: Vec::new(),
            visits: 0,
            value_sum: ValueVector::zero(),
            side_to_move,
        });
        self.get_mut(parent).children.push((mv, new_id));
        new_id
    }
}
