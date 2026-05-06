//! Mask-cached feasibility check. Mirrors engine_core::feasibility but
//! precomputes per-champion role masks once instead of recomputing per call.
//! Same threshold (0.4 against position_factor) as production.

use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

use super::role_mask_for;

type RoleMask = u8;

#[derive(Clone, Debug)]
pub struct FeasibilityCache {
    masks: HashMap<String, RoleMask>,
}

impl FeasibilityCache {
    pub fn build(meta: &HashMap<String, ChampionMeta>) -> Self {
        let mut masks = HashMap::with_capacity(meta.len());
        for id in meta.keys() {
            masks.insert(id.clone(), role_mask_for(id, meta));
        }
        Self { masks }
    }

    pub fn mask(&self, champion: &str) -> RoleMask {
        self.masks.get(champion).copied().unwrap_or(0)
    }

    /// True iff (locked + some pool subset of size remaining_picks) → 5 roles
    /// has a perfect matching, given the cached masks.
    pub fn can_complete_roles_cached(
        &self,
        locked: &[String],
        pool: &[String],
        remaining_picks: usize,
    ) -> bool {
        if pool.len() < remaining_picks {
            return false;
        }
        let total_needed = locked.len() + remaining_picks;
        if total_needed != 5 {
            return true;
        }

        let locked_masks: Vec<RoleMask> = locked.iter().map(|c| self.mask(c)).collect();
        if max_bipartite_matching(&locked_masks) != locked.len() {
            return false;
        }

        let mut all_masks = locked_masks;
        all_masks.extend(pool.iter().map(|c| self.mask(c)));
        max_bipartite_matching(&all_masks) >= 5
    }
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
                if try_augment(
                    other_champ_idx,
                    other_mask,
                    champion_masks,
                    role_to_champ,
                    visited,
                ) {
                    role_to_champ[role_idx] = Some(champ_idx);
                    return true;
                }
            }
        }
    }
    false
}
