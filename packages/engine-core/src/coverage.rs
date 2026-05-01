use crate::pools::Role;
use crate::role_solver::{position_factor, ChampionMeta};
use std::collections::HashMap;

pub const ROLES: [Role; 5] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Adc,
    Role::Support,
];

/// Per-role maximum `position_factor` across all picks. Index order
/// matches `ROLES`: TOP, JG, MID, ADC, SUP. A pick missing from `meta`
/// contributes nothing (treated as not-listed across all roles).
pub fn per_role_max_factors(
    picks: &[String],
    meta: &HashMap<String, ChampionMeta>,
) -> [f64; 5] {
    let mut maxes = [0.01f64; 5];
    for (idx, role) in ROLES.iter().enumerate() {
        for pick in picks {
            if let Some(m) = meta.get(pick) {
                let f = position_factor(*role, &m.positions);
                if f > maxes[idx] {
                    maxes[idx] = f;
                }
            }
        }
    }
    maxes
}
