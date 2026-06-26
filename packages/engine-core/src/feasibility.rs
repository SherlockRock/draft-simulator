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
