use crate::pools::Role;
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct DamageProfile {
    pub physical: f64,
    pub magic: f64,
    pub r#true: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ScalingProfile {
    pub early: f64,
    pub mid: f64,
    pub late: f64,
}

#[derive(Clone, Debug, Default)]
pub struct CcProfile {
    pub has_cc: bool,
    pub cc_types: Vec<String>,
    pub engage_quality: f64,
    pub peel_quality: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ChampionTags {
    pub archetype: Vec<String>,
    pub synergy: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ChampionMeta {
    pub id: String,
    pub positions: Vec<Role>,
    pub damage_profile: DamageProfile,
    pub scaling_profile: ScalingProfile,
    pub cc_profile: CcProfile,
    pub tags: ChampionTags,
}

#[derive(Clone, Debug)]
pub struct RoleAssignment {
    pub top: String,
    pub jungle: String,
    pub middle: String,
    pub adc: String,
    pub support: String,
}

#[derive(Clone, Debug)]
pub struct WeightedAssignment {
    pub assignment: RoleAssignment,
    pub weight: f64,
}

const PRIMARY_FACTOR: f64 = 1.0;
const SECONDARY_FACTOR: f64 = 0.4;
const NON_LISTED_FACTOR: f64 = 0.01;

pub fn position_factor(role: Role, positions: &[Role]) -> f64 {
    if positions.first().copied() == Some(role) {
        PRIMARY_FACTOR
    } else if positions.contains(&role) {
        SECONDARY_FACTOR
    } else {
        NON_LISTED_FACTOR
    }
}

const ROLES: [Role; 5] = [Role::Top, Role::Jungle, Role::Middle, Role::Adc, Role::Support];

/// Enumerates the 5! = 120 permutations of champion → role, scores each by
/// product of per-slot position factors, normalizes weights to sum to 1.
pub fn solve(champion_ids: &[&str], meta: &HashMap<String, ChampionMeta>) -> Vec<WeightedAssignment> {
    if champion_ids.len() != 5 {
        // Partial-comp solving is supported by passing fewer; for v1 we expect 5.
        // Empty result keeps the function callable in pre-comp-resolved states.
        return Vec::new();
    }
    let champs: Vec<&ChampionMeta> = champion_ids
        .iter()
        .map(|id| meta.get(*id).expect("unknown champion id"))
        .collect();

    let mut weighted = Vec::with_capacity(120);
    permutations(&[0, 1, 2, 3, 4], &mut Vec::new(), &mut |perm| {
        let mut weight = 1.0;
        for (slot_idx, &champ_idx) in perm.iter().enumerate() {
            weight *= position_factor(ROLES[slot_idx], &champs[champ_idx].positions);
        }
        let assignment = RoleAssignment {
            top: champs[perm[0]].id.clone(),
            jungle: champs[perm[1]].id.clone(),
            middle: champs[perm[2]].id.clone(),
            adc: champs[perm[3]].id.clone(),
            support: champs[perm[4]].id.clone(),
        };
        weighted.push(WeightedAssignment { assignment, weight });
    });

    let total: f64 = weighted.iter().map(|w| w.weight).sum();
    if total > 0.0 {
        for w in &mut weighted {
            w.weight /= total;
        }
    }
    weighted
}

fn permutations<F: FnMut(&[usize])>(items: &[usize], current: &mut Vec<usize>, f: &mut F) {
    if items.is_empty() {
        f(current);
        return;
    }
    for (i, &item) in items.iter().enumerate() {
        let mut remaining = items.to_vec();
        remaining.remove(i);
        current.push(item);
        permutations(&remaining, current, f);
        current.pop();
    }
}
