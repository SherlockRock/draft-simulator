//! Hard feasibility prune for the navigator search. Answers:
//! "Can this side complete a 5-role comp given the locked picks and
//! remaining champion pool?" Uses a true bipartite matching across
//! (locked picks ∪ remaining pool) → 5 roles, so locked flex picks
//! correctly count as occupying one role, not multiple.

use crate::pools::Role;
use crate::role_solver::{position_factor, ChampionMeta};
use std::collections::HashMap;

const ROLES: [Role; 5] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Adc,
    Role::Support,
];

/// Threshold for "champion can play role" — must have at least secondary
/// fit (position_factor >= 0.4). Non-listed (0.01) does NOT count.
/// Matches the soft `missing_roles(0.4)` threshold used elsewhere.
const ROLE_PLAYABLE_THRESHOLD: f64 = 0.4;

type RoleMask = u8;

fn champion_role_mask(
    champion: &str,
    meta: &HashMap<String, ChampionMeta>,
) -> RoleMask {
    let Some(m) = meta.get(champion) else { return 0; };
    let mut mask: RoleMask = 0;
    for (idx, role) in ROLES.iter().enumerate() {
        if position_factor(*role, &m.positions) >= ROLE_PLAYABLE_THRESHOLD {
            mask |= 1 << idx;
        }
    }
    mask
}

fn max_bipartite_matching(champion_masks: &[RoleMask]) -> usize {
    let mut role_to_champ: [Option<usize>; 5] = [None; 5];
    let mut matched = 0;

    for (champ_idx, &mask) in champion_masks.iter().enumerate() {
        let mut visited = [false; 5];
        if try_augment(champ_idx, mask, champion_masks, &mut role_to_champ, &mut visited) {
            matched += 1;
        }
    }
    matched
}

/// The size of the largest role assignment among `champions` (distinct champions to distinct roles,
/// each champion in a role it can play): the rank of the set in the transversal matroid the
/// predicate below extends. `reference::feasibility::off_pool_count` reads it to price a pool that
/// cannot finish: `5 − rank(locked ∪ pool)` roles must come from outside the pool.
pub(crate) fn max_role_matching(
    champions: &[String],
    meta: &HashMap<String, ChampionMeta>,
) -> usize {
    let masks: Vec<RoleMask> = champions
        .iter()
        .map(|c| champion_role_mask(c, meta))
        .collect();
    max_bipartite_matching(&masks)
}

/// Which of `champions` one maximum role assignment matches (`true` = assigned a role), in input order:
/// the same augmenting-path pass as `max_role_matching`, so the count of `true` is exactly its size. A
/// champion left `false` is not critical — the same assignment survives its removal — which is what lets
/// `reference::feasibility::critical_pool` re-rank only the matched ones (snipe-key design, fact 2).
pub(crate) fn max_role_assignment(
    champions: &[String],
    meta: &HashMap<String, ChampionMeta>,
) -> Vec<bool> {
    let masks: Vec<RoleMask> = champions
        .iter()
        .map(|c| champion_role_mask(c, meta))
        .collect();
    max_assignment(&masks)
}

fn max_assignment(champion_masks: &[RoleMask]) -> Vec<bool> {
    let mut role_to_champ: [Option<usize>; 5] = [None; 5];
    for (champ_idx, &mask) in champion_masks.iter().enumerate() {
        let mut visited = [false; 5];
        try_augment(
            champ_idx,
            mask,
            champion_masks,
            &mut role_to_champ,
            &mut visited,
        );
    }
    let mut matched = vec![false; champion_masks.len()];
    for champ_idx in role_to_champ.into_iter().flatten() {
        matched[champ_idx] = true;
    }
    matched
}

fn try_augment(
    champ_idx: usize,
    champ_mask: RoleMask,
    champion_masks: &[RoleMask],
    role_to_champ: &mut [Option<usize>; 5],
    visited: &mut [bool; 5],
) -> bool {
    for role_idx in 0..5 {
        if (champ_mask >> role_idx) & 1 == 0 {
            continue;
        }
        if visited[role_idx] {
            continue;
        }
        visited[role_idx] = true;

        match role_to_champ[role_idx] {
            None => {
                role_to_champ[role_idx] = Some(champ_idx);
                return true;
            }
            Some(other_champ_idx) => {
                let other_mask = champion_masks[other_champ_idx];
                if try_augment(other_champ_idx, other_mask, champion_masks, role_to_champ, visited) {
                    role_to_champ[role_idx] = Some(champ_idx);
                    return true;
                }
            }
        }
    }
    false
}

/// Returns true iff there exists an assignment of (locked + some subset of
/// pool, sized to fill 5 total) → 5 distinct roles such that every assigned
/// champion can play their assigned role.
pub fn can_complete_roles(
    locked: &[String],
    pool: &[String],
    remaining_picks: usize,
    meta: &HashMap<String, ChampionMeta>,
) -> bool {
    if pool.len() < remaining_picks {
        return false;
    }
    let total_needed = locked.len() + remaining_picks;
    if total_needed != 5 {
        // Defensive: feasibility only meaningful at side-comp size 5.
        // In practice every call site satisfies locked.len() + remaining_picks == 5
        // because TURN_SEQUENCE has exactly 5 picks per side.
        return true;
    }

    let locked_masks: Vec<RoleMask> = locked.iter()
        .map(|c| champion_role_mask(c, meta))
        .collect();

    if max_bipartite_matching(&locked_masks) != locked.len() {
        return false;
    }

    // Trick: locked picks were independently verified above to form a
    // perfect matching of size |locked|. If the combined locked+pool graph
    // has maximum matching size >= 5, the matroid extension property of
    // bipartite matchings (transversal matroid extension) guarantees the
    // locked matching can be extended by some subset of pool members to
    // reach size 5.
    let mut all_masks = locked_masks;
    all_masks.extend(pool.iter().map(|c| champion_role_mask(c, meta)));

    max_bipartite_matching(&all_masks) >= 5
}

#[cfg(test)]
mod tests {
    use super::{max_assignment, max_bipartite_matching, RoleMask};

    /// Snipe-key design § 3 test 4: on every combination of up to four role masks (each of the 32
    /// masks, the empty one included) the assignment marks exactly as many champions as the maximum
    /// matching has, and the marked champions alone still match that many — they sit on distinct
    /// playable roles.
    #[test]
    fn max_assignment_marks_one_maximum_matching() {
        let mut combos: Vec<Vec<RoleMask>> = vec![Vec::new()];
        for _ in 0..4 {
            combos = combos
                .iter()
                .flat_map(|c| {
                    (0..32u8).map(move |m| {
                        let mut next = c.clone();
                        next.push(m);
                        next
                    })
                })
                .collect();
            for masks in &combos {
                let matched = max_assignment(masks);
                let size = max_bipartite_matching(masks);
                assert_eq!(matched.iter().filter(|m| **m).count(), size, "{masks:?}");
                let kept: Vec<RoleMask> = masks
                    .iter()
                    .zip(&matched)
                    .filter(|(_, m)| **m)
                    .map(|(mask, _)| *mask)
                    .collect();
                assert_eq!(max_bipartite_matching(&kept), size, "{masks:?}");
            }
        }
    }
}
