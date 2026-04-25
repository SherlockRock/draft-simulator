use serde::{Deserialize, Serialize};

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

/// Bans don't use pool penalties — ban scoring is opponent-strategy-space-reduction.
pub fn ban_multiplier(_champion_id: &str, _pool: &TeamPool, _penalties: &Penalties) -> f64 {
    1.0
}
