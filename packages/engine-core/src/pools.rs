use crate::role_solver::ChampionMeta;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Role {
    Top,
    Jungle,
    Middle,
    Adc,
    Support,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RolePoolMap {
    pub top: Vec<String>,
    pub jungle: Vec<String>,
    pub middle: Vec<String>,
    pub adc: Vec<String>,
    pub support: Vec<String>,
}

impl RolePoolMap {
    pub fn for_role(&self, role: Role) -> &Vec<String> {
        match role {
            Role::Top => &self.top,
            Role::Jungle => &self.jungle,
            Role::Middle => &self.middle,
            Role::Adc => &self.adc,
            Role::Support => &self.support,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TeamPool {
    pub display: RolePoolMap,
    pub search: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Penalties {
    pub out_of_role: f64,
    pub out_of_pool: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolTier {
    InPoolInRole,
    InPoolOutOfRole,
    OutOfPool,
}

/// Returns (score multiplier, tier) for pick-phase scoring.
pub fn pool_multiplier(
    champion_id: &str,
    role: Role,
    pool: &TeamPool,
    penalties: &Penalties,
) -> (f64, PoolTier) {
    if pool.display.for_role(role).iter().any(|c| c == champion_id) {
        (1.0, PoolTier::InPoolInRole)
    } else if pool.search.iter().any(|c| c == champion_id) {
        (1.0 - penalties.out_of_role, PoolTier::InPoolOutOfRole)
    } else {
        (1.0 - penalties.out_of_pool, PoolTier::OutOfPool)
    }
}

/// The first display bucket, in `Role` order, `pool` files `champion_id` under; `None` when no
/// bucket holds it. Any bucket will do: the role the search hands `score_pick` reaches nothing but
/// [`pool_multiplier`], where every bucket the champion sits in is `InPoolInRole`.
pub fn bucket_role(champion_id: &str, pool: &TeamPool) -> Option<Role> {
    [
        Role::Top,
        Role::Jungle,
        Role::Middle,
        Role::Adc,
        Role::Support,
    ]
    .into_iter()
    .find(|role| {
        pool.display
            .for_role(*role)
            .iter()
            .any(|c| c == champion_id)
    })
}

/// The role the search scores `champion_id` at (champion-role-shares design § 6): the bucket the
/// mover's pool files it under, else its first listed position — the writer's argmax, a category
/// only here, where it covers a pick outside the pool and a side with an empty pool (the session
/// default) — else `None` for the caller's own default. Before slice B every site read
/// `positions[0]`, so a champion filed under a bucket that was not its primary (Vayne under ADC on
/// a patch that lists TOP first) was scored `InPoolOutOfRole` at ×0.75 by the pool the user wrote.
pub fn scored_role(
    champion_id: &str,
    pool: &TeamPool,
    meta: &HashMap<String, ChampionMeta>,
) -> Option<Role> {
    bucket_role(champion_id, pool).or_else(|| {
        meta.get(champion_id)
            .and_then(|m| m.positions.first().copied())
    })
}

/// Bans don't use pool penalties — ban scoring is opponent-strategy-space-reduction.
pub fn ban_multiplier(_champion_id: &str, _pool: &TeamPool, _penalties: &Penalties) -> f64 {
    1.0
}
