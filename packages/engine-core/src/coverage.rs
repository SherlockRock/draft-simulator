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

/// Geometric mean (5th root) of the product of per-role max factors.
/// Always in `[0.01, 1.0]`. 1.0 = every role primary-covered. Used as
/// the magnitude-friendly form of role coverage; preserves ordering of
/// raw product but stays at composite scale.
pub fn coverage_score(
    picks: &[String],
    meta: &HashMap<String, ChampionMeta>,
) -> f64 {
    let factors = per_role_max_factors(picks, meta);
    let product: f64 = factors.iter().product();
    product.powf(1.0 / 5.0)
}

/// Returns the gain in `coverage_score` from adding `candidate` to
/// `picks`. The `.max(0.0)` clamp is defensive against floating-point
/// imprecision (the underlying math is monotone non-decreasing — adding
/// a pick can only raise per-role maxes — so the true value is always
/// `>= 0`, but f64 ops can produce tiny negatives like `-1e-17`).
///
/// Used as the pick-side / ban-side coverage signal. For picks the
/// caller passes our team's picks; for bans the caller passes
/// opponent's picks — see `evaluator::role_coverage_for`.
pub fn coverage_marginal_gain(
    picks: &[String],
    candidate: &str,
    meta: &HashMap<String, ChampionMeta>,
) -> f64 {
    let base = coverage_score(picks, meta);
    let mut with = picks.to_vec();
    with.push(candidate.to_string());
    let post = coverage_score(&with, meta);
    (post - base).max(0.0)
}
