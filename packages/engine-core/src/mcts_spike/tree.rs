//! Arena-allocated tree. Node ids are indices into Tree::nodes — keeps the
//! borrow checker out of our way during recursive descent.

use crate::draft_state::Side;
use super::ValueVector;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeId(pub u32);

/// One move = one (champion_id, action_kind) for the spike. Pair picks are
/// out of scope; the rollout treats each turn slot independently.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MoveId {
    pub champion: String,
    pub is_pick: bool, // false => ban
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
