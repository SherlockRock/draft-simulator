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

/// Enumerates the P(5, n) ordered selections of role-indices for n champions
/// (1..=5), scores each by product of per-slot position factors, normalizes
/// weights to sum to 1.
///
/// Panics if any `champion_ids` entry is absent from `meta` — caller MUST
/// guard with `meta.contains_key` before calling. Currently this is enforced
/// by `extract_scenarios` and `flex_retention_for`.
pub fn solve(champion_ids: &[&str], meta: &HashMap<String, ChampionMeta>) -> Vec<WeightedAssignment> {
    if champion_ids.is_empty() || champion_ids.len() > 5 {
        return Vec::new();
    }
    let n = champion_ids.len();
    let champs: Vec<&ChampionMeta> = champion_ids
        .iter()
        .map(|id| meta.get(*id).expect("unknown champion id"))
        .collect();

    let role_perms = permutations_of_5_choose_n(n);

    let mut weighted = Vec::with_capacity(role_perms.len());
    for role_perm in &role_perms {
        let mut weight = 1.0;
        for (champ_idx, &role_idx) in role_perm.iter().enumerate() {
            let role = ROLES[role_idx];
            weight *= position_factor(role, &champs[champ_idx].positions);
        }
        let mut assignment = RoleAssignment {
            top: String::new(),
            jungle: String::new(),
            middle: String::new(),
            adc: String::new(),
            support: String::new(),
        };
        for (champ_idx, &role_idx) in role_perm.iter().enumerate() {
            let champ_id = champion_ids[champ_idx].to_string();
            match ROLES[role_idx] {
                Role::Top => assignment.top = champ_id,
                Role::Jungle => assignment.jungle = champ_id,
                Role::Middle => assignment.middle = champ_id,
                Role::Adc => assignment.adc = champ_id,
                Role::Support => assignment.support = champ_id,
            }
        }
        weighted.push(WeightedAssignment { assignment, weight });
    }

    let total: f64 = weighted.iter().map(|w| w.weight).sum();
    if total > 0.0 {
        for w in &mut weighted {
            w.weight /= total;
        }
    }
    weighted
}

fn permutations_of_5_choose_n(n: usize) -> Vec<Vec<usize>> {
    let role_indices: Vec<usize> = (0..5).collect();
    let mut results = Vec::new();
    permute_choose(&role_indices, n, &mut Vec::new(), &mut results);
    results
}

fn permute_choose(items: &[usize], k: usize, current: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
    if k == 0 {
        out.push(current.clone());
        return;
    }
    for (i, &item) in items.iter().enumerate() {
        let mut rest: Vec<usize> = items.to_vec();
        rest.remove(i);
        current.push(item);
        permute_choose(&rest, k - 1, current, out);
        current.pop();
    }
}
