//! Hard feasibility prune for the navigator search. Answers:
//! "Can this side complete a 5-role comp given the locked picks and
//! remaining champion pool?" Uses a true bipartite matching across
//! (locked picks ∪ remaining pool) → 5 roles, so locked flex picks
//! correctly count as occupying one role, not multiple.

use crate::pools::Role;
use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

/// Bit `i` of a [`RoleMask`] is `ROLES[i]`.
pub(crate) const ROLES: [Role; 5] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Adc,
    Role::Support,
];

/// The roles a champion can fill, one bit per entry of [`ROLES`].
pub(crate) type RoleMask = u8;

/// The meta's mask for `champion`: its `playable` set — the listed roles plus every role above the
/// refresh's pick-count floor (champion-role-shares design § 4.1, § 5.1) — or the positions when the
/// meta carries no `playable` (`ChampionMeta::playable_roles`); 0 for a champion the meta does not
/// know. Legality is this set, not a weight: the solver's factors and the coverage score read the
/// positions and the shares, never this mask.
pub(crate) fn champion_role_mask(champion: &str, meta: &HashMap<String, ChampionMeta>) -> RoleMask {
    let Some(m) = meta.get(champion) else {
        return 0;
    };
    roles_mask(m.playable_roles())
}

/// The mask of `roles`: one bit per entry of [`ROLES`] that the list names.
pub(crate) fn roles_mask(roles: &[Role]) -> RoleMask {
    ROLES
        .iter()
        .enumerate()
        .filter(|(_, role)| roles.contains(role))
        .fold(0, |mask, (idx, _)| mask | (1 << idx))
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
    max_matching_masks(&masks)
}

/// `max_role_matching` on masks the caller already holds: one mask per champion, in the caller's
/// order. The reference module's role-tagged pools read it with per-side masks (the meta's roles plus
/// the roles the side's own pool lists — design `engine-role-aware-pools-design.md` § 2).
pub(crate) fn max_matching_masks(masks: &[RoleMask]) -> usize {
    max_bipartite_matching(masks)
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

/// `can_complete_roles` for a caller that already holds the masks (one per champion, in the caller's
/// order): the same decision sequence — too few candidates, a comp that is not five, locked picks that
/// cannot be matched, then the combined matching — written beside the incumbent's function, which is
/// left exactly as it was (it builds its masks lazily, after the cheap exits, and the incumbent search
/// calls it on its hot path). `the_mask_predicate_is_the_string_predicate` keeps the two in step.
pub(crate) fn can_complete_masks(
    locked_masks: &[RoleMask],
    pool_masks: &[RoleMask],
    remaining_picks: usize,
) -> bool {
    if pool_masks.len() < remaining_picks {
        return false;
    }
    if locked_masks.len() + remaining_picks != 5 {
        return true;
    }
    if max_bipartite_matching(locked_masks) != locked_masks.len() {
        return false;
    }
    let mut all_masks = locked_masks.to_vec();
    all_masks.extend_from_slice(pool_masks);
    max_bipartite_matching(&all_masks) >= 5
}

#[cfg(test)]
mod tests {
    use super::{
        can_complete_masks, can_complete_roles, champion_role_mask, max_assignment,
        max_bipartite_matching, RoleMask, ROLES,
    };
    use crate::role_solver::ChampionMeta;
    use std::collections::HashMap;

    /// Role-aware pools design § 2: `can_complete_masks` is `can_complete_roles` on masks. One champion
    /// per non-empty role mask (`m1` … `m31`, its positions the mask's roles) plus one the meta does not
    /// know; 20 000 draws of locked picks (0–5), candidates (0–6) and picks to come (0–5) — every exit of
    /// the predicate, the comps that are not five included — give the same answer through both.
    #[test]
    fn the_mask_predicate_is_the_string_predicate() {
        let meta: HashMap<String, ChampionMeta> = (1u8..32)
            .map(|mask| {
                let id = format!("m{mask}");
                let positions = ROLES
                    .iter()
                    .enumerate()
                    .filter(|(bit, _)| mask >> bit & 1 == 1)
                    .map(|(_, role)| *role)
                    .collect();
                (
                    id.clone(),
                    ChampionMeta {
                        id,
                        positions,
                        ..Default::default()
                    },
                )
            })
            .collect();
        assert_eq!(champion_role_mask("m21", &meta), 21);
        assert_eq!(champion_role_mask("nobody", &meta), 0);
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut next = |bound: u64| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) % bound
        };
        let (mut yes, mut no, mut not_five) = (0, 0, 0);
        for _ in 0..20_000 {
            let name = |next: &mut dyn FnMut(u64) -> u64| match next(33) {
                0 => "nobody".to_string(),
                mask => format!("m{}", mask.min(31)),
            };
            let (locked_len, pool_len) = (next(6), next(7));
            let locked: Vec<String> = (0..locked_len).map(|_| name(&mut next)).collect();
            let pool: Vec<String> = (0..pool_len).map(|_| name(&mut next)).collect();
            // Mostly the count that makes a comp of five; sometimes any other.
            let remaining = if next(4) == 0 {
                usize::try_from(next(6)).unwrap_or(0)
            } else {
                5usize.saturating_sub(locked.len())
            };
            let masks = |names: &[String]| -> Vec<RoleMask> {
                names.iter().map(|c| champion_role_mask(c, &meta)).collect()
            };
            let by_names = can_complete_roles(&locked, &pool, remaining, &meta);
            assert_eq!(
                can_complete_masks(&masks(&locked), &masks(&pool), remaining),
                by_names,
                "{locked:?} {pool:?} {remaining}"
            );
            yes += u32::from(by_names);
            no += u32::from(!by_names);
            not_five += u32::from(locked.len() + remaining != 5);
        }
        assert!(
            yes > 2_000 && no > 2_000 && not_five > 2_000,
            "{yes} {no} {not_five}"
        );
    }

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
