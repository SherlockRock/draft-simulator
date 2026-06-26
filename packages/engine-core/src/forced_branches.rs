#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForcedMode {
    Sole,
    Include,
}

#[derive(Clone, Debug)]
pub struct PathStep {
    pub slot: usize,
    pub champion_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ForcedBranch {
    pub path: Vec<PathStep>,
    pub target_slot: usize,
    pub champion_id: String,
    pub mode: ForcedMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathMatch {
    Resolved { depth: usize },
    Unresolved,
}

/// Resolves a content-addressed parent-lineage path against the search's actual
/// traversal so far. Path entries match by slot + championIds (order-independent
/// for pair entries). Returns Resolved when the path is a prefix of the lineage,
/// Unresolved otherwise — the caller drops the forced branch silently in that
/// case (and increments forcedBranchesDropped).
pub fn resolve_path(path: &[PathStep], actual_lineage: &[(usize, Vec<String>)]) -> PathMatch {
    if path.is_empty() {
        return PathMatch::Resolved { depth: 0 };
    }
    if path.len() > actual_lineage.len() {
        return PathMatch::Unresolved;
    }
    for (i, step) in path.iter().enumerate() {
        let actual = &actual_lineage[i];
        if actual.0 != step.slot {
            return PathMatch::Unresolved;
        }
        let mut a = actual.1.clone();
        let mut b = step.champion_ids.clone();
        a.sort();
        b.sort();
        if a != b {
            return PathMatch::Unresolved;
        }
    }
    PathMatch::Resolved { depth: path.len() }
}
